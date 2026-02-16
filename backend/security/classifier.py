"""Risk Classifier - Analyzes tool inputs to determine risk level.

Uses shell parsing (shlex) for terminal commands and AST analysis for Python code,
replacing the old regex blacklist approach.
"""
import ast
import shlex
import logging
import ipaddress
import socket
from pathlib import Path
from urllib.parse import urlparse

from security.config import RiskLevel

logger = logging.getLogger(__name__)

# ============================================
# Terminal Command Classification
# ============================================

# Commands that are ALWAYS blocked (catastrophic)
BLOCKED_COMMANDS = frozenset({
    "mkfs", "format", "dd",
})

# Prefix-based blocked commands (e.g., mkfs.ext4)
BLOCKED_PREFIXES = ("mkfs.",)

# Patterns that indicate blocked operations
BLOCKED_PATTERNS = [
    # Fork bomb patterns
    lambda cmd: ":(){" in cmd.replace(" ", ""),
    # Format with drive letter (Windows)
    lambda cmd: cmd.strip().lower().startswith("format") and ":" in cmd,
]

# Commands classified as dangerous (need approval in standard mode)
DANGEROUS_COMMANDS = frozenset({
    "rm", "rmdir", "del", "rd",          # Deletion
    "curl", "wget", "invoke-webrequest",  # Network download
    "pip", "pip3", "npm", "yarn",         # Package managers
    "chmod", "chown", "chattr",           # Permission changes
    "kill", "killall", "pkill", "taskkill",  # Process management
    "powershell", "pwsh", "cmd",          # Shell escalation
    "sudo", "su", "runas",               # Privilege escalation
    "mv", "move", "ren", "rename",       # File moves (can be destructive)
    "shutdown", "reboot", "halt", "init", # System control
    "net", "netsh", "iptables",          # Network config
    "reg", "regedit",                     # Registry (Windows)
    "docker", "kubectl",                  # Container management
})

# Commands classified as safe (auto-execute)
SAFE_COMMANDS = frozenset({
    "ls", "dir", "cat", "type", "head", "tail", "less", "more",
    "pwd", "cd", "echo", "printf",
    "grep", "rg", "find", "which", "where", "whereis",
    "git", "wc", "sort", "uniq", "diff", "comm",
    "date", "cal", "uptime", "whoami", "hostname",
    "python", "python3", "node", "java",  # Running scripts (not installing)
    "tree", "file", "stat", "du", "df",
    "env", "printenv", "set",
    "basename", "dirname", "realpath",
    "tar", "zip", "unzip", "gzip", "gunzip",  # Archive (generally safe)
    "sed", "awk", "cut", "tr", "tee",
    "touch", "mkdir",
    "test", "true", "false",
    "man", "help", "info",
})

# Git subcommands that are dangerous
DANGEROUS_GIT_SUBCOMMANDS = frozenset({
    "push", "reset", "clean", "rebase", "merge",
    "branch", "checkout",  # Only with -D / force flags
})


def classify_terminal_command(command: str) -> RiskLevel:
    """Classify a terminal command's risk level using shell parsing.

    Returns RiskLevel indicating how dangerous the command is.
    """
    if not command or not command.strip():
        return RiskLevel.SAFE

    # Check blocked patterns first
    for pattern_fn in BLOCKED_PATTERNS:
        try:
            if pattern_fn(command):
                return RiskLevel.BLOCKED
        except Exception:
            pass

    # Parse command with shlex
    try:
        tokens = shlex.split(command)
    except ValueError:
        # Malformed command - treat as dangerous
        return RiskLevel.DANGEROUS

    if not tokens:
        return RiskLevel.SAFE

    # Handle pipes and chains: check each sub-command
    # Split by pipe/chain operators
    risk = RiskLevel.SAFE
    current_tokens: list[str] = []

    for token in tokens:
        if token in ("|", "||", "&&", ";"):
            if current_tokens:
                sub_risk = _classify_single_command(current_tokens)
                risk = _max_risk(risk, sub_risk)
            current_tokens = []
        else:
            current_tokens.append(token)

    if current_tokens:
        sub_risk = _classify_single_command(current_tokens)
        risk = _max_risk(risk, sub_risk)

    return risk


def _classify_single_command(tokens: list[str]) -> RiskLevel:
    """Classify a single command (no pipes/chains)."""
    if not tokens:
        return RiskLevel.SAFE

    base_cmd = Path(tokens[0]).name.lower()

    # Check blocked commands
    if base_cmd in BLOCKED_COMMANDS:
        return RiskLevel.BLOCKED
    # Check prefix-based blocked commands (e.g., mkfs.ext4)
    for prefix in BLOCKED_PREFIXES:
        if base_cmd.startswith(prefix):
            return RiskLevel.BLOCKED

    # Check dangerous commands
    if base_cmd in DANGEROUS_COMMANDS:
        # Special handling for rm: rm without flags on specific files is warn-level
        if base_cmd in ("rm", "del"):
            flags = [t for t in tokens[1:] if t.startswith("-")]
            has_recursive = any(f for f in flags if "r" in f.lower())
            has_force = any(f for f in flags if "f" in f.lower())
            if has_recursive and has_force:
                return RiskLevel.DANGEROUS
            if has_recursive or has_force:
                return RiskLevel.DANGEROUS
            return RiskLevel.WARN
        return RiskLevel.DANGEROUS

    # Special: git subcommand check
    if base_cmd == "git" and len(tokens) > 1:
        subcmd = tokens[1].lower()
        if subcmd in DANGEROUS_GIT_SUBCOMMANDS:
            has_force = any("force" in t.lower() or t == "-f" or t == "-D" for t in tokens[2:])
            return RiskLevel.DANGEROUS if has_force else RiskLevel.WARN
        return RiskLevel.SAFE

    # Check safe commands
    if base_cmd in SAFE_COMMANDS:
        return RiskLevel.SAFE

    # Unknown command - warn level
    return RiskLevel.WARN


