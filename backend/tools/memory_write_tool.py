"""Memory Write Tool - 写入记忆到 memory.json 或每日日志

记忆系统 v2：
- 长期记忆存储在 memory.json
- 支持 salience（重要性评分）
- 支持 procedural 分类（程序性记忆）
- 支持智能整合（ADD/UPDATE/DELETE/NOOP 决策）
"""
import asyncio
import logging

from langchain_core.tools import tool
from memory.manager import memory_manager
from memory.models import VALID_CATEGORIES, CATEGORY_LABELS

logger = logging.getLogger(__name__)

# 整合操作的超时时间（秒）
CONSOLIDATION_TIMEOUT = 30


def _run_consolidation(content: str, category: str, salience: float) -> dict:
    """在同步上下文中运行异步整合逻辑

    LangChain @tool 被 Agent 调用时处于同步上下文（即使外层是 async），
    因此需要新线程 + asyncio.run() 来桥接。这种方式是安全的，因为新线程
    中没有已存在的事件循环。
    """
    from memory.consolidator import consolidate_memory

    async def _consolidate():
        return await consolidate_memory(
            content=content,
            category=category,
            salience=salience,
            source="user_explicit",
        )

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor() as pool:
        future = pool.submit(asyncio.run, _consolidate())
        return future.result(timeout=CONSOLIDATION_TIMEOUT)


@tool
def memory_write(content: str, category: str = "general", write_to: str = "memory", salience: float = 0.5) -> str:
    """Write a memory entry to long-term memory or daily log.

    Use this tool to record important information that should persist across sessions.

    Args:
        content: The information to remember. Be concise but specific.
        category: Category for the entry. One of:
            - "preferences" (用户偏好): user preferences, habits, likes/dislikes
            - "facts" (重要事实): factual information about user/project/environment
            - "tasks" (任务备忘): task notes, TODOs, reminders
            - "reflections" (反思日志): lessons learned, insights
            - "procedural" (程序经验): tool usage experiences, environment characteristics
            - "general" (通用记忆): anything else worth remembering
        write_to: Where to write. One of:
            - "memory" → writes to memory.json (long-term, persistent)
            - "daily" → writes to today's daily log (short-term, date-specific)
        salience: Importance score (0.0-1.0). Higher values indicate more important memories.
            Default is 0.5. Use 0.8+ for critical information.

    Returns:
        Confirmation message with the entry details.
    """
    if not content or not content.strip():
        return "❌ Error: Content cannot be empty."

    content = content.strip()

    if category not in VALID_CATEGORIES:
        return f"❌ Error: Invalid category '{category}'. Valid: {', '.join(VALID_CATEGORIES)}"

    try:
        if write_to == "daily":
            memory_manager.append_daily_log(content)
            return f"✅ 已写入今日日志: {content[:100]}..."
        elif write_to == "memory":
            from config import settings

            # 启用整合时使用 ADD/UPDATE/DELETE/NOOP 智能决策
            if settings.memory_consolidation_enabled:
                try:
                    result = _run_consolidation(content, category, salience)
                    decision = result.get("decision", "ADD")
                    entry = result.get("entry")
                    cat_label = CATEGORY_LABELS.get(category, category)

                    if decision == "NOOP":
                        return f"ℹ️ 已存在相似记忆，无需重复记录: {content[:100]}..."
                    elif decision == "UPDATE":
                        target_id = result.get("target_id", "")
                        return (
                            f"✅ 已更新已有记忆 [{cat_label}]: {content[:100]}...\n"
                            f"Updated Entry ID: {target_id}"
                        )
                    elif decision == "DELETE":
                        deleted_id = result.get("deleted_id", "")
                        entry_id = entry.get("entry_id", "") if entry else ""
                        return (
                            f"✅ 已替换旧记忆 [{cat_label}]: {content[:100]}...\n"
                            f"Deleted: {deleted_id}, New Entry ID: {entry_id}"
                        )
                    else:  # ADD
                        if entry:
                            salience_str = f" (重要性: {entry.get('salience', salience):.1f})"
                            return (
                                f"✅ 已写入长期记忆 [{cat_label}]{salience_str}: {content[:100]}...\n"
                                f"Entry ID: {entry['entry_id']}"
                            )
                except Exception as e:
                    logger.warning(f"整合逻辑失败，回退到直接添加: {e}")

            # 未启用整合 或 整合失败时直接添加
            entry = memory_manager.add_entry(
                content=content,
                category=category,
                salience=salience,
                source="user_explicit",
            )
            cat_label = CATEGORY_LABELS.get(category, category)
            salience_str = f" (重要性: {entry.get('salience', salience):.1f})"
            return (
                f"✅ 已写入长期记忆 [{cat_label}]{salience_str}: {content[:100]}...\n"
                f"Entry ID: {entry['entry_id']}"
            )
        else:
            return f"❌ Error: Invalid write_to '{write_to}'. Use 'memory' or 'daily'."
    except Exception as e:
        logger.error(f"Memory write failed: {e}")
        return f"❌ Error writing memory: {str(e)}"


def create_memory_write_tool():
    """Factory function to create the memory_write tool."""
    return memory_write
