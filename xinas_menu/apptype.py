"""Typing-only mixins that narrow ``self.app`` for screens and widgets.

textual types ``DOMNode.app`` as ``App[object]``, so attributes defined on
our concrete app classes (``grpc``, ``nfs``, ``audit``, ...) are invisible
to type checkers. The textual FAQ idiom is to override the ``app`` property
with a narrowed return type; these mixins do that under ``TYPE_CHECKING``
only, so they are completely inert at runtime (empty classes in the MRO).

Usage::

    class RaidScreen(XiNASAppMixin, Screen):
        ...

The mixin must come *before* the textual base class so the narrowed
property wins attribute resolution for the type checker.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from xinas_menu.app import XiNASApp
    from xinas_menu.screens.startup.startup_menu import StartupApp

__all__ = ["StartupAppMixin", "XiNASAppMixin"]


class XiNASAppMixin:
    """Narrow ``self.app`` to :class:`XiNASApp` (management console)."""

    if TYPE_CHECKING:

        @property
        def app(self) -> XiNASApp: ...


class StartupAppMixin:
    """Narrow ``self.app`` to :class:`StartupApp` (provisioning app)."""

    if TYPE_CHECKING:

        @property
        def app(self) -> StartupApp: ...
