"""ServiceController — thin wrapper around systemctl."""
from __future__ import annotations

import subprocess
from dataclasses import dataclass


@dataclass
class ServiceState:
    name: str
    active: str  # "active", "inactive", "failed", "unknown"
    sub: str     # "running", "dead", …
    load: str    # "loaded", "not-found", …

    @property
    def is_active(self) -> bool:
        return self.active == "active"

    @property
    def display(self) -> str:
        return self.active


class ServiceController:
    """Wraps systemctl via subprocess. All calls are synchronous."""

    @staticmethod
    def _run(*args: str, check: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["systemctl"] + list(args),
            capture_output=True,
            text=True,
            check=check,
        )

    def state(self, name: str) -> ServiceState:
        r = self._run("show", name, "--property=ActiveState,SubState,LoadState",
                      "--no-pager")
        props: dict[str, str] = {}
        for line in r.stdout.splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                props[k.strip()] = v.strip()
        return ServiceState(
            name=name,
            active=props.get("ActiveState", "unknown"),
            sub=props.get("SubState", "unknown"),
            load=props.get("LoadState", "unknown"),
        )

    def start(self, name: str) -> tuple[bool, str]:
        r = self._run("start", name)
        return r.returncode == 0, r.stderr.strip()

    def stop(self, name: str) -> tuple[bool, str]:
        r = self._run("stop", name)
        return r.returncode == 0, r.stderr.strip()

    def restart(self, name: str) -> tuple[bool, str]:
        r = self._run("restart", name)
        return r.returncode == 0, r.stderr.strip()

    def enable(self, name: str) -> tuple[bool, str]:
        r = self._run("enable", name)
        return r.returncode == 0, r.stderr.strip()

    def disable(self, name: str) -> tuple[bool, str]:
        r = self._run("disable", name)
        return r.returncode == 0, r.stderr.strip()

    def is_active(self, name: str) -> bool:
        r = self._run("is-active", name)
        return r.returncode == 0

    def daemon_reload(self) -> tuple[bool, str]:
        r = self._run("daemon-reload")
        return r.returncode == 0, r.stderr.strip()


# Module-level singleton
_svc = ServiceController()


def service_state(name: str) -> ServiceState:
    return _svc.state(name)


def service_restart(name: str) -> tuple[bool, str]:
    return _svc.restart(name)
