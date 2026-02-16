"""Security Configuration - Security levels, tool policies, and risk definitions."""
from enum import Enum
from dataclasses import dataclass


class SecurityLevel(str, Enum):
    """Three security levels for tool execution."""
    RELAXED = "relaxed"      # All tools auto-execute
    STANDARD = "standard"    # Dangerous tools need approval
    STRICT = "strict"        # Most tools need approval


class RiskLevel(str, Enum):
    """Risk classification for tool operations."""
    SAFE = "safe"            # Auto-execute
    WARN = "warn"            # May need approval depending on security level
    DANGEROUS = "dangerous"  # Needs approval in standard/strict
    BLOCKED = "blocked"      # Always blocked


class ToolPolicy(str, Enum):
    """How a tool should be handled."""
    AUTO = "auto"                    # Execute automatically
    APPROVE_DANGEROUS = "approve_dangerous"  # Approve only if classified as dangerous
    ALWAYS_APPROVE = "always_approve"        # Always require approval
    APPROVE_SENSITIVE = "approve_sensitive"   # Approve if sensitive content detected


@dataclass
class PolicyMatrix:
    """Policy for a specific tool at a specific security level."""
    terminal: ToolPolicy
    python_repl: ToolPolicy
    fetch_url: ToolPolicy
    read_file: ToolPolicy
    memory_write: ToolPolicy
    memory_search: ToolPolicy
    search_knowledge_base: ToolPolicy


# Policy matrix for each security level
SECURITY_POLICIES: dict[SecurityLevel, PolicyMatrix] = {
    SecurityLevel.RELAXED: PolicyMatrix(
        terminal=ToolPolicy.AUTO,
        python_repl=ToolPolicy.AUTO,
        fetch_url=ToolPolicy.AUTO,
        read_file=ToolPolicy.AUTO,
        memory_write=ToolPolicy.AUTO,
        memory_search=ToolPolicy.AUTO,
        search_knowledge_base=ToolPolicy.AUTO,
    ),
    SecurityLevel.STANDARD: PolicyMatrix(
        terminal=ToolPolicy.APPROVE_DANGEROUS,
        python_repl=ToolPolicy.ALWAYS_APPROVE,
        fetch_url=ToolPolicy.AUTO,  # SSRF filtering handles this
        read_file=ToolPolicy.APPROVE_SENSITIVE,
        memory_write=ToolPolicy.AUTO,
        memory_search=ToolPolicy.AUTO,
        search_knowledge_base=ToolPolicy.AUTO,
    ),
    SecurityLevel.STRICT: PolicyMatrix(
        terminal=ToolPolicy.ALWAYS_APPROVE,
        python_repl=ToolPolicy.ALWAYS_APPROVE,
        fetch_url=ToolPolicy.ALWAYS_APPROVE,
        read_file=ToolPolicy.APPROVE_SENSITIVE,
        memory_write=ToolPolicy.AUTO,
        memory_search=ToolPolicy.AUTO,
        search_knowledge_base=ToolPolicy.AUTO,
    ),
}


def get_tool_policy(security_level: SecurityLevel, tool_name: str) -> ToolPolicy:
    """Get the policy for a tool at a given security level."""
    matrix = SECURITY_POLICIES.get(security_level, SECURITY_POLICIES[SecurityLevel.STANDARD])

    # MCP tools follow terminal policy
    if tool_name.startswith("mcp_"):
        return matrix.terminal

    return getattr(matrix, tool_name, ToolPolicy.AUTO)
