"""Verify Phase 1 install side-effects (roles)."""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from rideshare.install import ROLES, _ensure_roles


class TestInstall(FrappeTestCase):
	def test_all_roles_exist_after_install(self):
		_ensure_roles()
		for role in ROLES:
			self.assertTrue(
				frappe.db.exists("Role", role["role_name"]),
				f"Role missing: {role['role_name']}",
			)

	def test_ensure_roles_is_idempotent(self):
		_ensure_roles()
		count_first = frappe.db.count("Role", filters={"role_name": "Rideshare Admin"})
		_ensure_roles()
		count_second = frappe.db.count("Role", filters={"role_name": "Rideshare Admin"})
		self.assertEqual(count_first, count_second)
