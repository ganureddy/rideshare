"""Sanity test for the public ``/api/method/rideshare.api.ping`` endpoint."""

from __future__ import annotations

from frappe.tests.utils import FrappeTestCase

from rideshare.api import ping


class TestPing(FrappeTestCase):
	def test_ping_returns_app_metadata(self):
		response = ping()
		self.assertEqual(response["app"], "rideshare")
		self.assertEqual(response["status"], "ok")
		self.assertTrue(response["version"])
