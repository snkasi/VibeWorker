"""记忆搜索模块 — 支持向量检索 + 关键词匹配 + 时间衰减

提供多种搜索策略：
1. 向量搜索（LlamaIndex）
2. 关键词匹配（fallback）
3. 重要性 × 时间衰减排序
"""
import logging
import math
import threading
from datetime import datetime
from typing import Optional

from config import settings
from memory.models import MemoryEntry

logger = logging.getLogger(__name__)

# 全局记忆索引（懒加载）
_memory_index = None
_memory_query_engine = None
# 索引脏标记：增删改操作后设为 True，下次构建时清除持久化缓存强制重建
_index_dirty = False
# 索引操作的线程锁，防止搜索和写入之间的竞争条件
_index_lock = threading.Lock()


def compute_relevance(
    memory: MemoryEntry,
    semantic_score: float,
    now: Optional[datetime] = None,
    decay_lambda: Optional[float] = None,
) -> float:
    """计算综合相关性得分

    综合相关性 = 语义相似度 × 重要性 × 时间衰减

    Args:
        memory: 记忆条目
        semantic_score: 语义相似度（0-1）
        now: 当前时间（默认 datetime.now()）
        decay_lambda: 衰减系数（默认读取 settings.memory_decay_lambda）

    Returns:
        综合相关性得分
    """
    if now is None:
        now = datetime.now()
    if decay_lambda is None:
        decay_lambda = settings.memory_decay_lambda

    # 解析 last_accessed 时间
    # memory.json 中的时间通常由 datetime.now().isoformat() 生成（本地时间、无时区），
    # 若手动编辑为 UTC（如 "...Z"）则需先转本地时区再去掉 tzinfo 以确保与 now() 一致比较
    try:
        last_accessed = datetime.fromisoformat(memory.last_accessed.replace("Z", "+00:00"))
        if last_accessed.tzinfo is not None:
            # 先转换为本地时区，再去掉 tzinfo 以与 naive datetime.now() 一致
            last_accessed = last_accessed.astimezone().replace(tzinfo=None)
    except (ValueError, AttributeError):
        last_accessed = now

    # 计算天数差
    days_old = (now - last_accessed).days
    days_old = max(0, days_old)  # 确保非负

    # 时间衰减（指数衰减）
    decay = math.exp(-decay_lambda * days_old)

    # 综合得分
    return semantic_score * memory.salience * decay


def build_or_load_memory_index():
    """构建或加载记忆搜索索引（LlamaIndex）"""
    global _memory_index, _memory_query_engine, _index_dirty

    if not settings.memory_index_enabled:
        return

    with _index_lock:
        return _build_or_load_memory_index_locked()


def _build_or_load_memory_index_locked():
    """构建或加载索引的内部实现（需在 _index_lock 内调用）"""
    global _memory_index, _memory_query_engine, _index_dirty

    try:
        from llama_index.core import (
            VectorStoreIndex,
            StorageContext,
            load_index_from_storage,
            Document,
            Settings as LlamaSettings,
        )
        from llama_index.embeddings.openai import OpenAIEmbedding

        # 通过模型池获取 Embedding 配置
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
                logger.info("Embedding 模型 '%s' 非 OpenAI 标准模型，使用兼容模式", emb_cfg["model"])
                embed_model = OpenAIEmbedding(
                    api_key=emb_cfg["api_key"],
                    api_base=emb_cfg["api_base"],
                )
                embed_model.__dict__["model"] = emb_cfg["model"]
            else:
                raise
        LlamaSettings.embed_model = embed_model

        persist_dir = settings.storage_dir / "memory_index"

        # 索引被标记为脏（有增删改操作），清除持久化缓存强制重建
        if _index_dirty:
            if persist_dir.exists():
                import shutil
                shutil.rmtree(persist_dir)
                logger.info("记忆索引已标记为脏，清除持久化缓存")
            _index_dirty = False

        # 尝试加载已有索引
        if persist_dir.exists():
            try:
                storage_context = StorageContext.from_defaults(
                    persist_dir=str(persist_dir)
                )
                _memory_index = load_index_from_storage(storage_context)
                logger.info("从存储加载记忆索引")
            except Exception as e:
                logger.warning(f"加载记忆索引失败，将重建: {e}")
                _memory_index = None

        # 需要时构建新索引
        if _memory_index is None:
            documents = []

            # 索引 memory.json
            from memory.manager import memory_manager
            data = memory_manager._load_memory_json()
            memories = data.get("memories", [])

            for m in memories:
                entry = MemoryEntry.from_dict(m)
                # 构建索引文档，包含元数据
                doc = Document(
                    text=entry.content,
                    metadata={
                        "id": entry.id,
                        "category": entry.category,
                        "salience": entry.salience,
                        "source": "memory.json",
                        "type": "long_term",
                    },
                )
                documents.append(doc)

            # 索引每日日志
            logs_dir = settings.memory_dir / "logs"
            if logs_dir.exists():
                import json
                for log_file in logs_dir.glob("*.json"):
                    try:
                        log_data = json.loads(log_file.read_text(encoding="utf-8"))
                        entries = log_data.get("entries", [])
                        for entry in entries:
                            content = entry.get("content", "")
                            if content.strip():
                                doc = Document(
                                    text=content,
                                    metadata={
                                        "source": f"logs/{log_file.name}",
                                        "type": "daily_log",
                                        "date": log_file.stem,
                                    },
                                )
                                documents.append(doc)
                    except Exception as e:
                        logger.warning(f"索引 {log_file.name} 失败: {e}")

            if not documents:
                logger.info("没有记忆文档需要索引")
                return

            _memory_index = VectorStoreIndex.from_documents(documents)

            # 持久化
            persist_dir.mkdir(parents=True, exist_ok=True)
            _memory_index.storage_context.persist(persist_dir=str(persist_dir))
            logger.info(f"构建记忆索引，共 {len(documents)} 个文档")

        _memory_query_engine = _memory_index.as_query_engine(
            similarity_top_k=10,
            response_mode="no_text",  # 返回原始节点，不合成
        )

    except ImportError as e:
        logger.warning(f"LlamaIndex 不可用: {e}")
    except Exception as e:
        logger.error(f"构建记忆索引失败: {e}")


