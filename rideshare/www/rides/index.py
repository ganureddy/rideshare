"""/rides — public search results page."""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	context.title = "Search rides"
	context.origin = frappe.form_dict.get("origin", "")
	context.destination = frappe.form_dict.get("destination", "")
	context.date = frappe.form_dict.get("date", "")
	context.seats = int(frappe.form_dict.get("seats") or 1)
	return context
