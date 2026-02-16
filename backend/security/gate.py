"""SecurityGate - Core approval flow manager.

Manages pending approvals, SSE callbacks, and timeout handling.
Uses asyncio.Event for blocking tool execution until user approves/denies.
"""
import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional, Any

from security.config import (
    SecurityLevel, RiskLevel, ToolPolicy,
    get_tool_policy,
)
from security.classifier import (
    classify_terminal_command,
    classify_python_code,
    classify_url,
    classify_file_path,
)
from security.audit import audit_logger

logger = logging.getLogger(__name__)


@dataclass
class PendingApproval:
    """A pending approval request waiting for user decision."""
    request_id: str
    tool_name: str
    tool_input: dict
    risk_level: RiskLevel
    event: asyncio.Event = field(default_factory=asyncio.Event)
    approved: Optional[bool] = None
    timeout: float = 60.0
    created_at: float = field(default_factory=time.time)


class SecurityGate:
    """Central security gate managing tool execution approval."""

    def __init__(self):
        self._pending: dict[str, PendingApproval] = {}
        self._security_level: SecurityLevel = SecurityLevel.STANDARD
        self._sse_callback: Optional[Callable] = None
        self._approval_timeout: float = 60.0
        self._audit_enabled: bool = True

    def configure(
        self,
        security_level: str = "standard",
        approval_timeout: float = 60.0,
        audit_enabled: bool = True,
    ) -> None:
        """Configure the security gate from settings."""
        try:
            self._security_level = SecurityLevel(security_level.lower())
        except ValueError:
            self._security_level = SecurityLevel.STANDARD
        self._approval_timeout = approval_timeout
        self._audit_enabled = audit_enabled

    @property
    def security_level(self) -> SecurityLevel:
        return self._security_level

    def set_sse_callback(self, callback: Optional[Callable]) -> None:
        """Set the SSE callback for the current request.

        The callback should accept a dict and send it as an SSE event.
        """
        self._sse_callback = callback

    async def check_permission(
        self, tool_name: str, tool_input: dict
    ) -> tuple[bool, str]:
        """Check if a tool call is allowed to execute.

        Returns:
            (allowed, reason) - True if allowed, reason explains decision.
        """
        # Check rate limit first (if enabled)
        try:
            from config import settings
            if settings.security_rate_limit_enabled:
                from security.rate_limiter import rate_limiter
                rl_ok, rl_reason = rate_limiter.check(tool_name)
                if not rl_ok:
                    if self._audit_enabled:
                        audit_logger.log(
                            tool_name=tool_name,
                            tool_input=tool_input,
                            risk_level="rate_limited",
                            action="rate_limited",
                        )
                    return False, rl_reason
        except Exception:
            pass

        # Get the policy for this tool at current security level
        policy = get_tool_policy(self._security_level, tool_name)

        # Classify risk based on tool type and input
        risk_level = self._classify_tool_risk(tool_name, tool_input)

        # Always block BLOCKED risk
        if risk_level == RiskLevel.BLOCKED:
            if self._audit_enabled:
                audit_logger.log(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    risk_level=risk_level.value,
                    action="blocked",
                )
            return False, f"Operation blocked: dangerous {tool_name} operation detected"

        # Determine if we need approval
        needs_approval = self._needs_approval(policy, risk_level)

        if not needs_approval:
            # Auto-allowed
            if self._audit_enabled:
                audit_logger.log(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    risk_level=risk_level.value,
                    action="auto_allowed",
                )
            return True, "auto_allowed"

        # Need user approval - create pending request
        return await self._request_approval(tool_name, tool_input, risk_level)

    def _classify_tool_risk(self, tool_name: str, tool_input: dict) -> RiskLevel:
        """Classify the risk level of a tool invocation."""
        if tool_name == "terminal":
            command = tool_input.get("command", "")
            return classify_terminal_command(command)
        elif tool_name == "python_repl":
            code = tool_input.get("code", "")
            return classify_python_code(code)
        elif tool_name == "fetch_url":
            url = tool_input.get("url", "")
            return classify_url(url)
        elif tool_name == "read_file":
            path = tool_input.get("file_path", "")
            return classify_file_path(path)
        elif tool_name.startswith("mcp_"):
            # MCP tools default to WARN
            return RiskLevel.WARN
        else:
            return RiskLevel.SAFE

    def _needs_approval(self, policy: ToolPolicy, risk_level: RiskLevel) -> bool:
        """Determine if approval is needed based on policy and risk."""
        if policy == ToolPolicy.AUTO:
            return False
        elif policy == ToolPolicy.ALWAYS_APPROVE:
            return True
        elif policy == ToolPolicy.APPROVE_DANGEROUS:
            return risk_level in (RiskLevel.DANGEROUS, RiskLevel.WARN)
        elif policy == ToolPolicy.APPROVE_SENSITIVE:
            return risk_level in (RiskLevel.DANGEROUS,)
        return False

    async def _request_approval(
        self, tool_name: str, tool_input: dict, risk_level: RiskLevel
    ) -> tuple[bool, str]:
        """Send approval request via SSE and wait for user response."""
        request_id = str(uuid.uuid4())[:8]
        pending = PendingApproval(
            request_id=request_id,
            tool_name=tool_name,
            tool_input=tool_input,
            risk_level=risk_level,
            timeout=self._approval_timeout,
        )
        self._pending[request_id] = pending

        # Send SSE approval request to frontend
        if self._sse_callback:
            try:
                await self._sse_callback({
                    "type": "approval_request",
                    "request_id": request_id,
                    "tool": tool_name,
                    "input": _format_input_for_display(tool_name, tool_input),
                    "risk_level": risk_level.value,
                })
            except Exception as e:
                logger.error(f"Failed to send approval request via SSE: {e}")
                # If we can't reach the frontend, deny by default
                self._cleanup_pending(request_id)
                return False, "Failed to reach frontend for approval"

        # Wait for approval with timeout
        try:
            await asyncio.wait_for(
                pending.event.wait(),
                timeout=self._approval_timeout,
            )
        except asyncio.TimeoutError:
            # Timeout = deny
            self._cleanup_pending(request_id)
            if self._audit_enabled:
                audit_logger.log(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    risk_level=risk_level.value,
                    action="timeout",
                    request_id=request_id,
                )
            return False, f"Approval timed out after {self._approval_timeout}s - auto-denied"

        # Check result
        approved = pending.approved
        self._cleanup_pending(request_id)

        if approved:
            if self._audit_enabled:
                audit_logger.log(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    risk_level=risk_level.value,
                    action="approved",
                    request_id=request_id,
                )
            return True, "user_approved"
        else:
            if self._audit_enabled:
                audit_logger.log(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    risk_level=risk_level.value,
                    action="denied",
                    request_id=request_id,
                )
            return False, "User denied the operation"

    def resolve_approval(self, request_id: str, approved: bool) -> bool:
        """Resolve a pending approval request.

        Returns True if the request was found and resolved.
        """
        pending = self._pending.get(request_id)
        if not pending:
            logger.warning(f"Approval request {request_id} not found (expired?)")
            return False

        pending.approved = approved
        pending.event.set()
        return True

    def _cleanup_pending(self, request_id: str) -> None:
        """Remove a pending approval from the dict."""
        self._pending.pop(request_id, None)

    def get_pending_count(self) -> int:
        """Get the number of pending approval requests."""
        return len(self._pending)


def _format_input_for_display(tool_name: str, tool_input: dict) -> str:
    """Format tool input for display in the approval dialog."""
    if tool_name == "terminal":
        return tool_input.get("command", str(tool_input))
    elif tool_name == "python_repl":
        code = tool_input.get("code", str(tool_input))
        return code[:500] + ("..." if len(code) > 500 else "")
    elif tool_name == "fetch_url":
        return tool_input.get("url", str(tool_input))
    elif tool_name == "read_file":
        return tool_input.get("file_path", str(tool_input))
    else:
        # Generic: JSON format
        import json
        return json.dumps(tool_input, ensure_ascii=False)[:500]


# Singleton
security_gate = SecurityGate()
