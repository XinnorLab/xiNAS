"""S12 T7: TUI adopt (make durable) path — adoptable gate + rollback body."""

from __future__ import annotations

from xinas_menu.screens.snapshot_detail import _snapshot_adoptable

# `stub_socket` is provided via tests/conftest.py.


def test_snapshot_adoptable_returns_true_when_api_says_so(stub_socket):
    """_snapshot_adoptable reads the API row's adoptable field."""
    from tests.test_control_client import ROUTES, client

    ROUTES[("GET", "/api/v1/config-history/snapshots/snap-adopt")] = (
        200,
        {"result": {"snapshot_id": "snap-adopt", "adoptable": True, "restorable": True}},
    )
    c = client(stub_socket)
    assert _snapshot_adoptable(c, "snap-adopt") is True


def test_snapshot_adoptable_returns_false_when_api_says_false(stub_socket):
    from tests.test_control_client import ROUTES, client

    ROUTES[("GET", "/api/v1/config-history/snapshots/snap-bare")] = (
        200,
        {"result": {"snapshot_id": "snap-bare", "adoptable": False, "restorable": True}},
    )
    c = client(stub_socket)
    assert _snapshot_adoptable(c, "snap-bare") is False


def test_snapshot_adoptable_returns_false_on_api_error(stub_socket):
    """API error (e.g. 404 or transport failure) → False (gate stays closed)."""
    from tests.test_control_client import ROUTES, client

    ROUTES[("GET", "/api/v1/config-history/snapshots/ghost")] = (
        404,
        {"errors": [{"code": "NOT_FOUND", "message": "no such snapshot"}]},
    )
    c = client(stub_socket)
    assert _snapshot_adoptable(c, "ghost") is False


def test_adopt_posts_body_with_adopt_true(stub_socket):
    """The adopt path posts {to, reason, adopt:True} with dangerous:True."""
    from tests.test_control_client import BODIES, ROUTES, client

    posts = {"n": 0}

    def rollback_post():
        posts["n"] += 1
        if posts["n"] == 1:
            return (
                200,
                {"result": {"plan_id": "p1", "state_revision_expected": 5, "blockers": []}},
            )
        return (202, {"result": {"task_id": "t2", "state": "queued"}})

    ROUTES[("POST", "/api/v1/config-history/rollback")] = rollback_post
    ROUTES[("GET", "/api/v1/tasks/t2")] = (200, {"result": {"task_id": "t2", "state": "success"}})

    result = client(stub_socket).plan_apply_wait(
        "POST",
        "/api/v1/config-history/rollback",
        {"to": "snap-adopt", "reason": "TUI adopt", "adopt": True},
        dangerous=True,
        poll_s=0.01,
    )
    assert result["state"] == "success"

    plan_bodies = [
        b
        for (_, p, b) in BODIES
        if p.endswith("/rollback") and b.get("mode") == "plan"
    ]
    assert plan_bodies[0]["spec"] == {
        "to": "snap-adopt",
        "reason": "TUI adopt",
        "adopt": True,
    }

    apply_bodies = [
        b
        for (_, p, b) in BODIES
        if p.endswith("/rollback") and b.get("mode") == "apply"
    ]
    assert apply_bodies[0]["dangerous"] is True


def test_non_adoptable_snapshot_gate_returns_false(stub_socket):
    """A snapshot without adoptable=True must return False from the gate
    (the UI must NOT offer the adopt path for non-adoptable snapshots)."""
    from tests.test_control_client import ROUTES, client

    # Restorable but NOT adoptable (pre-S12 snapshot)
    ROUTES[("GET", "/api/v1/config-history/snapshots/snap-old")] = (
        200,
        {
            "result": {
                "snapshot_id": "snap-old",
                "adoptable": False,
                "restorable": True,
            }
        },
    )
    c = client(stub_socket)
    assert _snapshot_adoptable(c, "snap-old") is False
