"""Shared pytest fixtures.

Re-exports the control-client stub-server fixture so any test module can
request `stub_socket` by parameter name without importing it (which would
shadow the parameter and trip ruff F811).
"""

from tests.test_control_client import stub_socket  # noqa: F401
