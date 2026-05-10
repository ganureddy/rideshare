"""/me — logged-in user dashboard."""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?next=/me"
		raise frappe.Redirect

	user = frappe.get_doc("User", frappe.session.user)
	context.title = "My account"
	context.first_name = user.first_name
	context.mobile_no = user.mobile_no
	context.roles = [r for r in frappe.get_roles(user.name) if r in (
		"Rider", "Driver", "Verified Driver", "Rideshare Admin", "Support Agent"
	)]

	dp = frappe.db.get_value(
		"Driver Profile", {"user": user.name}, ["name", "is_verified"], as_dict=True
	) or {}
	context.is_verified = bool(dp.get("is_verified"))
	context.driver_profile = dp
	return context
