"""Model Pool — Centralized model configuration management.

Maintains a pool of model configurations in ~/.vibeworker/model_pool.json.
Each scenario (llm, embedding, translate) references a pool entry by ID.
"""
import json
import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

# In-memory cache
_pool_cache: Optional[dict] = None

POOL_FILENAME = "model_pool.json"

MASK_PATTERN = "***"


def _pool_path() -> Path:
    return settings.get_data_path() / POOL_FILENAME


def _mask_key(key: str) -> str:
    """Mask API key for display: show first 4 and last 4 chars."""
    if not key or len(key) <= 12:
        return MASK_PATTERN
    return f"{key[:4]}{MASK_PATTERN}{key[-4:]}"


def _is_masked(key: str) -> bool:
    """Check if a key value is in masked format."""
    return MASK_PATTERN in key


def _empty_pool() -> dict:
    return {"models": [], "assignments": {}}


def load_pool() -> dict:
    """Load model pool from JSON file. Auto-migrate from .env on first access."""
    global _pool_cache
    if _pool_cache is not None:
        return _pool_cache

    path = _pool_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            _pool_cache = data
            return data
        except Exception as e:
            logger.error(f"Failed to load model pool: {e}")
            return _empty_pool()

    # File doesn't exist — try migration from .env
    pool = _maybe_migrate_from_env()
    _pool_cache = pool
    return pool


