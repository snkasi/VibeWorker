"""Terminal Tool - Execute shell commands with security classification."""
import logging
import subprocess
from typing import Optional

from langchain_core.tools import tool
from config import PROJECT_ROOT, settings
from session_context import get_current_session_id, get_tmp_dir_for_session
from security.classifier import classify_terminal_command, RiskLevel

logger = logging.getLogger(__name__)


def _intercept_plan_command(command: str) -> Optional[str]:
    """Intercept plan_create/plan_update when LLM mistakenly runs them as shell commands."""
    cmd = command.strip()
    if not (cmd.startswith("plan_create") or cmd.startswith("plan_update")):
        return None

    import shlex
    try:
        parts = shlex.split(cmd)
    except ValueError:
        parts = cmd.split()

    tool_name = parts[0]

    if tool_name == "plan_create":
        title = ""
        steps = []
        i = 1
        while i < len(parts):
            if parts[i] == "--title" and i + 1 < len(parts):
                title = parts[i + 1]
                i += 2
            elif parts[i] == "--steps":
                i += 1
                while i < len(parts) and not parts[i].startswith("--"):
                    steps.append(parts[i])
                    i += 1
            else:
                # Bare args after --steps flag consumed: treat remaining as steps
                steps.append(parts[i])
                i += 1
        if title and steps:
            from tools.plan_tool import plan_create as _pc
            return _pc.invoke({"title": title, "steps": steps})

    elif tool_name == "plan_update":
        plan_id = status = ""
        step_id = 0
        i = 1
        while i < len(parts):
            if parts[i] == "--plan_id" and i + 1 < len(parts):
                plan_id = parts[i + 1]; i += 2
            elif parts[i] == "--step_id" and i + 1 < len(parts):
                step_id = int(parts[i + 1]); i += 2
            elif parts[i] == "--status" and i + 1 < len(parts):
                status = parts[i + 1]; i += 2
            else:
                i += 1
        if plan_id and step_id and status:
            from tools.plan_tool import plan_update as _pu
            return _pu.invoke({"plan_id": plan_id, "step_id": step_id, "status": status})

    return None


@tool
def terminal(command: str, timeout: Optional[int] = 30) -> str:
    """Execute a shell command in a sandboxed environment.
    The working directory is the session temp directory (tmp/{session_id}/). Use relative paths for all file operations.

    Args:
        command: The shell command to execute.
        timeout: Maximum execution time in seconds (default 30).

    Returns:
        Command output (stdout + stderr).
    """
    # Intercept plan_create/plan_update if LLM runs them as shell commands
    logger.info(f"terminal called with command: {command[:80]}")
    plan_result = _intercept_plan_command(command)
    if plan_result is not None:
        logger.info(f"Plan command intercepted: {plan_result}")
        return plan_result
    logger.info("Not a plan command, proceeding with normal execution")

    # Check if security is enabled
    try:
        from config import settings
        sec_on = settings.security_enabled
    except Exception:
        sec_on = True

    # Hard-block catastrophic commands regardless of security level
    if sec_on:
        risk = classify_terminal_command(command)
        if risk == RiskLevel.BLOCKED:
            return "❌ Error: This command has been blocked for security reasons. It is classified as catastrophic."

    # Check Docker sandbox availability
    try:
        from config import settings as _s
        if _s.security_enabled and _s.security_docker_enabled:
            from security import docker_sandbox
            if not docker_sandbox.available:
                raise Exception("Docker not available")
            output, returncode = docker_sandbox.run_command(command)
            if returncode != 0 and returncode != -1:
                output += f"\n[exit code]: {returncode}"
            return output.strip() or "(no output)"
    except Exception:
        pass  # Fall through to local execution

    try:
        # 从 session_context 获取 session_id（由 security wrapper 设置）
        session_id = get_current_session_id()
        cwd = str(get_tmp_dir_for_session(session_id))
        logger.info(f"terminal cwd={cwd} session_id={session_id!r}")

        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
            env=None,  # Use current environment
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += f"\n[stderr]: {result.stderr}"
        if result.returncode != 0:
            output += f"\n[exit code]: {result.returncode}"
        return output.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"❌ Error: Command timed out after {timeout} seconds."
    except Exception as e:
        return f"❌ Error executing command: {str(e)}"


def create_terminal_tool():
    """Factory function to create the terminal tool."""
    return terminal
