"""/rides/<ride_name> — public ride detail page."""

from __future__ import annotations

import json

import frappe


def get_context(context):
	context.no_cache = 1
	ride_name = frappe.form_dict.get("ride_name") or context.path_components[-1]
	if not frappe.db.exists("Ride", ride_name):
		frappe.local.flags.redirect_location = "/rides"
		raise frappe.Redirect

	from rideshare.api.search import get_ride

	data = get_ride(ride_name)
	context.ride = data["ride"]
	context.driver = data["driver"]
	context.vehicle = data["vehicle"]
	context.title = f"{data['ride'].origin_city} → {data['ride'].destination_city}"
	context.ride_json = json.dumps(data["ride"], default=str)
	return context
