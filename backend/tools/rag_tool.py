"""RAG Tool - Hybrid retrieval using LlamaIndex for knowledge base search."""
import logging
from pathlib import Path
from typing import Optional

from langchain_core.tools import tool
from config import settings

logger = logging.getLogger(__name__)

# Global index reference (lazy-initialized)
_index = None
_query_engine = None


def _build_or_load_index():
    """Build a new index or load from persisted storage."""
    global _index, _query_engine

    try:
        from llama_index.core import (
            VectorStoreIndex,
            SimpleDirectoryReader,
            StorageContext,
            load_index_from_storage,
            Settings as LlamaSettings,
        )
        from llama_index.embeddings.openai import OpenAIEmbedding

        # Configure embedding model via model pool
        from model_pool import resolve_model
        emb_cfg = resolve_model("embedding")
        embed_model = OpenAIEmbedding(
            model=emb_cfg["model"],
            api_key=emb_cfg["api_key"],
            api_base=emb_cfg["api_base"],
        )
        LlamaSettings.embed_model = embed_model

        persist_dir = settings.storage_dir / "index"
        knowledge_dir = settings.knowledge_dir

        # Try loading existing index
        if persist_dir.exists():
            try:
                storage_context = StorageContext.from_defaults(
                    persist_dir=str(persist_dir)
                )
                _index = load_index_from_storage(storage_context)
                logger.info("Loaded existing index from storage.")
            except Exception as e:
                logger.warning(f"Failed to load index, rebuilding: {e}")
                _index = None

        # Build new index if needed
        if _index is None:
            if not knowledge_dir.exists() or not any(knowledge_dir.iterdir()):
                logger.info("Knowledge directory is empty, skipping index build.")
                return

            documents = SimpleDirectoryReader(
                input_dir=str(knowledge_dir),
                recursive=True,
                required_exts=[".md", ".txt", ".pdf"],
            ).load_data()

            if not documents:
                logger.info("No documents found in knowledge directory.")
                return

            _index = VectorStoreIndex.from_documents(documents)

            # Persist index
            persist_dir.mkdir(parents=True, exist_ok=True)
            _index.storage_context.persist(persist_dir=str(persist_dir))
            logger.info(f"Built and persisted index with {len(documents)} documents.")

        # Create query engine with hybrid search
        _query_engine = _index.as_query_engine(
            similarity_top_k=5,
            response_mode="compact",
        )

    except ImportError as e:
        logger.error(f"LlamaIndex not installed: {e}")
    except Exception as e:
        logger.error(f"Error building index: {e}")


@tool
def search_knowledge_base(query: str) -> str:
    """Search the local knowledge base using hybrid retrieval (keyword + vector search).

    Use this tool when the user asks about specific knowledge topics that
    are stored in the knowledge base (PDF, Markdown, or text files).

    Args:
        query: The search query to find relevant information.

    Returns:
        Relevant information from the knowledge base, or a message if nothing found.
    """
    global _query_engine

    if _query_engine is None:
        _build_or_load_index()

    if _query_engine is None:
        return (
            "⚠️ Knowledge base is not available. "
            "Please add documents to the `knowledge/` directory and restart the server."
        )

    try:
        response = _query_engine.query(query)
        result = str(response)

        if not result.strip():
            return f"No relevant information found for query: '{query}'"

        # Include source information
        sources = []
        if hasattr(response, "source_nodes"):
            for node in response.source_nodes[:3]:
                meta = node.metadata
                filename = meta.get("file_name", "unknown")
                score = getattr(node, "score", None)
                source_info = f"- {filename}"
                if score is not None:
                    source_info += f" (relevance: {score:.2f})"
                sources.append(source_info)

        output = result
        if sources:
            output += "\n\n📚 Sources:\n" + "\n".join(sources)

        return output

    except Exception as e:
        return f"❌ Error searching knowledge base: {str(e)}"


def rebuild_index() -> str:
    """Force rebuild the knowledge base index."""
    global _index, _query_engine
    _index = None
    _query_engine = None
    _build_or_load_index()
    if _index is not None:
        return "✅ Knowledge base index rebuilt successfully."
    return "⚠️ No documents found to build index."


def create_rag_tool():
    """Factory function to create the RAG search tool."""
    return search_knowledge_base
