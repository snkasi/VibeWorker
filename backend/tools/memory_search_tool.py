"""Memory Search Tool - Search across all memory files using keyword or vector search."""
import logging
import re
from pathlib import Path
from typing import Optional

from langchain_core.tools import tool
from config import settings
from memory_manager import memory_manager

logger = logging.getLogger(__name__)

# Global memory index (lazy-initialized)
_memory_index = None
_memory_query_engine = None


def _build_or_load_memory_index():
    """Build or load the memory search index using LlamaIndex."""
    global _memory_index, _memory_query_engine

    if not settings.memory_index_enabled:
        return

    try:
        from llama_index.core import (
            VectorStoreIndex,
            SimpleDirectoryReader,
            StorageContext,
            load_index_from_storage,
            Document,
            Settings as LlamaSettings,
        )
        from llama_index.embeddings.openai import OpenAIEmbedding

        # Configure embedding via model pool
        from model_pool import resolve_model
        emb_cfg = resolve_model("embedding")
        embed_model = OpenAIEmbedding(
            model=emb_cfg["model"],
            api_key=emb_cfg["api_key"],
            api_base=emb_cfg["api_base"],
        )
        LlamaSettings.embed_model = embed_model

        persist_dir = settings.storage_dir / "memory_index"

        # Try loading existing index
        if persist_dir.exists():
            try:
                storage_context = StorageContext.from_defaults(
                    persist_dir=str(persist_dir)
                )
                _memory_index = load_index_from_storage(storage_context)
                logger.info("Loaded existing memory index from storage.")
            except Exception as e:
                logger.warning(f"Failed to load memory index, rebuilding: {e}")
                _memory_index = None

        # Build new index if needed
        if _memory_index is None:
            documents = []

            # Index MEMORY.md
            memory_content = memory_manager.read_memory()
            if memory_content:
                documents.append(Document(
                    text=memory_content,
                    metadata={"source": "MEMORY.md", "type": "long_term"},
                ))

            # Index daily logs
            logs_dir = settings.memory_dir / "logs"
            if logs_dir.exists():
                for log_file in logs_dir.glob("*.md"):
                    content = log_file.read_text(encoding="utf-8")
                    if content.strip():
                        documents.append(Document(
                            text=content,
                            metadata={
                                "source": f"logs/{log_file.name}",
                                "type": "daily_log",
                                "date": log_file.stem,
                            },
                        ))

            if not documents:
                logger.info("No memory documents to index.")
                return

            _memory_index = VectorStoreIndex.from_documents(documents)

            # Persist
            persist_dir.mkdir(parents=True, exist_ok=True)
            _memory_index.storage_context.persist(persist_dir=str(persist_dir))
            logger.info(f"Built memory index with {len(documents)} documents.")

        _memory_query_engine = _memory_index.as_query_engine(
            similarity_top_k=5,
            response_mode="no_text",  # Return raw nodes, not synthesized
        )

    except ImportError as e:
        logger.warning(f"LlamaIndex not available for memory search: {e}")
    except Exception as e:
        logger.error(f"Error building memory index: {e}")


def _keyword_search(query: str, top_k: int = 5) -> list[dict]:
    """Fallback keyword search when vector index is unavailable."""
    results = []
    query_lower = query.lower()
    keywords = query_lower.split()

    # Search MEMORY.md
    memory_content = memory_manager.read_memory()
    if memory_content:
        for line in memory_content.split("\n"):
            stripped = line.strip()
            if stripped.startswith("- [") and any(kw in stripped.lower() for kw in keywords):
                results.append({
                    "content": stripped,
                    "source": "MEMORY.md",
                    "score": sum(1 for kw in keywords if kw in stripped.lower()) / len(keywords),
                })

    # Search daily logs
    logs_dir = settings.memory_dir / "logs"
    if logs_dir.exists():
        for log_file in sorted(logs_dir.glob("*.md"), reverse=True):
            content = log_file.read_text(encoding="utf-8")
            for line in content.split("\n"):
                stripped = line.strip()
                if stripped.startswith("- [") and any(kw in stripped.lower() for kw in keywords):
                    results.append({
                        "content": stripped,
                        "source": f"logs/{log_file.name}",
                        "score": sum(1 for kw in keywords if kw in stripped.lower()) / len(keywords),
                    })

    # Sort by score and limit
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


@tool
def memory_search(query: str, top_k: int = 5) -> str:
    """Search across all memory files (MEMORY.md + daily logs).

    Use this tool to find past memories, user preferences, task notes,
    or any previously recorded information.

    Args:
        query: Search query describing what you're looking for.
        top_k: Maximum number of results to return (default 5).

    Returns:
        Matching memory entries with their sources, or a message if nothing found.
    """
    global _memory_query_engine

    if not query or not query.strip():
        return "❌ Error: Query cannot be empty."

    # Try vector search first
    if _memory_query_engine is not None or settings.memory_index_enabled:
        if _memory_query_engine is None:
            _build_or_load_memory_index()

        if _memory_query_engine is not None:
            try:
                response = _memory_query_engine.query(query)
                if hasattr(response, "source_nodes") and response.source_nodes:
                    results = []
                    for node in response.source_nodes[:top_k]:
                        text = node.node.get_content()[:300]
                        source = node.metadata.get("source", "unknown")
                        score = getattr(node, "score", 0)
                        results.append(f"📝 [{source}] (相关度: {score:.2f})\n{text}")

                    if results:
                        return f"找到 {len(results)} 条相关记忆:\n\n" + "\n\n---\n\n".join(results)
            except Exception as e:
                logger.warning(f"Vector search failed, falling back to keyword: {e}")

    # Fallback to keyword search
    results = _keyword_search(query, top_k)
    if results:
        formatted = []
        for r in results:
            formatted.append(f"📝 [{r['source']}]\n{r['content']}")
        return f"找到 {len(results)} 条相关记忆 (关键词匹配):\n\n" + "\n\n---\n\n".join(formatted)

    return f"未找到与 '{query}' 相关的记忆。"


def rebuild_memory_index() -> str:
    """Force rebuild the memory search index."""
    global _memory_index, _memory_query_engine
    _memory_index = None
    _memory_query_engine = None
    _build_or_load_memory_index()
    if _memory_index is not None:
        return "✅ Memory index rebuilt successfully."
    return "⚠️ No memory documents found to build index."


def create_memory_search_tool():
    """Factory function to create the memory_search tool."""
    return memory_search
