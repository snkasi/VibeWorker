"""记忆压缩器 — 合并相似记忆，重评重要性

功能：
1. 按分类分组记忆
2. 向量聚类（相似度 ≥ 0.75 归为一组）
3. LLM 合并同类记忆 + 重评 salience
4. 原子性更新 memory.json
5. 清除向量索引（确保后续搜索使用新数据）

后备方案：
- 当 embedding 模型不可用时，自动切换到文本相似度算法
- 使用 n-gram Jaccard 相似度（对中文友好）

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


def _text_similarity(text_a: str, text_b: str) -> float:
    """计算两段文本的相似度（后备方案，当 embedding 不可用时）

    使用多种方法的组合：
    1. 字符级 n-gram Jaccard 相似度
    2. 最长公共子序列比例
    3. 字符集重叠度

    这种方法对中文很友好，因为中文每个字符都有独立含义
    """
    if not text_a or not text_b:
        return 0.0

    # 移除空格
    text_a = text_a.replace(" ", "").replace("　", "")
    text_b = text_b.replace(" ", "").replace("　", "")

    # 1. 字符级 2-gram Jaccard 相似度
    def get_ngrams(text: str, n: int = 2) -> set:
        return {text[i:i+n] for i in range(len(text) - n + 1)} if len(text) >= n else set()

    ngrams_a_2 = get_ngrams(text_a, 2)
    ngrams_b_2 = get_ngrams(text_b, 2)
    if ngrams_a_2 and ngrams_b_2:
        intersection_2 = ngrams_a_2 & ngrams_b_2
        union_2 = ngrams_a_2 | ngrams_b_2
        jaccard_2 = len(intersection_2) / len(union_2)
    else:
        jaccard_2 = 0.0

    # 2. 字符级 3-gram Jaccard 相似度
    ngrams_a_3 = get_ngrams(text_a, 3)
    ngrams_b_3 = get_ngrams(text_b, 3)
    if ngrams_a_3 and ngrams_b_3:
        intersection_3 = ngrams_a_3 & ngrams_b_3
        union_3 = ngrams_a_3 | ngrams_b_3
        jaccard_3 = len(intersection_3) / len(union_3)
    else:
        jaccard_3 = 0.0

    # 3. 字符集重叠度（unigram）
    chars_a = set(text_a)
    chars_b = set(text_b)
    if chars_a and chars_b:
        char_overlap = len(chars_a & chars_b) / len(chars_a | chars_b)
    else:
        char_overlap = 0.0

    # 4. 长度相似度（惩罚长度差异过大的文本）
    len_a, len_b = len(text_a), len(text_b)
    len_sim = min(len_a, len_b) / max(len_a, len_b) if max(len_a, len_b) > 0 else 0.0

    # 综合得分（2-gram 0.4 + 3-gram 0.3 + 字符重叠 0.2 + 长度 0.1）
    score = 0.4 * jaccard_2 + 0.3 * jaccard_3 + 0.2 * char_overlap + 0.1 * len_sim

    return score


async def get_embedding(text: str) -> Optional[list[float]]:
    """获取文本的向量表示

    直接使用 OpenAI SDK，兼容所有 OpenAI 兼容的 API（如阿里云 DashScope）
    """
    try:
        from openai import AsyncOpenAI
        from model_pool import resolve_model

        emb_cfg = resolve_model("embedding")

        client = AsyncOpenAI(
            api_key=emb_cfg["api_key"],
            base_url=emb_cfg["api_base"],
            timeout=30,
        )

        response = await client.embeddings.create(
            model=emb_cfg["model"],
            input=text,
        )

        if response.data:
            return response.data[0].embedding
        return None

    except Exception as e:
        logger.warning(f"获取 embedding 失败: {e}")
        return None


class EmbeddingUnavailableError(Exception):
    """embedding 模型不可用异常，用于通知调用方需要降级"""
    pass


async def _cluster_by_similarity(
    entries: list[MemoryEntry],
    threshold: float = CLUSTER_SIMILARITY_THRESHOLD,
    force_text_similarity: bool = False,
) -> list[list[MemoryEntry]]:
    """基于向量相似度的聚类

    算法：
    1. 计算所有记忆的 embedding
    2. 计算两两相似度矩阵
    3. 合并相似度 ≥ threshold 的记忆对

    后备方案：
    - 当 embedding 不可用时，使用文本相似度（Jaccard + n-gram）

    Args:
        entries: 同分类的记忆条目列表
        threshold: 相似度阈值
        force_text_similarity: 强制使用文本相似度（用户确认降级后）

    Returns:
        聚类列表，每个聚类是一组相似的记忆

    Raises:
        EmbeddingUnavailableError: 首次 embedding 失败时抛出，让调用方询问用户
    """
    if not entries:
        return []

    n = len(entries)
    logger.info(f"开始聚类 {n} 条记忆，阈值: {threshold}")

    # 如果强制使用文本相似度，跳过 embedding 获取
    if force_text_similarity:
        logger.info("使用文本相似度模式（用户已确认降级）")
        embeddings = [None] * n
        use_text_fallback = True
    else:
        # 获取第一个 embedding 来检测模型是否可用
        first_emb = await get_embedding(entries[0].content)
        if first_emb is None:
            # 第一次就失败，抛出异常让调用方询问用户
            logger.warning("embedding 模型不可用，需要用户确认是否降级")
            raise EmbeddingUnavailableError("embedding 模型不可用")

        # 第一个成功，继续获取剩余的 embedding
        embeddings: list[Optional[list[float]]] = [first_emb]
        for entry in entries[1:]:
            emb = await get_embedding(entry.content)
            embeddings.append(emb)

        use_text_fallback = False

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
        for j in range(i + 1, n):
            # 计算相似度
            if use_text_fallback:
                # 后备方案：文本相似度
                sim = _text_similarity(entries[i].content, entries[j].content)
                method = "text"
            elif embeddings[i] is not None and embeddings[j] is not None:
                # 正常情况：向量相似度
                sim = _cosine_similarity(embeddings[i], embeddings[j])
                method = "vector"
            elif embeddings[i] is None or embeddings[j] is None:
                # 部分 embedding 失败，对这一对使用文本相似度
                sim = _text_similarity(entries[i].content, entries[j].content)
                method = "text-partial"
            else:
                continue

            # 记录相似度较高的比较
            if sim >= 0.5:
                logger.info(
                    f"相似度 [{method}]: [{entries[i].id}] vs [{entries[j].id}] = {sim:.3f} "
                    f"{'=> 合并' if sim >= threshold else '=> 不合并'}"
                )

            if sim >= threshold:
                union(i, j)

    # 按聚类分组
    clusters_map: dict[int, list[MemoryEntry]] = {}
    for i, entry in enumerate(entries):
        root = find(i)
        clusters_map.setdefault(root, []).append(entry)

    clusters = list(clusters_map.values())
    logger.info(f"聚类完成: {n} 条记忆 -> {len(clusters)} 个聚类")

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
) -> tuple[MemoryEntry, dict]:
    """使用 LLM 合并一组相似记忆

    输入：同分类的多条相似记忆
    输出：(合并后的记忆, 合并详情)
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

    # 构建合并详情
    merge_detail = {
        "from": [{"id": e.id, "content": e.content} for e in cluster],
        "to": {"id": new_entry.id, "content": new_entry.content},
        "category": category,
    }

    return new_entry, merge_detail


