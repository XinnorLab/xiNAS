"""The Python update checker honours the GitHub token and names a rate limit
(docs/Installer/update-spec.md "GitHub rate limits and the access token").
"""

from __future__ import annotations

import email.message
import io
import subprocess
import urllib.error
from pathlib import Path

import pytest

from xinas_menu.utils import update_check as uc

# ── token resolution ─────────────────────────────────────────────────────────


def test_github_token_env_precedence(tmp_path):
    f = tmp_path / "tok"
    f.write_text("from-file\n")
    assert uc.github_token({"XINAS_GH_TOKEN": "a", "GITHUB_TOKEN": "b"}, path=f) == "a"
    assert uc.github_token({"GITHUB_TOKEN": "b"}, path=f) == "b"
    assert uc.github_token({}, path=f) == "from-file"


def test_github_token_file_first_line_trimmed_and_missing(tmp_path):
    f = tmp_path / "tok"
    f.write_text("  t \nsecond\n")
    assert uc.github_token({}, path=f) == "t"
    assert uc.github_token({}, path=tmp_path / "missing") is None
    (tmp_path / "empty").write_text("\n")
    assert uc.github_token({}, path=tmp_path / "empty") is None
    assert uc.github_token({"XINAS_GH_TOKEN": "  "}, path=tmp_path / "missing") is None


# ── HTTP error wording ───────────────────────────────────────────────────────


def _http_error(code: int, **headers: str) -> urllib.error.HTTPError:
    hdrs = email.message.Message()
    for k, v in headers.items():
        hdrs[k.replace("_", "-")] = v
    return urllib.error.HTTPError("https://api.github.com/x", code, "x", hdrs, io.BytesIO(b""))


def test_anonymous_rate_limit_names_reset_and_token():
    exc = _http_error(403, x_ratelimit_remaining="0", x_ratelimit_reset="1760000000")
    msg = uc._describe_http_error(exc, authenticated=False)
    assert msg.startswith("GitHub API rate limit exceeded for anonymous requests from this IP")
    assert "resets at 08:53 UTC" in msg  # 1760000000 = 2025-10-09 08:53:20 UTC
    assert "XINAS_GH_TOKEN" in msg and "/etc/xinas/github-token" in msg


def test_429_is_a_rate_limit_even_without_the_remaining_header():
    msg = uc._describe_http_error(_http_error(429), authenticated=False)
    assert "rate limit exceeded" in msg
    assert "resets at" not in msg


def test_token_rate_limit_names_the_token_and_drops_the_hint():
    exc = _http_error(403, x_ratelimit_remaining="0")
    msg = uc._describe_http_error(exc, authenticated=True)
    assert "for the configured token" in msg
    assert "XINAS_GH_TOKEN" not in msg


def test_403_with_remaining_quota_is_not_a_rate_limit():
    msg = uc._describe_http_error(_http_error(403, x_ratelimit_remaining="12"), authenticated=False)
    assert msg == "GitHub API HTTP 403"


def test_401_with_token_names_the_token():
    msg = uc._describe_http_error(_http_error(401), authenticated=True)
    assert msg.startswith("GitHub rejected the configured token (HTTP 401)")
    assert uc._describe_http_error(_http_error(401), authenticated=False) == "GitHub API HTTP 401"


def test_fetch_releases_surfaces_the_wording(monkeypatch):
    def boom(req, timeout):
        raise _http_error(403, x_ratelimit_remaining="0")

    monkeypatch.setattr(uc.urllib.request, "urlopen", boom)
    with pytest.raises(uc.UpdateCheckError, match="rate limit exceeded for anonymous"):
        uc._fetch_releases("XinnorLab/xiNAS", token=None)


class _Resp(io.BytesIO):
    headers = email.message.Message()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_releases_sends_bearer_when_token_given(monkeypatch):
    seen = {}

    def fake(req, timeout):
        seen["auth"] = req.get_header("Authorization")
        return _Resp(b"[]")

    monkeypatch.setattr(uc.urllib.request, "urlopen", fake)
    assert uc._fetch_releases("XinnorLab/xiNAS", token="tok") == []
    assert seen["auth"] == "Bearer tok"
    uc._fetch_releases("XinnorLab/xiNAS", token=None)
    assert seen["auth"] is None


# ── direct-git fallback carries the same helper ──────────────────────────────


def _capture_runs(monkeypatch, tmp_path, token):
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw.get("env")))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(uc.subprocess, "run", fake_run)
    monkeypatch.setattr(uc, "_PRIVILEGED_HELPER", tmp_path / "absent")
    monkeypatch.setattr(uc, "github_token", lambda: token)
    return calls


def test_fallback_fetch_passes_credential_helper_when_token_set(monkeypatch, tmp_path):
    calls = _capture_runs(monkeypatch, tmp_path, "s3kr3t-value")
    uc._privileged_git(tmp_path, "fetch")
    cmd, env = calls[0]
    helper = f"credential.helper={uc._GIT_CREDENTIAL_HELPER}"
    assert cmd[-4:] == ["fetch", "origin", "--tags", "--quiet"]
    assert "credential.helper=" in cmd and helper in cmd
    assert cmd.index("credential.helper=") < cmd.index(helper), "reset precedes ours"
    assert "s3kr3t-value" not in " ".join(cmd), "the token must never reach argv"
    assert env is not None and env["XINAS_GH_TOKEN"] == "s3kr3t-value"


def test_fallback_fetch_is_plain_without_a_token(monkeypatch, tmp_path):
    calls = _capture_runs(monkeypatch, tmp_path, None)
    uc._privileged_git(tmp_path, "fetch")
    cmd, env = calls[0]
    assert not any(a.startswith("credential.helper") for a in cmd)
    assert env is None


def test_fallback_checkout_never_carries_the_helper(monkeypatch, tmp_path):
    calls = _capture_runs(monkeypatch, tmp_path, "tok")
    uc._privileged_git(tmp_path, "checkout", "v9.9.9")
    assert not any(a.startswith("credential.helper") for a in calls[0][0])


def test_helper_string_matches_the_bash_block():
    """One helper text everywhere — the bash sites are pinned by
    tests/test_github_token_parity.py; this pins Python to the same text."""
    lib = (Path(__file__).resolve().parents[1] / "lib" / "menu_lib.sh").read_text()
    assert f"'credential.helper={uc._GIT_CREDENTIAL_HELPER}'" in lib
