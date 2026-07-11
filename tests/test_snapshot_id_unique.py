"""Regression (#256): snapshot ids carry microsecond resolution so two
snapshots taken in the same wall-clock second (``snapshot_before`` then
``snapshot_after``) never collide.

Before the fix ``generate_snapshot_id`` stamped ids at 1-second resolution
(``%Y%m%dT%H%M%SZ``). A fast apply took both snapshots within the same second,
so the second id equalled the first and ``write_snapshot`` raised
``FileExistsError`` — aborting ``snapshot_after`` and (via the agent task
runner) wedging the whole apply.
"""

from __future__ import annotations

import datetime
import re
from unittest import mock

from xinas_history import models


def test_snapshot_id_has_microsecond_resolution():
    sid = models.generate_snapshot_id("raid_create")
    # YYYYMMDD 'T' HHMMSS(6) + ffffff(6) 'Z' '-' slug → 12 digits after 'T'.
    # A second-resolution id (the old bug) has only 6 digits there and would
    # NOT match, so this fullmatch pins the fix.
    assert re.fullmatch(r"\d{8}T\d{12}Z-raid-create", sid), sid


def test_same_second_ids_are_unique_and_chronologically_sortable():
    # Two creates in the SAME second but different microseconds — the exact
    # collision window. Build the fake times BEFORE patching so the real
    # datetime constructor is still available.
    t0 = datetime.datetime(2026, 7, 7, 18, 59, 54, 100_000, tzinfo=datetime.timezone.utc)
    t1 = datetime.datetime(2026, 7, 7, 18, 59, 54, 900_000, tzinfo=datetime.timezone.utc)

    with mock.patch.object(models, "datetime") as fake:
        fake.datetime.now.side_effect = [t0, t1]
        first = models.generate_snapshot_id("share_create")
        second = models.generate_snapshot_id("share_create")

    assert first != second
    # Both fall in the same wall-clock second ...
    assert first.startswith("20260707T185954")
    assert second.startswith("20260707T185954")
    # ... and lexicographic order still matches chronological order.
    assert first < second
