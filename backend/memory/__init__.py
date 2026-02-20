"""记忆系统 v2 — VibeWorker 四层记忆架构

四层记忆架构：
1. Working Memory (工作记忆) - 当前对话上下文，在 messages 中
2. Short-Term Memory (短期记忆) - Daily Logs，JSON 格式，30 天自动清理
3. Long-Term Memory (长期记忆) - memory.json，支持 ADD/UPDATE/DELETE 语义决策
4. Procedural Memory (程序性记忆) - 工具使用经验，作为 long-term 的 procedural 分类

模块导出：
- memory_manager: 核心管理器单例
- MemoryManager: 管理器类
- MemoryEntry, MemoryMeta: 数据模型
- VALID_CATEGORIES, CATEGORY_LABELS: 分类定义
- extractor: 记忆提取器（显式检测 + 隐式提取）
- reflector: 反思记忆提取器（工具失败分析 + 用户纠正检测）
"""

from memory.manager import MemoryManager, memory_manager
from memory.models import (
    MemoryEntry,
    MemoryMeta,
    DailyLog,
    DailyLogEntry,
    VALID_CATEGORIES,
    CATEGORY_LABELS,
)
from memory.extractor import (
    extract_memories_from_conversation,
    detect_explicit_memory_request,
    process_message_for_memory,
)
from memory.reflector import (
    record_tool_failure,
    detect_user_correction,
    process_user_correction,
)
from memory.reflection_strategies import (
    HookEvent,
    HookContext,
    ToolCallRecord,
    ReflectionStrategy,
    ToolFailureStrategy,
    RepeatedToolStrategy,
)
from memory.reflection_dispatcher import (
    ReflectionDispatcher,
    reflection_dispatcher,
)

__all__ = [
    "memory_manager",
    "MemoryManager",
    "MemoryEntry",
    "MemoryMeta",
    "DailyLog",
    "DailyLogEntry",
    "VALID_CATEGORIES",
    "CATEGORY_LABELS",
    "extract_memories_from_conversation",
    "detect_explicit_memory_request",
    "process_message_for_memory",
    "record_tool_failure",
    "detect_user_correction",
    "process_user_correction",
    # 反思策略框架
    "HookEvent",
    "HookContext",
    "ToolCallRecord",
    "ReflectionStrategy",
    "ToolFailureStrategy",
    "RepeatedToolStrategy",
    "ReflectionDispatcher",
    "reflection_dispatcher",
]
