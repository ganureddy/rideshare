"""Patch — install rider rating + CO2 + nudges custom fields on User.

Adds the small set of denormalised aggregates we use across the app
(rider rating shown in chat headers, CO2 saved widget on Profile,
last_active for presence — already added separately).

Also indexes Ride Review for fast aggregate scans at scale.

Idempotent — safe to re-run.
"""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute() -> None:
	create_custom_fields(
		{
			"User": [
				{
					"fieldname": "rider_avg_rating",
					"fieldtype": "Float",
					"label": "Rider Avg Rating",
					"insert_after": "user_image",
					"read_only": 1,
					"default": "0",
					"description": "Average of all driver-to-passenger reviews on this user (0 means no reviews yet).",
				},
				{
					"fieldname": "rider_total_reviews",
					"fieldtype": "Int",
					"label": "Rider Total Reviews",
					"insert_after": "rider_avg_rating",
					"read_only": 1,
					"default": "0",
				},
				{
					"fieldname": "co2_saved_kg",
					"fieldtype": "Float",
					"label": "CO2 Saved (kg)",
					"insert_after": "rider_total_reviews",
					"read_only": 1,
					"default": "0",
					"description": "Aggregate kilograms of CO2 saved across all completed shared rides — recomputed by a scheduler job.",
				},
			]
		},
		ignore_validate=True,
		update=True,
	)

	# Index Ride Review for the AVG/COUNT aggregate queries — once a
	# driver has hundreds of reviews this matters.
	if frappe.db.table_exists("Ride Review"):
		for fields in (["ratee", "direction"], ["booking", "direction"], ["ride"]):
			try:
				frappe.db.add_index("Ride Review", fields)
			except Exception:
				frappe.log_error(
					title=f"Ride Review index failed: {fields}",
					message=frappe.get_traceback(),
				)
