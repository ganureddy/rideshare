"""/me/trips — passenger bookings + driver-published rides."""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?next=/me/trips"
		raise frappe.Redirect
	context.title = "My trips"
	context.first_name = frappe.db.get_value("User", frappe.session.user, "first_name")
	return context