def _max_risk(a: RiskLevel, b: RiskLevel) -> RiskLevel:
    """Return the higher risk level."""
    order = {RiskLevel.SAFE: 0, RiskLevel.WARN: 1, RiskLevel.DANGEROUS: 2, RiskLevel.BLOCKED: 3}
    return a if order.get(a, 0) >= order.get(b, 0) else b


# ============================================
# Python Code Classification
# ============================================

# Dangerous modules that should be blocked or flagged
DANGEROUS_MODULES = frozenset({
    "os", "subprocess", "shutil", "socket", "ctypes",
    "signal", "multiprocessing", "threading",
    "http.server", "xmlrpc", "ftplib", "smtplib", "telnetlib",
    "pickle", "shelve", "marshal",
})

# Dangerous function calls
DANGEROUS_CALLS = frozenset({
    "os.system", "os.popen", "os.exec", "os.execl", "os.execle",
    "os.execv", "os.execve", "os.execvp", "os.execvpe",
    "os.spawn", "os.spawnl", "os.spawnle", "os.spawnlp",
    "os.remove", "os.unlink", "os.rmdir", "os.removedirs",
    "subprocess.run", "subprocess.call", "subprocess.Popen",
    "subprocess.check_output", "subprocess.check_call",
    "shutil.rmtree", "shutil.move",
    "eval", "exec", "compile", "__import__",
})

# Sensitive file patterns
SENSITIVE_FILE_PATTERNS = [
    ".env", ".env.local", ".env.production",
    "mcp_servers.json",
    ".key", ".pem", ".p12", ".pfx",
    "credentials", "secret", "token",
    "id_rsa", "id_ed25519",
]


def classify_python_code(code: str) -> RiskLevel:
    """Classify Python code risk using AST analysis."""
    if not code or not code.strip():
        return RiskLevel.SAFE

    try:
        tree = ast.parse(code)
    except SyntaxError:
        # Can't parse - moderate risk
        return RiskLevel.WARN

    risk = RiskLevel.SAFE

    for node in ast.walk(tree):
        node_risk = _check_ast_node(node)
        risk = _max_risk(risk, node_risk)
        if risk == RiskLevel.BLOCKED:
            break

    return risk


def _check_ast_node(node: ast.AST) -> RiskLevel:
    """Check a single AST node for dangerous patterns."""
    # Import checks
    if isinstance(node, ast.Import):
        for alias in node.names:
            module_root = alias.name.split(".")[0]
            if module_root in DANGEROUS_MODULES:
                return RiskLevel.DANGEROUS

    if isinstance(node, ast.ImportFrom):
        if node.module:
            module_root = node.module.split(".")[0]
            if module_root in DANGEROUS_MODULES:
                return RiskLevel.DANGEROUS

    # Function call checks
    if isinstance(node, ast.Call):
        call_name = _get_call_name(node)
        if call_name in DANGEROUS_CALLS:
            return RiskLevel.DANGEROUS

        # Check for open() on sensitive files
        if call_name == "open" and node.args:
            if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                filepath = node.args[0].value
                if _is_sensitive_file(filepath):
                    return RiskLevel.DANGEROUS

    return RiskLevel.SAFE


def _get_call_name(node: ast.Call) -> str:
    """Extract the full name of a function call."""
    if isinstance(node.func, ast.Name):
        return node.func.id
    elif isinstance(node.func, ast.Attribute):
        parts = []
        current = node.func
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if isinstance(current, ast.Name):
            parts.append(current.id)
        return ".".join(reversed(parts))
    return ""


# ============================================
# URL Classification (SSRF Prevention)
# ============================================

# Private IP ranges
PRIVATE_RANGES = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def classify_url(url: str) -> RiskLevel:
    """Classify URL risk for SSRF prevention."""
    if not url:
        return RiskLevel.SAFE

    try:
        parsed = urlparse(url)
    except Exception:
        return RiskLevel.DANGEROUS

    # Only allow http/https
    if parsed.scheme not in ("http", "https"):
        return RiskLevel.BLOCKED

    hostname = parsed.hostname
    if not hostname:
        return RiskLevel.DANGEROUS

    # Check for self-referencing (accessing own API)
    port = parsed.port
    if hostname in ("localhost", "127.0.0.1", "::1") and port == 8088:
        return RiskLevel.BLOCKED

    # DNS resolve and check private IPs
    try:
        addr_infos = socket.getaddrinfo(hostname, None)
        for family, _, _, _, sockaddr in addr_infos:
            ip = ipaddress.ip_address(sockaddr[0])
            for private_range in PRIVATE_RANGES:
                if ip in private_range:
                    return RiskLevel.DANGEROUS
    except (socket.gaierror, ValueError, OSError):
        # Can't resolve - warn but allow
        return RiskLevel.WARN

    return RiskLevel.SAFE


# ============================================
# File Path Classification
# ============================================

def _is_sensitive_file(filepath: str) -> bool:
    """Check if a file path matches sensitive patterns."""
    path_lower = filepath.lower().replace("\\", "/")
    name = Path(filepath).name.lower()

    for pattern in SENSITIVE_FILE_PATTERNS:
        if pattern.startswith("."):
            # Extension match
            if name == pattern or name.endswith(pattern):
                return True
        else:
            # Substring match
            if pattern in name:
                return True

    return False


def classify_file_path(file_path: str) -> RiskLevel:
    """Classify file read risk based on path sensitivity."""
    if _is_sensitive_file(file_path):
        return RiskLevel.DANGEROUS
    return RiskLevel.SAFE
