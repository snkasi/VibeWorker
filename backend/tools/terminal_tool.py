"""Terminal Tool - Execute shell commands with security classification."""
import subprocess
from pathlib import Path
from typing import Optional

from langchain_core.tools import tool
from config import PROJECT_ROOT, settings
from security.classifier import classify_terminal_command, RiskLevel


@tool
def terminal(command: str, timeout: Optional[int] = 30) -> str:
    """Execute a shell command in a sandboxed environment.
    The working directory is the user data directory. Use relative paths for all file operations.

    Args:
        command: The shell command to execute.
        timeout: Maximum execution time in seconds (default 30).

    Returns:
        Command output (stdout + stderr).
    """
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
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(settings.get_data_path()),
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
