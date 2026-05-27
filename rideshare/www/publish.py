"""/publish — Driver wizard to publish a ride."""

from __future__ import annotations

import json

import frappe


def get_context(context):
	context.no_cache = 1
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/rideshare/login?next=/publish"
		raise frappe.Redirect

	# If they don't have a Driver Profile yet, send them to onboarding.
	if not frappe.db.exists("Driver Profile", {"user": frappe.session.user}):
		frappe.local.flags.redirect_location = "/become-driver"
		raise frappe.Redirect

	context.title = "Publish a ride"
	cities = frappe.get_all(
		"City",
		filters={"is_active": 1},
		fields=["name as id", "city_name as label", "lat", "lng"],
		order_by="city_name asc",
		limit_page_length=200,
	)
	vehicles = frappe.get_all(
		"Vehicle",
		filters={"owner_user": frappe.session.user},
		fields=["name", "make", "model", "year", "color"],
		order_by="creation desc",
	)
	context.cities_json = json.dumps(cities)
	context.vehicles_json = json.dumps(vehicles)
	context.first_name = frappe.db.get_value("User", frappe.session.user, "first_name")
	return context
