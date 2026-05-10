"""/become-driver — onboarding wizard."""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?next=/become-driver"
		raise frappe.Redirect
	context.title = "Become a driver"
	context.first_name = frappe.db.get_value("User", frappe.session.user, "first_name")
	return context
