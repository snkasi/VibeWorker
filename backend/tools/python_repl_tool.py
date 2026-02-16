"""Python REPL Tool - Execute Python code with security hardening.

Security layers:
1. AST analysis (detect dangerous imports/calls)
2. Restricted builtins (remove __import__, exec, eval, compile)
3. Import interception (block dangerous modules)
4. Execution timeout (30s via ThreadPoolExecutor, Windows-compatible)
"""
import os
import sys
import io
import traceback
import builtins
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

from langchain_core.tools import tool
from security.classifier import classify_python_code, RiskLevel, DANGEROUS_MODULES

# Execution timeout in seconds
EXEC_TIMEOUT = 30

# Modules blocked from import
BLOCKED_MODULES = DANGEROUS_MODULES | frozenset({
    "importlib", "code", "codeop", "compileall",
    "py_compile", "zipimport",
})


def _restricted_import(name, *args, **kwargs):
    """Custom __import__ that blocks dangerous modules."""
    module_root = name.split(".")[0]
    if module_root in BLOCKED_MODULES:
        raise ImportError(f"Import of '{name}' is blocked for security reasons.")
    return builtins.__import__(name, *args, **kwargs)


def _safe_open(path, *args, **kwargs):
    """Sandboxed open() that blocks sensitive files."""
    from security.classifier import _is_sensitive_file
    if _is_sensitive_file(str(path)):
        raise PermissionError(f"Access denied: reading '{path}' is blocked for security reasons.")
    return builtins.open(path, *args, **kwargs)


def _make_restricted_builtins():
    """Create a restricted builtins dict for exec/eval."""
    safe_builtins = {k: v for k, v in builtins.__dict__.items()}
    # Remove dangerous builtins
    for name in ("__import__", "exec", "eval", "compile", "breakpoint"):
        safe_builtins.pop(name, None)
    # Replace __import__ with restricted version
    safe_builtins["__import__"] = _restricted_import
    # Replace open with sandboxed version
    safe_builtins["open"] = _safe_open
    return safe_builtins


def _chdir_to_data_dir():
    """Change cwd to data directory and return the old cwd."""
    from config import settings
    old_cwd = os.getcwd()
    os.chdir(str(settings.get_data_path()))
    return old_cwd


def _execute_code(code: str) -> str:
    """Execute Python code with restricted builtins."""
    old_cwd = _chdir_to_data_dir()
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    redirected_stdout = io.StringIO()
    redirected_stderr = io.StringIO()
    sys.stdout = redirected_stdout
    sys.stderr = redirected_stderr

    try:
        exec_globals = {"__builtins__": _make_restricted_builtins()}
        try:
            exec(code, exec_globals)
        except SyntaxError:
            result = eval(code, exec_globals)
            if result is not None:
                print(result)

        stdout_output = redirected_stdout.getvalue()
        stderr_output = redirected_stderr.getvalue()

        output = ""
        if stdout_output:
            output += stdout_output
        if stderr_output:
            output += f"\n[stderr]: {stderr_output}"
        return output.strip() or "(no output)"

    except ImportError as e:
        return f"⛔ Blocked: {e}"
    except Exception as e:
        return f"❌ Error:\n{traceback.format_exc()}"
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        os.chdir(old_cwd)


def _execute_code_unrestricted(code: str) -> str:
    """Execute Python code without sandbox restrictions (when sandbox is disabled)."""
    old_cwd = _chdir_to_data_dir()
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    redirected_stdout = io.StringIO()
    redirected_stderr = io.StringIO()
    sys.stdout = redirected_stdout
    sys.stderr = redirected_stderr

    try:
        exec_globals: dict = {}
        try:
            exec(code, exec_globals)
        except SyntaxError:
            result = eval(code)
            if result is not None:
                print(result)

        stdout_output = redirected_stdout.getvalue()
        stderr_output = redirected_stderr.getvalue()

        output = ""
        if stdout_output:
            output += stdout_output
        if stderr_output:
            output += f"\n[stderr]: {stderr_output}"
        return output.strip() or "(no output)"

    except Exception as e:
        return f"❌ Error:\n{traceback.format_exc()}"
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        os.chdir(old_cwd)


@tool
def python_repl(code: str) -> str:
    """Execute Python code and return the output.
    The working directory is the user data directory. Use relative paths for all file operations.

    This tool runs Python code in a restricted environment. Use it for
    calculations, data processing, and script execution.
    Dangerous operations (os.system, subprocess, file deletion) are blocked.

    Args:
        code: Python code to execute.

    Returns:
        The output of the code execution (stdout) or error message.
    """
    # Check if Python sandbox is enabled
    try:
        from config import settings
        sandbox_on = settings.security_enabled and settings.security_python_sandbox
    except Exception:
        sandbox_on = True

    if sandbox_on:
        # Phase 1: AST-level risk check (hard-block only BLOCKED level)
        risk = classify_python_code(code)
        if risk == RiskLevel.BLOCKED:
            return "❌ Error: This code has been blocked for security reasons."

    # Phase 2: Check Docker sandbox
    try:
        from config import settings as _s
        if _s.security_enabled and _s.security_docker_enabled:
            from security import docker_sandbox
            if docker_sandbox.available:
                output, returncode = docker_sandbox.run_python(code)
                return output.strip() or "(no output)"
    except Exception:
        pass  # Fall through to local execution

    # Phase 3: Execute with restricted builtins + timeout (or unrestricted if sandbox off)
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        if sandbox_on:
            future = executor.submit(_execute_code, code)
        else:
            future = executor.submit(_execute_code_unrestricted, code)
        result = future.result(timeout=EXEC_TIMEOUT)
        return result
    except FuturesTimeoutError:
        return f"❌ Error: Code execution timed out after {EXEC_TIMEOUT} seconds."
    except Exception as e:
        return f"❌ Error:\n{traceback.format_exc()}"
    finally:
        executor.shutdown(wait=False)


def create_python_repl_tool():
    """Factory function to create the python_repl tool."""
    return python_repl
