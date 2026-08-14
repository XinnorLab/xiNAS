"""Behavioral guard for the storage-state classifier (raid-spec.md §11).

`nvme_namespace/tasks/detect_storage_state.yml` is the read-only preflight that
decides whether a `site.yml` re-run converges (MATCH) or refuses to touch the
box (FOREIGN). Structural assertions over the task YAML cannot catch a wrong
*classification*, so this module replays the file's `set_fact` chain through
Jinja against synthetic probe output and asserts on the resulting
`xinas_storage_state`.

The bug this pins: MATCH used to mean nothing more than "the names 'data' and
'log' appear in `xicli raid show -f json`", so a degraded or offline array
classified as MATCH even though §11 and §4.2 both promise MATCH implies
*online*. §4.2 leans on that promise when it argues a single-namespace layout
can never legitimately reach the reuse path.

The replay mirrors Ansible's semantics closely enough for this file:

* every `ansible.builtin.set_fact` in the file is rendered in order;
* keys of one `set_fact` task are rendered against a snapshot taken *before*
  the task, because Ansible does not expose sibling keys to each other;
* templates are rendered with a native environment, so `{{ [...] }}` yields a
  real list, not its `str()`.

The handful of Ansible-only filters the file uses are re-implemented here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml

jinja2 = pytest.importorskip("jinja2")
from jinja2 import ChainableUndefined  # noqa: E402
from jinja2.nativetypes import NativeEnvironment  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
TASK_FILE = REPO / "collection/roles/nvme_namespace/tasks/detect_storage_state.yml"

SET_FACT = "ansible.builtin.set_fact"


# --- the Ansible filters the task file leans on ----------------------------


def _flatten(value: Any) -> list:
    out: list = []
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, list):
            out.extend(_flatten(item))
        else:
            out.append(item)
    return out


def _bool(value: Any) -> bool:
    """`ansible.builtin.bool`: tolerant of the string spellings Ansible stores."""
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "on", "1")
    return bool(value)


def _env() -> Any:
    env = NativeEnvironment(undefined=ChainableUndefined)
    env.filters["from_json"] = json.loads
    env.filters["flatten"] = _flatten
    env.filters["zip"] = lambda a, *rest: list(zip(a, *rest, strict=False))
    env.filters["bool"] = _bool
    return env


ENV = _env()


# --- the replay ------------------------------------------------------------


def _render(expr: Any, context: dict) -> Any:
    if not isinstance(expr, str):
        return expr
    return ENV.from_string(expr).render(**context)


def _set_fact_tasks() -> list[dict]:
    tasks = yaml.safe_load(TASK_FILE.read_text())
    out = []
    for task in tasks:
        if SET_FACT not in task:
            continue
        # The replay has no notion of conditionals or loops. If the file grows
        # one, fail loudly here rather than silently diverging from Ansible.
        unsupported = {k for k in ("when", "loop", "with_items") if k in task}
        assert not unsupported, f"replay cannot model {unsupported} on {task.get('name')!r}"
        out.append(task)
    assert out, "no set_fact tasks found — did the file move?"
    return out


def replay(
    raid_show: Any,
    *,
    fstype: str = "xfs",
    fslabel: str = "nfsdata",
    raid_rc: int = 0,
    wanted_label: str = "nfsdata",
) -> dict:
    """Replay the classifier against synthetic probe output, returning its facts.

    `raid_show` is the parsed payload `xicli raid show -f json` would print
    (serialized back to JSON for the replay), or a raw string for malformed
    output.
    """
    stdout = raid_show if isinstance(raid_show, str) else json.dumps(raid_show)
    context: dict[str, Any] = {
        "xfs_filesystems": [{"label": wanted_label}],
        "_ssd_raid_show": {"rc": raid_rc, "stdout": stdout},
        "_ssd_fstype": {"rc": 0, "stdout": fstype},
        "_ssd_fslabel": {"rc": 0, "stdout": fslabel},
    }
    for task in _set_fact_tasks():
        snapshot = dict(context)
        for key, expr in task[SET_FACT].items():
            context[key] = _render(expr, snapshot)
    return context


def classify(raid_show: Any, **kwargs: Any) -> str:
    state = replay(raid_show, **kwargs).get("xinas_storage_state")
    assert isinstance(state, str), f"classifier produced {state!r}"
    return state


# --- payload builders ------------------------------------------------------

ONLINE = ["online", "initialized"]


def mapping_payload(data_state: Any = ONLINE, log_state: Any = ONLINE, **extra: Any) -> dict:
    """The shape xicli emits on a real node: name -> record."""
    payload: dict[str, Any] = {
        "data": {"level": "5", "devices": [], "state": data_state},
        "log": {"level": "10", "devices": [], "state": log_state},
    }
    for name, state in extra.items():
        payload[name] = {"level": "0", "devices": [], "state": state}
    for record in payload.values():
        if record["state"] is None:
            del record["state"]
    return payload


def list_payload(data_state: Any = ONLINE, log_state: Any = ONLINE) -> list:
    """The list-of-records shape other releases / the fake transport emit."""
    return [
        {"name": "data", "level": "5", "devices": [], "state": data_state},
        {"name": "log", "level": "10", "devices": [], "state": log_state},
    ]


# --- MATCH requires online (the finding) -----------------------------------


def test_healthy_arrays_match():
    assert classify(mapping_payload()) == "MATCH"


@pytest.mark.parametrize(
    "state",
    [
        ["degraded"],
        ["offline"],
        ["degraded", "reconstructing"],
        ["online", "initializing"],
        ["need_recon"],
        ["broken"],
    ],
    ids=["degraded", "offline", "reconstructing", "initializing", "need_recon", "broken"],
)
def test_unhealthy_data_array_is_not_match(state):
    """An array that is not online must never reach the converge path."""
    assert classify(mapping_payload(data_state=state)) == "FOREIGN"


@pytest.mark.parametrize("state", [["degraded"], ["offline"]], ids=["degraded", "offline"])
def test_unhealthy_log_array_is_not_match(state):
    assert classify(mapping_payload(log_state=state)) == "FOREIGN"


def test_missing_state_field_is_not_match():
    """Fail closed: a record with no `state` at all is not evidence of health."""
    assert classify(mapping_payload(data_state=None)) == "FOREIGN"
    assert classify(mapping_payload(log_state=None)) == "FOREIGN"


def test_empty_state_list_is_not_match():
    assert classify(mapping_payload(data_state=[])) == "FOREIGN"


def test_unhealthy_array_survives_a_matching_filesystem():
    """The XFS signature on /dev/xi_data must not vouch for the array."""
    assert classify(mapping_payload(data_state=["degraded"]), fstype="xfs", fslabel="nfsdata") == (
        "FOREIGN"
    )


# --- tolerated spellings ---------------------------------------------------


def test_bare_string_state_is_tolerated():
    """Some releases emit `"state": "online"` rather than a list."""
    assert classify(mapping_payload(data_state="online", log_state="online")) == "MATCH"
    assert classify(mapping_payload(data_state="degraded")) == "FOREIGN"


def test_state_words_are_case_insensitive():
    assert classify(mapping_payload(data_state=["ONLINE"], log_state=["Online"])) == "MATCH"


def test_list_shape_payload_is_classified_the_same():
    assert classify(list_payload()) == "MATCH"
    assert classify(list_payload(data_state=["degraded"])) == "FOREIGN"
    assert classify(list_payload(log_state=["offline"])) == "FOREIGN"


def test_extra_healthy_array_does_not_block_match():
    assert classify(mapping_payload(scratch=ONLINE)) == "MATCH"


# --- the other states must not regress -------------------------------------


def test_fresh_box_is_empty():
    assert classify({}, fstype="", fslabel="") == "EMPTY"


def test_missing_expected_array_is_foreign():
    assert classify({"data": {"state": ONLINE}}) == "FOREIGN"
    assert classify({"tank": {"state": ONLINE}}) == "FOREIGN"


def test_wrong_filesystem_or_label_is_foreign():
    assert classify(mapping_payload(), fstype="ext4") == "FOREIGN"
    assert classify(mapping_payload(), fslabel="someone-elses") == "FOREIGN"


def test_label_comes_from_the_configured_filesystem():
    assert classify(mapping_payload(), fslabel="tank", wanted_label="tank") == "MATCH"
    assert classify(mapping_payload(), fslabel="nfsdata", wanted_label="tank") == "FOREIGN"


# --- probes that cannot answer never win MATCH -----------------------------
#
# The classifier may resolve an unanswerable probe to UNKNOWN, which outranks
# every other state. These assertions hold either way: what must never happen
# is a probe failure resolving to MATCH.


def test_failed_raid_probe_never_matches():
    assert classify({}, raid_rc=1) != "MATCH"
    assert classify("", raid_rc=1) != "MATCH"


def test_unparsable_raid_output_never_matches():
    """Malformed JSON with rc=0 must not converge — erroring out is fine too.

    Today the `from_json` in the parse step raises, which fails the task and
    stops the play before anything destructive runs. That is a valid outcome;
    resolving to MATCH is not.
    """
    try:
        state = classify("not json at all", raid_rc=0)
    except Exception:  # noqa: BLE001 - the play failing is an accepted outcome
        return
    assert state != "MATCH"


def test_junk_array_record_never_matches():
    assert classify({"data": "junk", "log": "junk"}) != "MATCH"
    assert classify(["junk", "junk"]) != "MATCH"


# --- an unhealthy array must not be reported as a foreign layout -----------
#
# A degraded array lands in FOREIGN, whose generic remedy is "set
# xinas_storage_reset=true to wipe and rebuild" — advice that would destroy a
# recoverable array. The classifier flags the case so both roles can fail with
# the right remedy instead.


def test_unhealthy_arrays_are_flagged_for_the_failure_message():
    facts = replay(mapping_payload(data_state=["degraded"]))
    assert facts["xinas_storage_state"] == "FOREIGN"
    assert facts["xinas_storage_arrays_unhealthy"] is True
    assert facts["xinas_storage_array_states"]["data"] == ["degraded"]


def test_a_genuinely_foreign_layout_is_not_flagged_as_unhealthy():
    assert replay({"tank": {"state": ONLINE}})["xinas_storage_arrays_unhealthy"] is False
    assert replay(mapping_payload(), fstype="ext4")["xinas_storage_arrays_unhealthy"] is False
    assert replay({}, fstype="", fslabel="")["xinas_storage_arrays_unhealthy"] is False


UNHEALTHY_FAIL = "Fail fast on an existing xiNAS layout whose arrays are not online"
FOREIGN_FAIL = "Fail fast on unexpected existing storage (FOREIGN"


def _tasks_of(role_task_file: str) -> list[dict]:
    """Every task in a role file, recursing into `block:` bodies."""
    out: list[dict] = []

    def walk(tasks):
        for task in tasks or []:
            if not isinstance(task, dict):
                continue
            out.append(task)
            if isinstance(task.get("block"), list):
                walk(task["block"])

    walk(yaml.safe_load((REPO / role_task_file).read_text()))
    return out


@pytest.mark.parametrize(
    "role_task_file",
    [
        "collection/roles/nvme_namespace/tasks/main.yml",
        "collection/roles/raid_fs/tasks/main.yml",
    ],
)
def test_unhealthy_array_failure_precedes_and_outranks_the_foreign_failure(role_task_file):
    names = [str(t.get("name", "")) for t in _tasks_of(role_task_file)]
    unhealthy = [i for i, n in enumerate(names) if n.startswith(UNHEALTHY_FAIL)]
    foreign = [i for i, n in enumerate(names) if n.startswith(FOREIGN_FAIL)]
    assert unhealthy, f"{role_task_file} has no unhealthy-array failure"
    assert foreign, f"{role_task_file} has no FOREIGN failure"
    assert unhealthy[0] < foreign[0], "the specific message must win over the generic one"


@pytest.mark.parametrize(
    "role_task_file",
    [
        "collection/roles/nvme_namespace/tasks/main.yml",
        "collection/roles/raid_fs/tasks/main.yml",
    ],
)
def test_unhealthy_array_failure_does_not_advise_a_reset(role_task_file):
    task = next(
        t for t in _tasks_of(role_task_file) if str(t.get("name", "")).startswith(UNHEALTHY_FAIL)
    )
    msg = task["ansible.builtin.fail"]["msg"]
    assert "Do NOT set xinas_storage_reset" in msg, msg
    guards = " ".join(str(w) for w in task["when"])
    assert "xinas_storage_arrays_unhealthy" in guards, guards
    assert "xinas_storage_reset" in guards, "an explicit reset must still be able to proceed"