def save_pool(pool: dict) -> None:
    """Atomically write pool to JSON file."""
    global _pool_cache
    path = _pool_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Atomic write via temp file
    try:
        fd, tmp_path = tempfile.mkstemp(
            dir=str(path.parent), suffix=".tmp", prefix="model_pool_"
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(pool, f, ensure_ascii=False, indent=2)
        # On Windows, need to remove target first
        if path.exists():
            path.unlink()
        Path(tmp_path).rename(path)
        _pool_cache = pool
        logger.info("Model pool saved successfully")
    except Exception as e:
        logger.error(f"Failed to save model pool: {e}")
        # Clean up temp file on failure
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass
        raise


def _maybe_migrate_from_env() -> dict:
    """Migrate existing .env model config into pool on first run."""
    pool = _empty_pool()

    from config import settings as s

    # Collect distinct configurations
    configs = {}

    # Main LLM
    llm_key = s.llm_api_key
    llm_base = s.llm_api_base
    llm_model = s.llm_model
    if llm_key:
        sig = f"{llm_key}|{llm_base}"
        if sig not in configs:
            configs[sig] = {
                "id": str(uuid.uuid4())[:8],
                "name": f"主模型 ({llm_model})",
                "api_key": llm_key,
                "api_base": llm_base,
                "model": llm_model,
            }
        llm_id = configs[sig]["id"]
        pool["assignments"]["llm"] = llm_id
    else:
        llm_id = None

    # Embedding
    emb_key = s.embedding_api_key or s.llm_api_key
    emb_base = s.embedding_api_base or s.llm_api_base
    emb_model = s.embedding_model
    if emb_key:
        sig = f"{emb_key}|{emb_base}"
        if sig not in configs:
            configs[sig] = {
                "id": str(uuid.uuid4())[:8],
                "name": f"Embedding ({emb_model})",
                "api_key": emb_key,
                "api_base": emb_base,
                "model": emb_model,
            }
        emb_id = configs[sig]["id"]
        pool["assignments"]["embedding"] = emb_id
    else:
        emb_id = None

    # Translation
    trans_key = s.translate_api_key or s.llm_api_key
    trans_base = s.translate_api_base or s.llm_api_base
    trans_model = s.translate_model or s.llm_model
    if trans_key:
        sig = f"{trans_key}|{trans_base}"
        if sig not in configs:
            configs[sig] = {
                "id": str(uuid.uuid4())[:8],
                "name": f"翻译 ({trans_model})",
                "api_key": trans_key,
                "api_base": trans_base,
                "model": trans_model,
            }
        trans_id = configs[sig]["id"]
        pool["assignments"]["translate"] = trans_id

    pool["models"] = list(configs.values())

    if pool["models"]:
        try:
            save_pool(pool)
            logger.info(f"Migrated {len(pool['models'])} model(s) from .env to model pool")
        except Exception as e:
            logger.warning(f"Migration save failed: {e}")

    return pool


def invalidate_cache() -> None:
    """Clear in-memory pool cache, forcing a re-read from disk."""
    global _pool_cache
    _pool_cache = None


def list_models() -> list[dict]:
    """Return all models with masked keys."""
    pool = load_pool()
    result = []
    for m in pool.get("models", []):
        display = {**m, "api_key": _mask_key(m.get("api_key", ""))}
        result.append(display)
    return result


def get_model(model_id: str) -> Optional[dict]:
    """Get a model by ID (returns full config with real key for internal use)."""
    pool = load_pool()
    for m in pool.get("models", []):
        if m["id"] == model_id:
            return m
    return None


def add_model(name: str, api_key: str, api_base: str, model: str) -> dict:
    """Add a new model to the pool. Returns the new model entry."""
    pool = load_pool()
    new_model = {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "api_key": api_key,
        "api_base": api_base,
        "model": model,
    }
    pool["models"].append(new_model)
    save_pool(pool)
    return new_model


def update_model(model_id: str, **kwargs) -> dict:
    """Update an existing model. If api_key is masked, preserve the original."""
    pool = load_pool()
    for m in pool["models"]:
        if m["id"] == model_id:
            for key, value in kwargs.items():
                if value is not None:
                    if key == "api_key" and _is_masked(value):
                        continue  # Preserve original key
                    m[key] = value
            save_pool(pool)
            return m

    raise KeyError(f"Model '{model_id}' not found")


def delete_model(model_id: str) -> None:
    """Delete a model. Fails if model is assigned to any scenario."""
    pool = load_pool()

    # Check assignments
    for scenario, assigned_id in pool.get("assignments", {}).items():
        if assigned_id == model_id:
            raise ValueError(
                f"Cannot delete: model is assigned to '{scenario}'. "
                f"Reassign it first."
            )

    original_len = len(pool["models"])
    pool["models"] = [m for m in pool["models"] if m["id"] != model_id]
    if len(pool["models"]) == original_len:
        raise KeyError(f"Model '{model_id}' not found")

    save_pool(pool)


def get_assignments() -> dict:
    """Get current scenario assignments."""
    pool = load_pool()
    return pool.get("assignments", {})


def set_assignment(scenario: str, model_id: str) -> None:
    """Assign a model to a scenario (llm/embedding/translate)."""
    if scenario not in ("llm", "embedding", "translate"):
        raise ValueError(f"Invalid scenario: {scenario}")

    # Verify model exists
    model = get_model(model_id)
    if model is None:
        raise KeyError(f"Model '{model_id}' not found")

    pool = load_pool()
    pool["assignments"][scenario] = model_id
    save_pool(pool)


def update_assignments(assignments: dict) -> None:
    """Update multiple scenario assignments at once."""
    pool = load_pool()
    for scenario, model_id in assignments.items():
        if scenario not in ("llm", "embedding", "translate"):
            raise ValueError(f"Invalid scenario: {scenario}")
        if model_id:
            model = get_model(model_id)
            if model is None:
                raise KeyError(f"Model '{model_id}' not found")
            pool["assignments"][scenario] = model_id
        else:
            pool["assignments"].pop(scenario, None)
    save_pool(pool)


def resolve_model(scenario: str) -> dict:
    """Core function: resolve model config for a scenario.

    Priority:
    1. model_pool.json assignment for this scenario
    2. Fallback to .env legacy config

    Returns dict with keys: api_key, api_base, model
    """
    pool = load_pool()
    assignments = pool.get("assignments", {})
    model_id = assignments.get(scenario)

    if model_id:
        model = get_model(model_id)
        if model:
            return {
                "api_key": model.get("api_key", ""),
                "api_base": model.get("api_base", ""),
                "model": model.get("model", ""),
            }

    # Fallback to .env legacy config
    from config import settings as s
    if scenario == "llm":
        return {
            "api_key": s.llm_api_key,
            "api_base": s.llm_api_base,
            "model": s.llm_model,
        }
    elif scenario == "embedding":
        return {
            "api_key": s.embedding_api_key or s.llm_api_key,
            "api_base": s.embedding_api_base or s.llm_api_base,
            "model": s.embedding_model,
        }
    elif scenario == "translate":
        return {
            "api_key": s.translate_api_key or s.llm_api_key,
            "api_base": s.translate_api_base or s.llm_api_base,
            "model": s.translate_model or s.llm_model,
        }
    else:
        raise ValueError(f"Unknown scenario: {scenario}")
