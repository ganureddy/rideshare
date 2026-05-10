"""Mobile login page — overrides Frappe's default /login while logged out."""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	if frappe.session.user != "Guest":
		frappe.local.flags.redirect_location = "/me"
		raise frappe.Redirect
	context.title = "Log in"
	return context
