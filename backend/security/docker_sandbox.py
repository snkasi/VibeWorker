"""Docker Sandbox - Optional container-based execution for terminal and Python tools.

Provides isolated execution when Docker is available.
Falls back to local execution when Docker is not installed.
"""
import logging
import subprocess
from pathlib import Path
from typing import Optional

from config import PROJECT_ROOT

logger = logging.getLogger(__name__)


class DockerSandbox:
    """Manages Docker-based sandboxed execution."""

    IMAGE_NAME = "vibeworker-sandbox"
    DOCKERFILE_CONTENT = """FROM python:3.10-slim
RUN pip install --no-cache-dir pandas numpy requests matplotlib
WORKDIR /workspace
"""

    def __init__(self):
        self._available: Optional[bool] = None
        self._image_ready: bool = False
        self._network_mode: str = "none"  # none | bridge
        self._memory_limit: str = "512m"
        self._cpu_limit: float = 1.0
        self._timeout: int = 30

    def configure(
        self,
        enabled: bool = False,
        network: str = "none",
        memory_limit: str = "512m",
        cpu_limit: float = 1.0,
        timeout: int = 30,
    ) -> None:
        """Configure sandbox settings."""
        if not enabled:
            self._available = False
            return
        self._network_mode = network
        self._memory_limit = memory_limit
        self._cpu_limit = cpu_limit
        self._timeout = timeout
        # Reset availability check
        self._available = None

    @property
    def available(self) -> bool:
        """Check if Docker is available on the system."""
        if self._available is None:
            try:
                result = subprocess.run(
                    ["docker", "info"],
                    capture_output=True,
                    timeout=5,
                )
                self._available = result.returncode == 0
            except (FileNotFoundError, subprocess.TimeoutExpired):
                self._available = False

            if self._available:
                logger.info("Docker sandbox: available")
            else:
                logger.info("Docker sandbox: not available, using local execution")

        return self._available

    def ensure_image(self) -> bool:
        """Build the sandbox image if not already built."""
        if self._image_ready:
            return True
        if not self.available:
            return False

        try:
            # Check if image exists
            result = subprocess.run(
                ["docker", "image", "inspect", self.IMAGE_NAME],
                capture_output=True,
                timeout=10,
            )
            if result.returncode == 0:
                self._image_ready = True
                return True

            # Build image
            logger.info("Building Docker sandbox image...")
            dockerfile_path = Path(__file__).parent / "Dockerfile.sandbox"
            dockerfile_path.write_text(self.DOCKERFILE_CONTENT, encoding="utf-8")

            result = subprocess.run(
                ["docker", "build", "-t", self.IMAGE_NAME, "-f", str(dockerfile_path), str(dockerfile_path.parent)],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode == 0:
                self._image_ready = True
                logger.info("Docker sandbox image built successfully")
                return True
            else:
                logger.error(f"Failed to build sandbox image: {result.stderr}")
                return False

        except Exception as e:
            logger.error(f"Docker image build error: {e}")
            return False

    def run_command(self, command: str) -> tuple[str, int]:
        """Execute a shell command inside Docker container.

        Returns:
            (output, return_code)
        """
        if not self.ensure_image():
            return "", -1

        docker_cmd = [
            "docker", "run", "--rm",
            f"--network={self._network_mode}",
            f"--memory={self._memory_limit}",
            f"--cpus={self._cpu_limit}",
            "-v", f"{PROJECT_ROOT}:/workspace:ro",
            "-w", "/workspace",
            self.IMAGE_NAME,
            "bash", "-c", command,
        ]

        try:
            result = subprocess.run(
                docker_cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
            )
            output = result.stdout
            if result.stderr:
                output += f"\n[stderr]: {result.stderr}"
            return output.strip(), result.returncode
        except subprocess.TimeoutExpired:
            return f"Command timed out after {self._timeout}s in Docker", 124
        except Exception as e:
            return f"Docker execution error: {e}", -1

    def run_python(self, code: str) -> tuple[str, int]:
        """Execute Python code inside Docker container.

        Returns:
            (output, return_code)
        """
        if not self.ensure_image():
            return "", -1

        docker_cmd = [
            "docker", "run", "--rm",
            f"--network={self._network_mode}",
            f"--memory={self._memory_limit}",
            f"--cpus={self._cpu_limit}",
            "-v", f"{PROJECT_ROOT}:/workspace:ro",
            "-w", "/workspace",
            self.IMAGE_NAME,
            "python", "-c", code,
        ]

        try:
            result = subprocess.run(
                docker_cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
            )
            output = result.stdout
            if result.stderr:
                output += f"\n[stderr]: {result.stderr}"
            return output.strip(), result.returncode
        except subprocess.TimeoutExpired:
            return f"Python execution timed out after {self._timeout}s in Docker", 124
        except Exception as e:
            return f"Docker Python execution error: {e}", -1


# Singleton
docker_sandbox = DockerSandbox()
