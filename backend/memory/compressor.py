"""记忆压缩器 — 合并相似记忆，重评重要性

功能：
1. 按分类分组记忆
2. 向量聚类（相似度 ≥ 0.85 归为一组）
3. LLM 合并同类记忆 + 重评 salience
4. 原子性更新 memory.json
5. 清除向量索引（确保后续搜索使用新数据）

触发方式：
- 手动调用 POST /api/memory/compress
- 前端"整理记忆"按钮
"""
import asyncio
import json
import logging
import re
import shutil
from datetime import datetime
from typing import Optional

from memory.models import MemoryEntry, VALID_CATEGORIES, CATEGORY_LABELS

logger = logging.getLogger(__name__)

# 聚类相似度阈值（0.75 可以合并语义相近但表述不同的记忆）
CLUSTER_SIMILARITY_THRESHOLD = 0.75

# 批量合并的最大并发数（避免 LLM API 过载）
MAX_MERGE_CONCURRENCY = 3


def _cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    """计算两个向量的余弦相似度"""
    import math

    if not vec_a or not vec_b or len(vec_a) != len(vec_b):
        return 0.0

    dot_product = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))

    if norm_a == 0 or norm_b == 0:
        return 0.0

    return dot_product / (norm_a * norm_b)


async def get_embedding(text: str) -> Optional[list[float]]:
    """获取文本的向量表示

    复用 LlamaIndex 的 embedding 模型配置
    """
    try:
        from llama_index.embeddings.openai import OpenAIEmbedding
        from model_pool import resolve_model

        emb_cfg = resolve_model("embedding")

        try:
            embed_model = OpenAIEmbedding(
                model=emb_cfg["model"],
                api_key=emb_cfg["api_key"],
                api_base=emb_cfg["api_base"],
            )
        except (ValueError, Exception) as e:
            if "is not a valid" in str(e):
                # 非 OpenAI 标准模型名，使用兼容模式
                embed_model = OpenAIEmbedding(
                    api_key=emb_cfg["api_key"],
                    api_base=emb_cfg["api_base"],
                )
                embed_model.__dict__["model"] = emb_cfg["model"]
            else:
                raise

        # 获取 embedding
        embedding = embed_model.get_text_embedding(text)
        return embedding

    except Exception as e:
        logger.warning(f"获取 embedding 失败: {e}")
        return None


async def _cluster_by_similarity(
    entries: list[MemoryEntry],
    threshold: float = CLUSTER_SIMILARITY_THRESHOLD,
) -> list[list[MemoryEntry]]:
    """基于向量相似度的聚类

    算法：
    1. 计算所有记忆的 embedding
    2. 计算两两相似度矩阵
    3. 合并相似度 ≥ threshold 的记忆对

    Args:
        entries: 同分类的记忆条目列表
        threshold: 相似度阈值

    Returns:
        聚类列表，每个聚类是一组相似的记忆
    """
    if not entries:
        return []

    n = len(entries)
    logger.info(f"开始聚类 {n} 条记忆，阈值: {threshold}")

    # 获取所有 embedding
    embeddings: list[Optional[list[float]]] = []
    for entry in entries:
        emb = await get_embedding(entry.content)
        if emb is None:
            logger.warning(f"记忆 [{entry.id}] 获取 embedding 失败")
        embeddings.append(emb)

    # 使用 Union-Find 进行聚类
    parent = list(range(n))

    def find(x: int) -> int:
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]

    def union(x: int, y: int) -> None:
        px, py = find(x), find(y)
        if px != py:
            parent[px] = py

    # 计算两两相似度，合并相似的记忆
    for i in range(n):
        if embeddings[i] is None:
            continue
        for j in range(i + 1, n):
            if embeddings[j] is None:
                continue
            sim = _cosine_similarity(embeddings[i], embeddings[j])
            # 记录相似度较高的比较
            if sim >= 0.6:
                logger.info(
                    f"相似度: [{entries[i].id}] vs [{entries[j].id}] = {sim:.3f} "
                    f"{'✓ 合并' if sim >= threshold else '✗ 不合并'}"
                )
            if sim >= threshold:
                union(i, j)

    # 按聚类分组
    clusters_map: dict[int, list[MemoryEntry]] = {}
    for i, entry in enumerate(entries):
        root = find(i)
        clusters_map.setdefault(root, []).append(entry)

    clusters = list(clusters_map.values())
    logger.info(f"聚类完成: {n} 条记忆 → {len(clusters)} 个聚类")

    return clusters


