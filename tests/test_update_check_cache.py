"""The TUI's background check reuses a cached Releases payload for an hour and
an explicit check revalidates it with an ETag (docs/Installer/update-spec.md
"Fewer requests from the TUI"). The cache never changes the verdict — it holds
the payload GitHub returned.
"""

from __future__ import annotations

import asyncio
import email.message
import io
import json
import urllib.error
from pathlib import Path

from xinas_menu.utils import update_check as uc


class _FakeGitHub:
    """Counts requests; answers a fixed payload with an ETag, or 304 when the
    request carries a matching If-None-Match."""

    def __init__(self, releases, etag='"e1"'):
        self.releases = releases
        self.etag = etag
        self.requests = []

    def __call__(self, req, timeout):
        self.requests.append(req)
        if req.get_header("If-none-match") == self.etag:
            hdrs = email.message.Message()
            raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", hdrs, io.BytesIO(b""))
        hdrs = email.message.Message()
        hdrs["ETag"] = self.etag

        class _Resp(io.BytesIO):
            headers = hdrs

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return _Resp(json.dumps(self.releases).encode())


def _rel(tag):
    return {
        "tag_name": tag,
        "draft": False,
        "prerelease": False,
        "body": "",
        "html_url": "",
        "assets": [],
    }


def test_fresh_cache_serves_the_background_check_without_a_request(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    clock = [1000.0]
    kw = dict(cache=cache, installed="3.1.0", now=lambda: clock[0])
    assert uc._fetch_releases("r", max_age=3600, **kw) == [_rel("v9.9.9")]
    assert len(gh.requests) == 1
    clock[0] += 1800
    assert uc._fetch_releases("r", max_age=3600, **kw) == [_rel("v9.9.9")]
    assert len(gh.requests) == 1, "within the TTL the cache answers"
    clock[0] += 1801
    uc._fetch_releases("r", max_age=3600, **kw)
    assert len(gh.requests) == 2, "past the TTL GitHub is asked again"


def test_cache_is_keyed_to_the_installed_version(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    uc._fetch_releases("r", max_age=3600, cache=cache, installed="3.1.0", now=lambda: 1000.0)
    uc._fetch_releases("r", max_age=3600, cache=cache, installed="3.2.0", now=lambda: 1001.0)
    assert len(gh.requests) == 2


def test_forced_check_revalidates_with_etag_and_304_reuses_the_payload(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1000.0)
    out = uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1500.0)
    assert out == [_rel("v9.9.9")]
    assert len(gh.requests) == 2
    assert gh.requests[1].get_header("If-none-match") == '"e1"'
    saved = cache.load()
    assert saved is not None and saved.checked_at == 1500.0, "a 304 refreshes the cache age"


def test_changed_payload_replaces_the_cache(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1000.0)
    gh.releases = [_rel("v10.0.0")]
    gh.etag = '"e2"'
    out = uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1001.0)
    assert out == [_rel("v10.0.0")]
    saved = cache.load()
    assert saved is not None and saved.etag == '"e2"'


def test_cache_write_and_read_failures_are_ignored(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    blocker = tmp_path / "file"
    blocker.write_text("")
    cache = uc.ReleaseCache(blocker / "c.json")  # parent is a file → OSError
    out = uc._fetch_releases("r", max_age=3600, cache=cache, installed="3.1.0")
    assert out == [_rel("v9.9.9")]
    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not json")
    assert uc.ReleaseCache(corrupt).load() is None


def test_cache_file_is_private(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    path = tmp_path / "c.json"
    uc._fetch_releases("r", cache=uc.ReleaseCache(path), installed="3.1.0")
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_checker_background_uses_cache_and_force_bypasses_it(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    monkeypatch.setattr(uc, "github_token", lambda: None)
    checker = uc.UpdateChecker(current_version="3.1.0", cache_path=tmp_path / "c.json")
    r1 = asyncio.run(checker.check())
    r2 = asyncio.run(checker.check())
    assert r1.available and r2.available and r1.latest_version == "v9.9.9"
    assert len(gh.requests) == 1
    r3 = asyncio.run(checker.check(force=True))
    assert r3.available and len(gh.requests) == 2


def test_default_cache_path_root_vs_user(monkeypatch, tmp_path):
    monkeypatch.setattr(uc.os, "geteuid", lambda: 0)
    assert uc.default_cache_path() == Path("/var/cache/xinas/update-check.json")
    monkeypatch.setattr(uc.os, "geteuid", lambda: 1000)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    assert uc.default_cache_path() == tmp_path / "xdg" / "xinas" / "update-check.json"
    monkeypatch.delenv("XDG_CACHE_HOME")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert uc.default_cache_path() == tmp_path / "home" / ".cache" / "xinas" / "update-check.json"


def test_explicit_check_call_sites_force():
    """The three user-initiated checks must revalidate; only the on-mount
    background check may be served from the cache."""
    root = Path(__file__).resolve().parents[1] / "xinas_menu"
    for rel in ("screens/management.py", "screens/mcp.py", "screens/startup/advanced_screen.py"):
        src = (root / rel).read_text()
        assert "_update_checker.check(force=True)" in src, f"{rel}: explicit check must force"
    app = (root / "app.py").read_text()
    assert "_update_checker.check()" in app, "the on-mount background check stays cached"
