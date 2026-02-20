"""Audit Logger - JSONL audit trail for all tool executions."""
import json
import logging
import time
from pathlib import Path
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

AUDIT_LOG_PATH = settings.get_data_path() / "logs" / "audit.jsonl"


class AuditLogger:
    """Append-only JSONL audit logger for tool execution events."""

    def __init__(self, log_path: Path = AUDIT_LOG_PATH):
        self._log_path = log_path
        self._log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(
        self,
        tool_name: str,
        tool_input: dict,
        risk_level: str,
        action: str,  # "auto_allowed" | "approved" | "denied" | "timeout" | "blocked" | "rate_limited"
        request_id: Optional[str] = None,
        execution_time_ms: Optional[float] = None,
        error: Optional[str] = None,
        feedback: Optional[str] = None,  # 用户审批时提供的指示
    ) -> None:
        """Write an audit entry."""
        entry = {
            "ts": time.time(),
            "tool": tool_name,
            "input": _sanitize_input(tool_input),
            "risk": risk_level,
            "action": action,
        }
        if request_id:
            entry["request_id"] = request_id
        if execution_time_ms is not None:
            entry["exec_ms"] = round(execution_time_ms, 1)
        if error:
            entry["error"] = error[:500]
        if feedback:
            entry["feedback"] = feedback[:500]

        try:
            with open(self._log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.warning(f"Failed to write audit log: {e}")


def _sanitize_input(tool_input: dict) -> dict:
    """Truncate large values in tool input for audit log."""
    result = {}
    for key, value in tool_input.items():
        if isinstance(value, str) and len(value) > 500:
            result[key] = value[:500] + "...[truncated]"
        else:
            result[key] = value
    return result


# Singleton
audit_logger = AuditLogger()