def keyword_search(
    query: str,
    top_k: int = 5,
    use_decay: bool = True,
) -> list[dict]:
    """关键词搜索（当向量索引不可用时的 fallback）

    Args:
        query: 搜索查询
        top_k: 返回数量
        use_decay: 是否使用时间衰减

    Returns:
        搜索结果列表
    """
    from memory.manager import memory_manager

    results = []
    query_lower = query.lower()
    keywords = query_lower.split()
    now = datetime.now()

    # 搜索 memory.json
    data = memory_manager._load_memory_json()
    memories = [MemoryEntry.from_dict(m) for m in data.get("memories", [])]

    for memory in memories:
        content_lower = memory.content.lower()
        if any(kw in content_lower for kw in keywords):
            # 计算关键词匹配得分
            keyword_score = sum(1 for kw in keywords if kw in content_lower) / len(keywords)

            if use_decay:
                score = compute_relevance(memory, keyword_score, now)
            else:
                score = keyword_score * memory.salience

            results.append({
                "id": memory.id,
                "content": memory.content,
                "category": memory.category,
                "source": "memory.json",
                "score": score,
                "salience": memory.salience,
            })

    # 搜索每日日志
    import json
    logs_dir = settings.memory_dir / "logs"
    if logs_dir.exists():
        for log_file in sorted(logs_dir.glob("*.json"), reverse=True):
            try:
                log_data = json.loads(log_file.read_text(encoding="utf-8"))
                for entry in log_data.get("entries", []):
                    content = entry.get("content", "")
                    content_lower = content.lower()
                    if any(kw in content_lower for kw in keywords):
                        keyword_score = sum(1 for kw in keywords if kw in content_lower) / len(keywords)
                        results.append({
                            "content": content,
                            "source": f"logs/{log_file.name}",
                            "score": keyword_score * 0.5,  # 日志权重较低
                        })
            except Exception:
                pass

    # 按得分排序并限制数量
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


