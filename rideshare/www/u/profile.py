"""/u/<username> — public driver profile."""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	username = frappe.form_dict.get("username") or context.path_components[-1]
	user_id = f"{username}@rideshare.local"
	if not frappe.db.exists("User", user_id):
		frappe.local.flags.redirect_location = "/"
		raise frappe.Redirect

	dp = frappe.db.get_value(
		"Driver Profile",
		{"user": user_id},
		[
			"full_name",
			"bio",
			"avg_rating",
			"total_trips",
			"is_verified",
			"preferences_smoking",
			"preferences_pets",
			"preferences_music",
			"preferences_chat",
		],
		as_dict=True,
	) or {}
	dp.setdefault("full_name", frappe.db.get_value("User", user_id, "full_name") or "Driver")
	dp.setdefault("avg_rating", 0)
	dp.setdefault("total_trips", 0)
	dp.setdefault("is_verified", 0)
	dp.setdefault("preferences_music", "Some")
	dp.setdefault("preferences_chat", "Some")

	upcoming = frappe.get_all(
		"Ride",
		filters={"driver": user_id, "status": "Published", "departure_datetime": [">=", frappe.utils.now_datetime()]},
		fields=["name", "origin_city", "destination_city", "departure_datetime",
		        "price_per_seat", "seats_total", "seats_available"],
		order_by="departure_datetime asc",
		limit_page_length=10,
	)

	context.title = dp["full_name"]
	context.driver = dp
	context.upcoming = upcoming
	context.first_name = frappe.db.get_value("User", frappe.session.user, "first_name") if frappe.session.user != "Guest" else None
	return context
