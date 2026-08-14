"""Shared pytest fixtures.

Re-exports the control-client stub-server fixture so any test module can
request `stub_socket` by parameter name without importing it (which would
shadow the parameter and trip ruff F811).
"""

import os
import pytest

from tests.test_control_client import stub_socket  # noqa: F401


@pytest.fixture(autouse=True)
def _mock_path_exists(monkeypatch):
    """Make os.path.isdir return True for export paths in tests.

    This allows tests to verify filesystem operations without needing
    actual paths to exist. Specifically handles /mnt paths while
    preserving normal behavior for /proc paths.
    """
    original_isdir = os.path.isdir

    def mock_isdir(path):
        # Convert to string to handle both str and Path objects
        path_str = str(path)
        # For test paths like /mnt/data or /srv, return True
        if path_str.startswith("/mnt") or path_str.startswith("/srv"):
            return True
        # For /proc paths, use original behavior (will return False)
        return original_isdir(path)

    monkeypatch.setattr(os.path, "isdir", mock_isdir)
