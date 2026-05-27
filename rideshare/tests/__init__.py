"""Rideshare test suite.

We mirror the source tree:
- ``tests/utils/`` — pure-function unit tests (money, geo, encryption).
- ``tests/api/``   — endpoint tests (FrappeTestCase + frappe.client).
- ``tests/integration/`` — end-to-end flows that span multiple DocTypes.

Run all: ``bench --site dev.in run-tests --app rideshare``.
"""

from __future__ import annotations
