"""Session Manager - Handle conversation session persistence."""
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)


class SessionManager:
    """Manages conversation sessions stored as JSON files."""

    def __init__(self):
        self.sessions_dir = settings.sessions_dir
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    def _session_path(self, session_id: str) -> Path:
        """Get the file path for a session."""
        # Sanitize session_id
        safe_id = "".join(c for c in session_id if c.isalnum() or c in "_-")
        return self.sessions_dir / f"{safe_id}.json"

    def list_sessions(self) -> list[dict]:
        """List all available sessions with metadata."""
        sessions = []
        for f in sorted(self.sessions_dir.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))

                # Support both old format (list) and new format (dict with metadata)
                if isinstance(data, list):
                    messages = data
                    title = None
                else:
                    messages = data.get("messages", [])
                    title = data.get("title", None)

                # Extract metadata
                session_id = f.stem
                msg_count = len(messages)
                last_message = ""
                updated_at = datetime.fromtimestamp(f.stat().st_mtime).isoformat()

                # Get last user message as preview
                for msg in reversed(messages):
                    if msg.get("role") == "user":
                        last_message = msg.get("content", "")[:100]
                        break

                sessions.append({
                    "session_id": session_id,
                    "message_count": msg_count,
                    "title": title,  # New field
                    "preview": last_message,
                    "updated_at": updated_at,
                })
            except Exception as e:
                logger.warning(f"Error reading session {f}: {e}")

        return sessions

    def get_session(self, session_id: str) -> list[dict]:
        """Get all messages for a session."""
        path = self._session_path(session_id)
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
            return data.get("messages", [])
        except Exception as e:
            logger.error(f"Error reading session {session_id}: {e}")
            return []

    def get_session_data(self, session_id: str) -> dict:
        """Get full session data including metadata."""
        path = self._session_path(session_id)
        if not path.exists():
            return {"messages": [], "title": None}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return {"messages": data, "title": None}
            return data
        except Exception as e:
            logger.error(f"Error reading session {session_id}: {e}")
            return {"messages": [], "title": None}

    def save_message(self, session_id: str, role: str, content: str,
                     tool_calls: Optional[list] = None) -> None:
        """Append a message to a session."""
        session_data = self.get_session_data(session_id)
        messages = session_data.get("messages", [])
        message: dict = {
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        }
        if tool_calls:
            message["tool_calls"] = tool_calls
        messages.append(message)
        session_data["messages"] = messages
        self._write_session_data(session_id, session_data)

    def create_session(self, session_id: Optional[str] = None) -> str:
        """Create a new session and return its ID."""
        if not session_id:
            session_id = f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        path = self._session_path(session_id)
        if not path.exists():
            self._write_session_data(session_id, {"messages": [], "title": None})
        return session_id

    def delete_session(self, session_id: str) -> bool:
        """Delete a session."""
        path = self._session_path(session_id)
        if path.exists():
            path.unlink()
            return True
        return False

    def _write_session(self, session_id: str, messages: list[dict]) -> None:
        """Write messages to a session file (legacy format)."""
        path = self._session_path(session_id)
        path.write_text(
            json.dumps(messages, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _write_session_data(self, session_id: str, session_data: dict) -> None:
        """Write full session data including metadata."""
        path = self._session_path(session_id)
        path.write_text(
            json.dumps(session_data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def set_title(self, session_id: str, title: str) -> None:
        """Set the title for a session."""
        session_data = self.get_session_data(session_id)
        session_data["title"] = title
        self._write_session_data(session_id, session_data)

    def save_debug_calls(self, session_id: str, debug_calls: list[dict]) -> None:
        """Save debug calls (LLM/tool traces) to the session."""
        if not debug_calls:
            return
        session_data = self.get_session_data(session_id)
        existing = session_data.get("debug_calls", [])
        existing.extend(debug_calls)
        session_data["debug_calls"] = existing
        self._write_session_data(session_id, session_data)

    def get_debug_calls(self, session_id: str) -> list[dict]:
        """Get debug calls for a session."""
        session_data = self.get_session_data(session_id)
        return session_data.get("debug_calls", [])


# Singleton instance
session_manager = SessionManager()