def search_memories(
    query: str,
    top_k: int = 5,
    use_decay: bool = True,
    category: Optional[str] = None,
) -> list[dict]:
    """搜索记忆

    先尝试向量搜索，失败时 fallback 到关键词搜索。

    Args:
        query: 搜索查询
        top_k: 返回数量
        use_decay: 是否使用时间衰减
        category: 分类过滤（可选）

    Returns:
        搜索结果列表，每项包含：
        - content: 内容
        - source: 来源
        - score: 得分
        - id: ID（可选）
        - category: 分类（可选）
        - salience: 重要性（可选）
    """
    # 尝试向量搜索：先在锁内获取引擎引用，再在锁外执行查询
    query_engine = None
    with _index_lock:
        query_engine = _memory_query_engine

    if query_engine is not None or settings.memory_index_enabled:
        if query_engine is None:
            build_or_load_memory_index()
            with _index_lock:
                query_engine = _memory_query_engine

        if query_engine is not None:
            try:
                response = query_engine.query(query)
                if hasattr(response, "source_nodes") and response.source_nodes:
                    results = []
                    now = datetime.now()

                    # 一次性加载 memory.json 用于衰减计算，避免循环内重复读取
                    memory_map = {}
                    if use_decay:
                        from memory.manager import memory_manager
                        data = memory_manager._load_memory_json()
                        memory_map = {
                            m.get("id"): m for m in data.get("memories", [])
                        }

                    for node in response.source_nodes[:top_k * 2]:  # 获取更多用于过滤
                        text = node.node.get_content()
                        metadata = node.metadata
                        semantic_score = getattr(node, "score", 0.5)
                        salience = metadata.get("salience", 0.5)

                        # 分类过滤
                        if category and metadata.get("category") != category:
                            continue

                        # 计算综合得分
                        if use_decay:
                            entry_id = metadata.get("id")
                            m = memory_map.get(entry_id) if entry_id else None
                            if m:
                                entry = MemoryEntry.from_dict(m)
                                score = compute_relevance(entry, semantic_score, now)
                            else:
                                score = semantic_score * salience
                        else:
                            score = semantic_score * salience

                        results.append({
                            "id": metadata.get("id"),
                            "content": text[:300],
                            "category": metadata.get("category"),
                            "source": metadata.get("source", "unknown"),
                            "score": score,
                            "salience": salience,
                        })

                    # 按综合得分排序
                    results.sort(key=lambda x: x["score"], reverse=True)
                    return results[:top_k]

            except Exception as e:
                logger.warning(f"向量搜索失败，fallback 到关键词搜索: {e}")

    # Fallback 到关键词搜索
    results = keyword_search(query, top_k, use_decay)

    # 分类过滤
    if category:
        results = [r for r in results if r.get("category") == category]

    return results


def rebuild_memory_index() -> str:
    """强制重建记忆搜索索引"""
    global _memory_index, _memory_query_engine

    with _index_lock:
        # 清除现有索引
        _memory_index = None
        _memory_query_engine = None

        # 删除持久化目录
        persist_dir = settings.storage_dir / "memory_index"
        if persist_dir.exists():
            import shutil
            shutil.rmtree(persist_dir)
            logger.info("已删除旧的记忆索引")

    # 重建（build_or_load_memory_index 内部自带 _index_lock）
    build_or_load_memory_index()

    with _index_lock:
        if _memory_index is not None:
            return "✅ 记忆索引重建成功"
    return "⚠️ 没有记忆文档需要索引"


def get_implicit_recall(
    query: str,
    top_k: int = 3,
    include_procedural: bool = True,
) -> list[dict]:
    """隐式召回 — 对话开始时自动检索相关记忆

    Args:
        query: 用户首条消息
        top_k: 返回数量
        include_procedural: 是否包含程序性记忆

    Returns:
        相关记忆列表
    """
    results = search_memories(query, top_k=top_k, use_decay=True)

    # 额外获取程序性记忆
    if include_procedural:
        from memory.manager import memory_manager
        procedural = memory_manager.get_procedural_memories()
        # 按 salience 排序，取 top 3
        procedural.sort(key=lambda x: x.get("salience", 0), reverse=True)

        # 基于内容前缀去重（日志型结果可能没有 id 字段，字段名也不统一）
        existing_contents = {r.get("content", "")[:100] for r in results}
        for p in procedural[:3]:
            p_content = p.get("content", "")
            if p_content[:100] not in existing_contents:
                results.append({
                    "id": p.get("entry_id"),
                    "content": p_content,
                    "category": "procedural",
                    "source": "memory.json",
                    "score": p.get("salience", 0.5),
                    "salience": p.get("salience", 0.5),
                })
                existing_contents.add(p_content[:100])

    return results[:top_k + 3]  # 允许额外的 procedural


def invalidate_memory_index() -> None:
    """使记忆索引失效，下次搜索时自动懒加载重建

    由 MemoryManager 的增删改操作调用，实现自然节流：
    多次快速写入只会在下一次搜索时触发一次重建。

    关键：同时设置 _index_dirty 标记，使 build_or_load_memory_index
    清除持久化目录后从头构建，而不是从磁盘加载过时的旧索引。
    """
    global _memory_index, _memory_query_engine, _index_dirty
    with _index_lock:
        _memory_index = None
        _memory_query_engine = None
        _index_dirty = True
