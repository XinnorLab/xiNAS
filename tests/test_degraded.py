from xinas_menu.api.degraded import degraded_banner


def test_returns_message_when_degraded_warning_present():
    env = {
        "result": [],
        "warnings": [{"code": "DEGRADED_BACKEND_UNAVAILABLE", "message": "xiRAID down"}],
    }
    assert degraded_banner(env) == "xiRAID down"


def test_none_when_no_degraded_warning():
    assert degraded_banner({"result": [], "warnings": []}) is None
    assert degraded_banner({"result": []}) is None
    assert degraded_banner({"warnings": [{"code": "OTHER", "message": "x"}]}) is None


def test_falls_back_when_message_missing():
    env = {"warnings": [{"code": "DEGRADED_BACKEND_UNAVAILABLE"}]}
    assert degraded_banner(env) == "Backend unavailable"
