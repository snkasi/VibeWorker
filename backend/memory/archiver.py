"""日志归档器 — 自动摘要归档和清理

功能：
1. 30 天后：LLM 生成摘要 → 重要内容提升为长期记忆
2. 60 天后：删除原始日志文件
"""
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)


async def summarize_daily_log(date: str) -> Optional[str]:
    """为每日日志生成摘要

    Args:
        date: 日期（YYYY-MM-DD）

    Returns:
        摘要内容，或 None（无内容）
    """
    from memory.manager import memory_manager

    content = memory_manager.read_daily_log(date)
    if not content or len(content.strip()) < 50:
        return None

    try:
        from engine.llm_factory import create_llm
        llm = create_llm(streaming=False)

        prompt = f"""请为以下每日日志生成简洁摘要（100字以内），提取关键事件和发现。

日期：{date}
日志内容：
{content[:2000]}

摘要："""

        response = await llm.ainvoke(prompt)
        summary = response.content.strip()

        # 限制长度
        if len(summary) > 200:
            summary = summary[:200] + "..."

        return summary

    except Exception as e:
        logger.error(f"生成日志摘要失败 ({date}): {e}")
        return None


async def extract_important_from_log(date: str) -> list[dict]:
    """从日志中提取重要内容，提升为长期记忆

    Args:
        date: 日期（YYYY-MM-DD）

    Returns:
        提取的记忆列表
    """
    from memory.manager import memory_manager

    log_path = memory_manager.logs_dir / f"{date}.json"
    if not log_path.exists():
        return []

    try:
        data = json.loads(log_path.read_text(encoding="utf-8"))
        entries = data.get("entries", [])

        if not entries:
            return []

        # 筛选 auto_extract 和 reflection 类型的条目
        important = []
        for entry in entries:
            entry_type = entry.get("type", "")
            if entry_type in ("auto_extract", "reflection"):
                content = entry.get("content", "")
                category = entry.get("category", "general")
                if content:
                    important.append({
                        "content": content,
                        "category": category,
                        "salience": 0.6,  # 从日志提升的记忆，中等重要性
                        "source": f"archive_{date}",
                    })

        return important

    except Exception as e:
        logger.error(f"提取日志内容失败 ({date}): {e}")
        return []


async def archive_daily_log(date: str) -> dict:
    """归档单个每日日志

    步骤：
    1. 生成摘要
    2. 提取重要内容到长期记忆
    3. 标记为已归档

    Args:
        date: 日期（YYYY-MM-DD）

    Returns:
        归档结果
    """
    from memory.manager import memory_manager

    log_path = memory_manager.logs_dir / f"{date}.json"
    if not log_path.exists():
        return {"status": "not_found", "date": date}

    try:
        data = json.loads(log_path.read_text(encoding="utf-8"))

        # 检查是否已归档
        if data.get("archived", False):
            return {"status": "already_archived", "date": date}

        # 生成摘要
        summary = await summarize_daily_log(date)
        if summary:
            data["summary"] = summary

        # 提取重要内容
        important = await extract_important_from_log(date)
        promoted_count = 0
        if important:
            from memory.consolidator import batch_consolidate
            results = await batch_consolidate(important)
            promoted_count = sum(1 for r in results if r.get("decision") != "NOOP")

        # 标记为已归档
        data["archived"] = True

        # 保存
        log_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        logger.info(f"已归档日志 {date}: 摘要={bool(summary)}, 提升={promoted_count}条")
        return {
            "status": "archived",
            "date": date,
            "summary": summary,
            "promoted_count": promoted_count,
        }

    except Exception as e:
        logger.error(f"归档日志失败 ({date}): {e}")
        return {"status": "error", "date": date, "error": str(e)}


async def cleanup_old_logs(
    archive_days: Optional[int] = None,
    delete_days: Optional[int] = None,
) -> dict:
    """清理旧日志

    Args:
        archive_days: 多少天后归档（默认 30）
        delete_days: 多少天后删除（默认 60）

    Returns:
        清理结果
    """
    from memory.manager import memory_manager

    if archive_days is None:
        archive_days = settings.memory_archive_days
    if delete_days is None:
        delete_days = settings.memory_delete_days

    today = datetime.now()
    archive_threshold = today - timedelta(days=archive_days)
    delete_threshold = today - timedelta(days=delete_days)

    archived = []
    deleted = []
    errors = []

    if not memory_manager.logs_dir.exists():
        return {"archived": [], "deleted": [], "errors": []}

    for log_file in memory_manager.logs_dir.glob("*.json"):
        try:
            # 解析日期
            date_str = log_file.stem
            log_date = datetime.strptime(date_str, "%Y-%m-%d")

            # 检查是否需要删除（超过 delete_days）
            if log_date < delete_threshold:
                # 先确保已归档（摘要 + 重要内容提升），再删除
                try:
                    log_data = json.loads(log_file.read_text(encoding="utf-8"))
                    if not log_data.get("archived", False):
                        # 未归档的日志先归档
                        result = await archive_daily_log(date_str)
                        if result.get("status") == "archived":
                            archived.append(date_str)
                        elif result.get("status") == "error":
                            errors.append({"date": date_str, "error": result.get("error")})
                            continue  # 归档失败则不删除，避免数据丢失
                except Exception as e:
                    logger.warning(f"删除前归档检查失败 ({date_str}): {e}")
                    # 归档检查失败也不删除，保护数据
                    errors.append({"date": date_str, "error": f"pre-delete archive check failed: {e}"})
                    continue

                log_file.unlink()
                deleted.append(date_str)
                logger.info(f"已删除旧日志: {date_str}")
                continue

            # 检查是否需要归档（超过 archive_days 但未到 delete_days）
            if log_date < archive_threshold:
                result = await archive_daily_log(date_str)
                if result.get("status") == "archived":
                    archived.append(date_str)
                elif result.get("status") == "error":
                    errors.append({"date": date_str, "error": result.get("error")})

        except ValueError:
            # 日期格式不正确，跳过
            continue
        except Exception as e:
            errors.append({"date": log_file.stem, "error": str(e)})

    logger.info(f"日志清理完成: 归档={len(archived)}, 删除={len(deleted)}, 错误={len(errors)}")
    return {
        "archived": archived,
        "deleted": deleted,
        "errors": errors,
    }


async def run_periodic_archive():
    """定期归档任务（可在 app.py 中调度）"""
    try:
        result = await cleanup_old_logs()
        logger.info(f"定期归档完成: {result}")
        return result
    except Exception as e:
        logger.error(f"定期归档失败: {e}")
        return {"error": str(e)}