def _extract_json(text: str) -> str:
    """从可能包含 markdown 代码块的文本中提取 JSON"""
    match = re.search(r'```(?:json)?\s*\n?(.*?)```', text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()


async def _merge_cluster(
    cluster: list[MemoryEntry],
    category: str,
) -> MemoryEntry:
    """使用 LLM 合并一组相似记忆

    输入：同分类的多条相似记忆
    输出：合并后的单条记忆（新 ID，重评 salience）
    """
    from engine.llm_factory import create_llm

    # 构建条目文本
    entries_text = "\n".join([
        f"- [{e.id}] (重要性:{e.salience:.2f}, 访问:{e.access_count}次, 来源:{e.source}) {e.content}"
        for e in cluster
    ])

    cat_label = CATEGORY_LABELS.get(category, category)

    prompt = f"""请将以下 {len(cluster)} 条相似记忆合并为一条精简的记忆。

分类：{cat_label}

原始记忆：
{entries_text}

要求：
1. 保留所有关键信息，去除冗余和重复
2. 合并后的内容应简洁清晰，不要丢失重要细节
3. 重新评估重要性（0.0-1.0），参考原始重要性和访问次数
   - 访问次数多 → 重要性应该更高
   - 多条记忆说同一件事 → 重要性应该更高
4. 如果原始记忆互相矛盾，保留最新/最可靠的信息

返回 JSON 格式（不要包含其他内容）：
{{"content": "合并后的内容", "salience": 0.7}}
"""

    try:
        llm = create_llm(streaming=False)
        response = await llm.ainvoke(prompt)
        result = _extract_json(response.content)

        data = json.loads(result)
        merged_content = data.get("content", "")
        merged_salience = data.get("salience", 0.5)

        # 内容校验
        if not merged_content.strip():
            # LLM 返回空内容，使用第一条记忆的内容
            merged_content = cluster[0].content

        # salience 范围校验
        merged_salience = max(0.0, min(1.0, float(merged_salience)))

    except Exception as e:
        logger.warning(f"LLM 合并失败，使用第一条记忆: {e}")
        # Fallback: 保留访问次数最多/salience 最高的记忆
        best = max(cluster, key=lambda x: (x.access_count, x.salience))
        merged_content = best.content
        merged_salience = best.salience

    # 创建新的 MemoryEntry
    new_entry = MemoryEntry(
        id=MemoryEntry.generate_id(),
        category=category,
        content=merged_content,
        salience=merged_salience,
        created_at=datetime.now().isoformat(),
        last_accessed=datetime.now().isoformat(),
        access_count=sum(e.access_count for e in cluster),  # 累加访问次数
        source="compress",
        context={"merged_from": [e.id for e in cluster]},  # 追踪来源
    )

    return new_entry


async def _batch_merge_clusters(
    clusters: list[tuple[str, list[MemoryEntry]]],
    max_concurrency: int = MAX_MERGE_CONCURRENCY,
) -> list[MemoryEntry]:
    """批量合并聚类（限制并发数）

    Args:
        clusters: [(category, [entries])] 需要合并的聚类列表
        max_concurrency: 最大并发数

    Returns:
        合并后的记忆列表
    """
    semaphore = asyncio.Semaphore(max_concurrency)

    async def _merge_one(category: str, cluster: list[MemoryEntry]) -> MemoryEntry:
        async with semaphore:
            return await _merge_cluster(cluster, category)

    tasks = [_merge_one(cat, cluster) for cat, cluster in clusters]
    return list(await asyncio.gather(*tasks))


async def compress_memories() -> dict:
    """压缩长期记忆 — 主入口

    流程：
    1. 备份 memory.json
    2. 按分类分组记忆
    3. 对每个分类进行向量聚类
    4. LLM 合并相似聚类
    5. 原子写入 memory.json
    6. 清除向量索引

    Returns:
        {
            "status": "ok" | "skip",
            "before": 压缩前条目数,
            "after": 压缩后条目数,
            "merged": 被合并的条目数,
            "kept": 保留原样的条目数,
            "clusters": 合并的聚类数,
        }
    """
    from memory.manager import memory_manager
    from memory.search import invalidate_memory_index

    # 1. 备份（关键：防止数据丢失）
    backup_path = memory_manager.memory_file.with_suffix(".json.pre-compress")
    if memory_manager.memory_file.exists():
        shutil.copy2(memory_manager.memory_file, backup_path)
        logger.info(f"已备份 memory.json 到 {backup_path}")

    # 2. 加载所有记忆
    data = memory_manager._load_memory_json()
    memories = [MemoryEntry.from_dict(m) for m in data.get("memories", [])]

    if len(memories) < 2:
        return {
            "status": "skip",
            "reason": "记忆数量不足，无需压缩",
            "before": len(memories),
            "after": len(memories),
            "merged": 0,
            "kept": len(memories),
            "clusters": 0,
        }

    # 3. 按分类分组
    by_category: dict[str, list[MemoryEntry]] = {}
    for m in memories:
        by_category.setdefault(m.category, []).append(m)

    # 调试日志：显示每个分类的记忆数量和 ID
    for cat, entries in by_category.items():
        ids = [e.id for e in entries]
        logger.info(f"分类 [{cat}]: {len(entries)} 条记忆, IDs: {ids}")

    # 4. 对每个分类进行聚类 + 合并
    new_memories: list[MemoryEntry] = []
    stats = {
        "before": len(memories),
        "merged": 0,
        "kept": 0,
        "clusters": 0,
    }

    # 需要 LLM 合并的聚类列表
    clusters_to_merge: list[tuple[str, list[MemoryEntry]]] = []

    for category in VALID_CATEGORIES:
        cat_entries = by_category.get(category, [])
        if not cat_entries:
            continue

        if len(cat_entries) == 1:
            # 单条记忆，直接保留
            new_memories.append(cat_entries[0])
            stats["kept"] += 1
            continue

        # 4.1 向量聚类
        logger.info(f"正在聚类 [{category}] 分类的 {len(cat_entries)} 条记忆...")
        clusters = await _cluster_by_similarity(cat_entries, CLUSTER_SIMILARITY_THRESHOLD)

        # 4.2 分离需要合并的聚类和单条记忆
        for cluster in clusters:
            if len(cluster) == 1:
                # 单条记忆，直接保留
                new_memories.append(cluster[0])
                stats["kept"] += 1
            else:
                # 多条记忆，需要 LLM 合并
                clusters_to_merge.append((category, cluster))
                stats["merged"] += len(cluster)
                stats["clusters"] += 1

    # 5. 批量 LLM 合并
    if clusters_to_merge:
        logger.info(f"正在合并 {len(clusters_to_merge)} 个聚类...")
        merged_entries = await _batch_merge_clusters(clusters_to_merge)
        new_memories.extend(merged_entries)

    # 6. 原子写入
    with memory_manager._lock:
        data["memories"] = [m.to_dict() for m in new_memories]
        data["last_updated"] = datetime.now().isoformat()
        memory_manager._save_memory_json(data)

    # 7. 关键：清除向量索引，下次搜索时重建
    invalidate_memory_index()
    logger.info("已清除向量索引，下次搜索时将重建")

    stats["after"] = len(new_memories)
    stats["status"] = "ok"

    logger.info(
        f"记忆压缩完成: {stats['before']} → {stats['after']} 条，"
        f"合并了 {stats['merged']} 条，保留 {stats['kept']} 条"
    )

    return stats
