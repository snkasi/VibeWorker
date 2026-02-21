"""记忆管理器 — VibeWorker 记忆系统 v2 的中枢

管理长期记忆（memory.json）和每日日志（logs/YYYY-MM-DD.json）。
支持结构化条目管理、重要性评分、时间衰减、每日日志操作和统计功能。

核心能力：
- memory.json 结构化存储
- 支持 salience（重要性）、access_count（访问计数）
- 支持 procedural 分类（程序性记忆）
- 每日日志使用 JSON 格式
"""
import json
import logging
import re
import shutil
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from config import settings
from memory.models import (
    MemoryEntry,
    MemoryMeta,
    DailyLog,
    DailyLogEntry,
    VALID_CATEGORIES,
    CATEGORY_LABELS,
)

logger = logging.getLogger(__name__)


def _jaccard_similarity(text_a: str, text_b: str) -> float:
    """计算两段文本的 Jaccard 相似度（基于分词的集合交并比）

    用于轻量级重复检测，无需 LLM 调用。
    """
    words_a = set(text_a.lower().split())
    words_b = set(text_b.lower().split())
    if not words_a or not words_b:
        return 0.0
    intersection = len(words_a & words_b)
    union = len(words_a | words_b)
    return intersection / union if union > 0 else 0.0


class MemoryManager:
    """记忆管理核心类"""

    # 重复检测的相似度阈值（Jaccard）
    DUPLICATE_SIMILARITY_THRESHOLD = 0.7

    # Prompt 注入时的条目数量限制（避免生成海量文本再截断）
    PROMPT_MAX_ENTRIES_PER_CATEGORY = 20
    PROMPT_MAX_TOTAL_ENTRIES = 50

    def __init__(self):
        self.memory_dir = settings.memory_dir
        self.logs_dir = settings.memory_dir / "logs"
        self.memory_file = settings.memory_dir / "memory.json"
        self.backup_file = settings.memory_dir / "memory.json.bak"

        # 并发写保护锁（read-modify-write 操作需持有此锁）
        self._lock = threading.Lock()

        # 确保目录存在
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)


    # ============================================
    # memory.json 操作
    # ============================================

    def _load_memory_json(self) -> dict:
        """加载 memory.json"""
        if not self.memory_file.exists():
            return {
                "version": 2,
                "last_updated": datetime.now().isoformat(),
                "rolling_summary": "",
                "memories": [],
            }

        try:
            return json.loads(self.memory_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            logger.error(f"memory.json 解析失败: {e}")
            return {
                "version": 2,
                "last_updated": datetime.now().isoformat(),
                "rolling_summary": "",
                "memories": [],
            }

    def _save_memory_json(self, data: dict) -> None:
        """保存 memory.json（带自动备份）"""
        # 更新时间戳
        data["last_updated"] = datetime.now().isoformat()

        # 创建备份
        if self.memory_file.exists():
            try:
                shutil.copy2(self.memory_file, self.backup_file)
            except Exception as e:
                logger.warning(f"创建备份失败: {e}")

        # 写入文件
        self.memory_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # 记忆变更后使 prompt 缓存失效，避免下次对话使用过时的记忆数据
        try:
            from cache import prompt_cache
            prompt_cache.clear()
        except Exception:
            pass

    def read_memory(self) -> str:
        """读取记忆内容（返回人类可读格式，用于 System Prompt）

        返回格式化的记忆摘要，包含：
        - Rolling Summary
        - 按分类组织的记忆条目
        - 重要性标记
        """
        data = self._load_memory_json()
        memories = [MemoryEntry.from_dict(m) for m in data.get("memories", [])]

        if not memories:
            return ""

        parts = []

        # Rolling Summary
        summary = data.get("rolling_summary", "")
        if summary:
            parts.append(f"## 概要\n{summary}")

        # 按分类组织
        by_category: dict[str, list[MemoryEntry]] = {}
        for m in memories:
            by_category.setdefault(m.category, []).append(m)

        # 按重要性排序，限制条目数量避免 Prompt 过长
        total_count = 0
        for cat in VALID_CATEGORIES:
            cat_entries = by_category.get(cat, [])
            if not cat_entries:
                continue

            # 按 salience 降序排序，优先保留高重要性条目
            cat_entries.sort(key=lambda x: x.salience, reverse=True)
            cat_entries = cat_entries[:self.PROMPT_MAX_ENTRIES_PER_CATEGORY]

            # 检查总量限制
            remaining = self.PROMPT_MAX_TOTAL_ENTRIES - total_count
            if remaining <= 0:
                break
            cat_entries = cat_entries[:remaining]
            total_count += len(cat_entries)

            label = CATEGORY_LABELS.get(cat, cat)
            lines = [f"## {label}"]
            for e in cat_entries:
                # 显示重要性标记
                importance = "⭐" if e.salience >= 0.8 else ""
                lines.append(f"- {importance}{e.content}")

            parts.append("\n".join(lines))

        return "\n\n".join(parts)

    def get_entries(self, category: Optional[str] = None) -> list[dict]:
        """获取记忆条目列表（API 格式）

        Args:
            category: 可选的分类过滤

        Returns:
            条目列表，每条包含 entry_id, content, category, timestamp, salience, access_count
        """
        data = self._load_memory_json()
        memories = [MemoryEntry.from_dict(m) for m in data.get("memories", [])]

        if category:
            memories = [m for m in memories if m.category == category]

        # 按创建时间降序排序
        memories.sort(key=lambda x: x.created_at, reverse=True)

        return [m.to_api_dict() for m in memories]

    def add_entry(
        self,
        content: str,
        category: str = "general",
        salience: float = 0.5,
        source: str = "user_explicit",
        context: Optional[dict] = None,
        skip_dedup: bool = False,
    ) -> dict:
        """添加新记忆条目

        Args:
            content: 记忆内容
            category: 分类
            salience: 重要性评分（0.0-1.0）
            source: 来源（user_explicit/auto_extract/auto_reflection）
            context: 额外上下文
            skip_dedup: 跳过重复检测（由 consolidator 已做 LLM 决策时使用）

        Returns:
            创建的条目（API 格式）
        """
        if category not in VALID_CATEGORIES:
            category = "general"

        # 限制 salience 范围
        salience = max(0.0, min(1.0, salience))

        with self._lock:
            data = self._load_memory_json()
            memories = data.get("memories", [])

            content_stripped = content.strip()

            # 重复检测：精确匹配 + Jaccard 相似度（轻量级，无 LLM 开销）
            # consolidator 已通过 LLM 做了 ADD 决策时，跳过此检测避免矛盾
            if not skip_dedup:
                for m in memories:
                    existing = m.get("content", "").strip()
                    if existing == content_stripped:
                        return MemoryEntry.from_dict(m).to_api_dict()
                    if _jaccard_similarity(existing, content_stripped) >= self.DUPLICATE_SIMILARITY_THRESHOLD:
                        logger.info(f"检测到相似记忆，跳过添加: {content_stripped[:50]}...")
                        return MemoryEntry.from_dict(m).to_api_dict()

            # 创建新条目
            entry = MemoryEntry(
                id=MemoryEntry.generate_id(),
                category=category,
                content=content_stripped,
                salience=salience,
                source=source,
                context=context,
            )

            memories.append(entry.to_dict())
            data["memories"] = memories
            self._save_memory_json(data)

        # 通知搜索模块索引已过期
        self._invalidate_search_index()
        logger.info(f"已添加记忆条目 [{entry.id}] 到 {category}")
        return entry.to_api_dict()

    def update_entry(
        self,
        entry_id: str,
        content: Optional[str] = None,
        category: Optional[str] = None,
        salience: Optional[float] = None,
    ) -> Optional[dict]:
        """更新记忆条目

        Args:
            entry_id: 条目 ID
            content: 新内容（可选）
            category: 新分类（可选）
            salience: 新重要性（可选）

        Returns:
            更新后的条目，或 None（未找到）
        """
        result = None
        with self._lock:
            data = self._load_memory_json()
            memories = data.get("memories", [])

            for i, m in enumerate(memories):
                if m.get("id") == entry_id:
                    if content is not None:
                        m["content"] = content.strip()
                    if category is not None and category in VALID_CATEGORIES:
                        m["category"] = category
                    if salience is not None:
                        m["salience"] = max(0.0, min(1.0, salience))
                    m["last_accessed"] = datetime.now().isoformat()

                    memories[i] = m
                    data["memories"] = memories
                    self._save_memory_json(data)
                    result = MemoryEntry.from_dict(m).to_api_dict()
                    break

        # 索引失效通知放在锁外，与 add_entry 保持一致
        if result is not None:
            self._invalidate_search_index()
            logger.info(f"已更新记忆条目 [{entry_id}]")

        return result

    def delete_entry(self, entry_id: str) -> bool:
        """删除记忆条目

        Args:
            entry_id: 条目 ID

        Returns:
            是否成功删除
        """
        deleted = False
        with self._lock:
            data = self._load_memory_json()
            memories = data.get("memories", [])

            original_len = len(memories)
            memories = [m for m in memories if m.get("id") != entry_id]

            if len(memories) < original_len:
                data["memories"] = memories
                self._save_memory_json(data)
                deleted = True

        # 索引失效通知放在锁外，与 add_entry 保持一致
        if deleted:
            self._invalidate_search_index()
            logger.info(f"已删除记忆条目 [{entry_id}]")

        return deleted

    def record_access(self, entry_id: str) -> None:
        """记录条目访问（更新 last_accessed 和 access_count）"""
        with self._lock:
            data = self._load_memory_json()
            memories = data.get("memories", [])

            for m in memories:
                if m.get("id") == entry_id:
                    m["last_accessed"] = datetime.now().isoformat()
                    m["access_count"] = m.get("access_count", 1) + 1
                    self._save_memory_json(data)
                    break

    def get_rolling_summary(self) -> str:
        """获取滚动摘要"""
        data = self._load_memory_json()
        return data.get("rolling_summary", "")

    def set_rolling_summary(self, summary: str) -> None:
        """设置滚动摘要"""
        with self._lock:
            data = self._load_memory_json()
            data["rolling_summary"] = summary
            self._save_memory_json(data)

    # ============================================
    # 每日日志操作
    # ============================================

    def _daily_log_path(self, day: Optional[str] = None) -> Path:
        """获取每日日志文件路径（JSON 格式）"""
        if day is None:
            day = datetime.now().strftime("%Y-%m-%d")
        return self.logs_dir / f"{day}.json"

    def append_daily_log(
        self,
        content: str,
        day: Optional[str] = None,
        log_type: str = "event",
        category: Optional[str] = None,
        tool: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        """向每日日志追加条目

        Args:
            content: 日志内容
            day: 日期（默认今天）
            log_type: 类型（event/auto_extract/reflection）
            category: 分类（用于 auto_extract）
            tool: 工具名（用于 reflection）
            error: 错误信息（用于 reflection）
        """
        path = self._daily_log_path(day)
        timestamp = datetime.now().strftime("%H:%M:%S")

        # 日志文件的 read-modify-write 需持锁保护，防止并发写入丢失数据
        # （auto_extract、reflection、用户纠正等多条路径可能同时触发）
        with self._lock:
            # 加载或创建日志
            if path.exists():
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    daily_log = DailyLog.from_dict(data)
                except Exception:
                    daily_log = DailyLog(date=day or datetime.now().strftime("%Y-%m-%d"))
            else:
                daily_log = DailyLog(date=day or datetime.now().strftime("%Y-%m-%d"))

            # 添加条目
            entry = DailyLogEntry(
                time=timestamp,
                type=log_type,
                content=content,
                category=category,
                tool=tool,
                error=error,
            )
            daily_log.entries.append(entry)

            # 保存
            path.write_text(
                json.dumps(daily_log.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        logger.info(f"已追加到每日日志: {path.name}")

    def read_daily_log(self, day: Optional[str] = None) -> str:
        """读取每日日志内容（返回人类可读格式）"""
        path = self._daily_log_path(day)

        if not path.exists():
            # 兼容旧版 .md 格式
            md_path = self.logs_dir / f"{day or datetime.now().strftime('%Y-%m-%d')}.md"
            if md_path.exists():
                return md_path.read_text(encoding="utf-8")
            return ""

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            daily_log = DailyLog.from_dict(data)
        except Exception:
            return ""

        # 格式化为人类可读格式
        lines = [f"# Daily Log - {daily_log.date}\n"]
        for entry in daily_log.entries:
            prefix = ""
            if entry.type == "auto_extract" and entry.category:
                prefix = f"[auto] [{entry.category}] "
            elif entry.type == "reflection" and entry.tool:
                prefix = f"[reflection] [{entry.tool}] "

            lines.append(f"- [{entry.time[:5]}] {prefix}{entry.content}")

        if daily_log.summary:
            lines.append(f"\n## 摘要\n{daily_log.summary}")

        return "\n".join(lines)

    def delete_daily_log(self, day: str) -> bool:
        """删除每日日志文件"""
        path = self._daily_log_path(day)
        if path.exists():
            path.unlink()
            logger.info(f"已删除每日日志: {path.name}")
            return True

        # 兼容旧版 .md 格式
        md_path = self.logs_dir / f"{day}.md"
        if md_path.exists():
            md_path.unlink()
            logger.info(f"已删除每日日志: {md_path.name}")
            return True

        return False

    def list_daily_logs(self) -> list[dict]:
        """列出所有每日日志文件及元数据"""
        logs = []
        if not self.logs_dir.exists():
            return logs

        # 收集 .json 和 .md 文件
        seen_dates = set()

        for f in sorted(self.logs_dir.glob("*.json"), reverse=True):
            if not re.match(r"\d{4}-\d{2}-\d{2}", f.stem):
                continue
            seen_dates.add(f.stem)
            stat = f.stat()
            logs.append({
                "date": f.stem,
                "path": f"memory/logs/{f.name}",
                "size": stat.st_size,
            })

        # 兼容旧版 .md 文件
        for f in sorted(self.logs_dir.glob("*.md"), reverse=True):
            if not re.match(r"\d{4}-\d{2}-\d{2}", f.stem):
                continue
            if f.stem in seen_dates:
                continue  # 已有 JSON 版本
            stat = f.stat()
            logs.append({
                "date": f.stem,
                "path": f"memory/logs/{f.name}",
                "size": stat.st_size,
            })

        # 按日期降序排序
        logs.sort(key=lambda x: x["date"], reverse=True)
        return logs

    def get_daily_context(self, num_days: Optional[int] = None) -> str:
        """获取近期每日日志，用于注入 System Prompt"""
        if num_days is None:
            num_days = settings.memory_daily_log_days

        parts = []
        today = datetime.now()

        for i in range(num_days):
            day = (today - timedelta(days=i)).strftime("%Y-%m-%d")
            content = self.read_daily_log(day)
            if content:
                label = "今天" if i == 0 else f"{i}天前" if i > 1 else "昨天"
                parts.append(f"### {label} ({day})\n{content}")

        return "\n\n".join(parts)

    # ============================================
    # 程序性记忆（Procedural Memory）
    # ============================================

    def get_procedural_memories(self, tool: Optional[str] = None) -> list[dict]:
        """获取程序性记忆（工具使用经验）

        Args:
            tool: 可选的工具名过滤

        Returns:
            程序性记忆列表
        """
        entries = self.get_entries(category="procedural")

        if tool:
            # 一次性加载 memory.json，避免循环内重复读取
            data = self._load_memory_json()
            # 构建 ID → context 映射
            context_map = {
                m.get("id"): m.get("context", {})
                for m in data.get("memories", [])
            }
            # 过滤特定工具的经验
            filtered = []
            for e in entries:
                ctx = context_map.get(e["entry_id"], {})
                if ctx and ctx.get("tool") == tool:
                    filtered.append(e)
            return filtered

        return entries

    def _invalidate_search_index(self) -> None:
        """通知搜索模块记忆索引已过期，下次搜索时懒加载重建"""
        try:
            from memory.search import invalidate_memory_index
            invalidate_memory_index()
        except ImportError:
            pass

    def add_procedural_memory(
        self,
        content: str,
        tool: str,
        error_type: Optional[str] = None,
        session_id: Optional[str] = None,
        salience: float = 0.8,
    ) -> dict:
        """添加程序性记忆（工具使用经验）

        Args:
            content: 经验描述
            tool: 工具名
            error_type: 错误类型（可选）
            session_id: 来源会话（可选）
            salience: 重要性（默认较高）

        Returns:
            创建的条目
        """
        context = {
            "tool": tool,
        }
        if error_type:
            context["error_type"] = error_type
        if session_id:
            context["learned_from"] = session_id

        return self.add_entry(
            content=content,
            category="procedural",
            salience=salience,
            source="auto_reflection",
            context=context,
        )

    # ============================================
    # 统计
    # ============================================

    def get_stats(self) -> dict:
        """获取记忆统计信息"""
        data = self._load_memory_json()
        memories = [MemoryEntry.from_dict(m) for m in data.get("memories", [])]
        logs = self.list_daily_logs()

        # 按分类计数
        category_counts = {}
        for cat in VALID_CATEGORIES:
            category_counts[cat] = sum(1 for m in memories if m.category == cat)

        # 平均重要性
        avg_salience = (
            sum(m.salience for m in memories) / len(memories)
            if memories else 0
        )

        memory_size = self.memory_file.stat().st_size if self.memory_file.exists() else 0

        return {
            "total_entries": len(memories),
            "category_counts": category_counts,
            "avg_salience": round(avg_salience, 2),
            "daily_logs_count": len(logs),
            "memory_file_size": memory_size,
            "daily_log_days": settings.memory_daily_log_days,
            "session_reflect_enabled": settings.memory_session_reflect_enabled,
            "version": data.get("version", 1),
        }


# 单例实例
memory_manager = MemoryManager()
