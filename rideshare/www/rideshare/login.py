"""Rideshare end-user (phone-number) login served at ``/rideshare/login``.

This is the public, mobile-first sign-in page for riders and drivers.
Frappe's standard email/password backend login is left untouched on
``/login`` so admins/staff can still reach Desk.
"""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	if frappe.session.user != "Guest":
		frappe.local.flags.redirect_location = "/me"
		raise frappe.Redirect
	context.title = "Log in"
	return context
