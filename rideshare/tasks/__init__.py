"""Rideshare scheduled tasks.

Each callable is registered in `hooks.py:scheduler_events`.  We split by
cadence so failures in one cadence (e.g. an hourly escrow sweep)
do not stall daily cleanups.
"""

from __future__ import annotations
