"""Homepage controller — exposes the user name to the navbar."""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	context.title = "Find a ride"
	context.first_name = (
		frappe.db.get_value("User", frappe.session.user, "first_name")
		if frappe.session.user != "Guest"
		else None
	)
	return context