async def _batch_merge_clusters(
    clusters: list[tuple[str, list[MemoryEntry]]],
    max_concurrency: int = MAX_MERGE_CONCURRENCY,
) -> tuple[list[MemoryEntry], list[dict]]:
    """批量合并聚类（限制并发数）

    Args:
        clusters: [(category, [entries])] 需要合并的聚类列表
        max_concurrency: 最大并发数

    Returns:
        (合并后的记忆列表, 合并详情列表)
    """
    semaphore = asyncio.Semaphore(max_concurrency)

    async def _merge_one(category: str, cluster: list[MemoryEntry]) -> tuple[MemoryEntry, dict]:
        async with semaphore:
            return await _merge_cluster(cluster, category)

    tasks = [_merge_one(cat, cluster) for cat, cluster in clusters]
    results = await asyncio.gather(*tasks)

    entries = [r[0] for r in results]
    details = [r[1] for r in results]
    return entries, details


async def compress_memories(force_text_similarity: bool = False) -> dict:
    """压缩长期记忆 — 非流式版本（兼容旧代码）"""
    result = None
    async for event in compress_memories_stream(force_text_similarity):
        if event.get("type") == "result":
            result = event.get("data", {})
    return result or {"status": "error", "message": "压缩失败"}


async def compress_memories_stream(force_text_similarity: bool = False):
    """压缩长期记忆 — 流式版本，实时推送进度

    流程：
    1. 备份 memory.json
    2. 按分类分组记忆
    3. 对每个分类进行向量聚类
    4. LLM 合并相似聚类
    5. 原子写入 memory.json
    6. 清除向量索引

    Args:
        force_text_similarity: 强制使用文本相似度（用户确认降级后传入 True）

    Yields:
        进度事件字典：
        - {"type": "progress", "message": "...", "step": "backup|cluster|merge|save", "detail": {...}}
        - {"type": "result", "data": {...}}  # 最终结果
        - {"type": "error", "message": "..."}
    """
    from memory.manager import memory_manager
    from memory.search import invalidate_memory_index

    # 1. 备份（关键：防止数据丢失）
    yield {"type": "progress", "message": "正在备份记忆数据...", "step": "backup"}

    backup_path = memory_manager.memory_file.with_suffix(".json.pre-compress")
    if memory_manager.memory_file.exists():
        shutil.copy2(memory_manager.memory_file, backup_path)
        logger.info(f"已备份 memory.json 到 {backup_path}")

    # 2. 加载所有记忆
    yield {"type": "progress", "message": "正在加载记忆...", "step": "load"}

    data = memory_manager._load_memory_json()
    memories = [MemoryEntry.from_dict(m) for m in data.get("memories", [])]

    if len(memories) < 2:
        yield {
            "type": "result",
            "data": {
                "status": "skip",
                "reason": "记忆数量不足，无需压缩",
                "before": len(memories),
                "after": len(memories),
                "merged": 0,
                "kept": len(memories),
                "clusters": 0,
                "merge_details": [],
            },
        }
        return

    yield {"type": "progress", "message": f"已加载 {len(memories)} 条记忆", "step": "load"}

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

    # 统计需要处理的分类数量
    categories_to_process = [cat for cat in VALID_CATEGORIES if by_category.get(cat)]
    total_categories = len(categories_to_process)

    for cat_idx, category in enumerate(categories_to_process):
        cat_entries = by_category.get(category, [])
        cat_label = CATEGORY_LABELS.get(category, category)

        if len(cat_entries) == 1:
            # 单条记忆，直接保留
            new_memories.append(cat_entries[0])
            stats["kept"] += 1
            continue

        # 4.1 向量聚类
        yield {
            "type": "progress",
            "message": f"正在分析「{cat_label}」分类 ({cat_idx + 1}/{total_categories})...",
            "step": "cluster",
            "detail": {"category": category, "count": len(cat_entries)},
        }

        logger.info(f"正在聚类 [{category}] 分类的 {len(cat_entries)} 条记忆...")
        try:
            clusters = await _cluster_by_similarity(
                cat_entries,
                CLUSTER_SIMILARITY_THRESHOLD,
                force_text_similarity=force_text_similarity,
            )
        except EmbeddingUnavailableError:
            # embedding 不可用，返回特殊状态让前端询问用户
            yield {
                "type": "result",
                "data": {
                    "status": "embedding_unavailable",
                    "message": "embedding 模型不可用，是否降级为文本相似度算法？",
                    "before": len(memories),
                    "after": len(memories),
                    "merged": 0,
                    "kept": 0,
                    "clusters": 0,
                    "merge_details": [],
                },
            }
            return

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

        yield {
            "type": "progress",
            "message": f"「{cat_label}」分析完成，发现 {len([c for c in clusters if len(c) > 1])} 组相似记忆",
            "step": "cluster",
        }

    # 5. 批量 LLM 合并
    merge_details: list[dict] = []
    if clusters_to_merge:
        yield {
            "type": "progress",
            "message": f"正在合并 {len(clusters_to_merge)} 组相似记忆...",
            "step": "merge",
            "detail": {"total": len(clusters_to_merge)},
        }

        logger.info(f"正在合并 {len(clusters_to_merge)} 个聚类...")

        # 逐个合并并推送进度
        for idx, (category, cluster) in enumerate(clusters_to_merge):
            cat_label = CATEGORY_LABELS.get(category, category)
            preview = cluster[0].content[:30] + "..." if len(cluster[0].content) > 30 else cluster[0].content

            yield {
                "type": "progress",
                "message": f"正在合并第 {idx + 1}/{len(clusters_to_merge)} 组: {preview}",
                "step": "merge",
                "detail": {"current": idx + 1, "total": len(clusters_to_merge), "category": cat_label},
            }

            merged_entry, detail = await _merge_cluster(cluster, category)
            new_memories.append(merged_entry)
            merge_details.append(detail)

    # 6. 原子写入
    yield {"type": "progress", "message": "正在保存记忆...", "step": "save"}

    with memory_manager._lock:
        data["memories"] = [m.to_dict() for m in new_memories]
        data["last_updated"] = datetime.now().isoformat()
        memory_manager._save_memory_json(data)

    # 7. 关键：清除向量索引，下次搜索时重建
    invalidate_memory_index()
    logger.info("已清除向量索引，下次搜索时将重建")

    stats["after"] = len(new_memories)
    stats["status"] = "ok"
    stats["merge_details"] = merge_details

    logger.info(
        f"记忆压缩完成: {stats['before']} → {stats['after']} 条，"
        f"合并了 {stats['merged']} 条，保留 {stats['kept']} 条"
    )

    yield {"type": "result", "data": stats}
