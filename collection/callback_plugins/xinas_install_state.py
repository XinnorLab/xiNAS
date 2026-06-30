# xiNAS install-state callback plugin (InstallationFeedback finding #2).
#
# Records role-by-role install progress to /var/lib/xinas/install-state.json so
# an interrupted or partial install has a resume signal ("what step did I last
# complete?"). Aggregate callback — it never writes to stdout and never raises
# into the play: all I/O is best-effort. Enable via ansible.cfg:
#   callback_plugins  = collection/callback_plugins
#   callbacks_enabled = xinas_install_state
from __future__ import annotations

import json
import os
import time

DOCUMENTATION = """
    name: xinas_install_state
    type: aggregate
    short_description: Write per-role install progress to install-state.json
    description:
      - Records each role's running/ok/failed status and the overall install
        status to a JSON file, so tooling can detect partial installs.
    requirements:
      - enable in configuration (callbacks_enabled)
"""

try:
    from ansible.plugins.callback import CallbackBase
except ImportError:  # allow importing _StateWriter in unit tests without ansible
    CallbackBase = object

STATE_PATH = os.environ.get(
    "XINAS_INSTALL_STATE_PATH", "/var/lib/xinas/install-state.json"
)


class _StateWriter:
    """Pure install-state accumulator — no ansible dependency, unit-testable.

    Each transition flushes atomically to disk so a kill mid-install still
    leaves a readable file. I/O errors are swallowed: install telemetry must
    never break the install itself.
    """

    def __init__(self, path, clock=time.time):
        self.path = path
        self._clock = clock
        self._index = {}  # role name -> index into state["roles"]
        self.state = {
            "status": "running",
            "preset": None,
            "started": None,
            "updated": None,
            "roles": [],
        }

    def _flush(self):
        self.state["updated"] = self._clock()
        try:
            parent = os.path.dirname(self.path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.state, fh, indent=2, sort_keys=True)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def start(self, preset=None):
        self.state["preset"] = preset
        self.state["started"] = self._clock()
        self.state["status"] = "running"
        self._flush()

    def _entry(self, role):
        idx = self._index.get(role)
        if idx is None:
            self.state["roles"].append(
                {"role": role, "status": "running", "ts": self._clock()}
            )
            self._index[role] = len(self.state["roles"]) - 1
            idx = self._index[role]
        return self.state["roles"][idx]

    def role_running(self, role):
        # A still-"running" earlier role completed when the next role started.
        for entry in self.state["roles"]:
            if entry["role"] != role and entry["status"] == "running":
                entry["status"] = "ok"
                entry["ts"] = self._clock()
        entry = self._entry(role)
        entry["status"] = "running"
        entry["ts"] = self._clock()
        self._flush()

    def role_failed(self, role):
        entry = self._entry(role)
        entry["status"] = "failed"
        entry["ts"] = self._clock()
        self.state["status"] = "failed"
        self._flush()

    def finish(self, failed):
        if failed:
            self.state["status"] = "failed"
        else:
            for entry in self.state["roles"]:
                if entry["status"] == "running":
                    entry["status"] = "ok"
                    entry["ts"] = self._clock()
            self.state["status"] = "completed"
        self._flush()


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "aggregate"
    CALLBACK_NAME = "xinas_install_state"
    CALLBACK_NEEDS_ENABLED = True

    def __init__(self):
        super().__init__()
        self._writer = _StateWriter(STATE_PATH)
        self._started = False
        # Only record during a real install run. The plugin is globally enabled,
        # but day-2 / partial playbook runs (e.g. the menu re-applying a single
        # role) must NOT overwrite install-state.json. autoinstall.sh and the
        # menu's full-install path export XINAS_RECORD_INSTALL_STATE=1.
        self._enabled = os.environ.get("XINAS_RECORD_INSTALL_STATE") == "1"

    @staticmethod
    def _role_name(task):
        try:
            role = task._role
            return role.get_name() if role else None
        except Exception:
            return None

    def v2_playbook_on_play_start(self, play):
        if not self._enabled:
            return
        preset = None
        try:
            vm = play.get_variable_manager()
            allvars = vm.get_vars(play=play) if vm else {}
            preset = allvars.get("xinas_install_preset") or allvars.get("preset")
        except Exception:
            preset = None
        if not self._started:
            self._writer.start(preset=preset)
            self._started = True

    def v2_playbook_on_task_start(self, task, is_conditional):
        if not self._enabled:
            return
        role = self._role_name(task)
        if role:
            self._writer.role_running(role)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        if not self._enabled or ignore_errors:
            return
        role = self._role_name(result._task)
        if role:
            self._writer.role_failed(role)

    def v2_playbook_on_stats(self, stats):
        if not self._enabled:
            return
        failed = bool(stats.failures or stats.dark)
        self._writer.finish(failed=failed)
