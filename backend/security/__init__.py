"""Security Module - Three-layer security system for VibeWorker.

Layer 1: Permission Gate (approval flow)
Layer 2: Hardening (AST analysis, shell parsing, SSRF, rate limiting)
Layer 3: Docker Sandbox (optional container isolation)
"""
from security.gate import security_gate
from security.audit import audit_logger
from security.rate_limiter import rate_limiter
from security.docker_sandbox import docker_sandbox
from security.tool_wrapper import create_secured_tool, wrap_all_tools
from security.config import SecurityLevel, RiskLevel

__all__ = [
    "security_gate",
    "audit_logger",
    "rate_limiter",
    "docker_sandbox",
    "create_secured_tool",
    "wrap_all_tools",
    "SecurityLevel",
    "RiskLevel",
]
