"""Lifecycle hooks for the Rideshare app.

Runs on `bench install-app rideshare`, on `bench migrate`, and before tests.
Idempotent by design — re-running must be a no-op.
"""

from __future__ import annotations

from typing import Final

import frappe

ROLES: Final[list[dict[str, object]]] = [
	{"role_name": "Rider", "desk_access": 0, "two_factor_auth": 0},
	{"role_name": "Driver", "desk_access": 0, "two_factor_auth": 0},
	{"role_name": "Verified Driver", "desk_access": 0, "two_factor_auth": 0},
	{"role_name": "Rideshare Admin", "desk_access": 1, "two_factor_auth": 1},
	{"role_name": "Support Agent", "desk_access": 1, "two_factor_auth": 0},
]

SEED_CITIES: Final[list[dict[str, object]]] = [
	{"city_name": "Delhi", "state": "Delhi", "lat": 28.6139, "lng": 77.2090},
	{"city_name": "Mumbai", "state": "Maharashtra", "lat": 19.0760, "lng": 72.8777},
	{"city_name": "Bangalore", "state": "Karnataka", "lat": 12.9716, "lng": 77.5946},
	{"city_name": "Hyderabad", "state": "Telangana", "lat": 17.3850, "lng": 78.4867},
	{"city_name": "Chennai", "state": "Tamil Nadu", "lat": 13.0827, "lng": 80.2707},
	{"city_name": "Kolkata", "state": "West Bengal", "lat": 22.5726, "lng": 88.3639},
	{"city_name": "Pune", "state": "Maharashtra", "lat": 18.5204, "lng": 73.8567},
	{"city_name": "Ahmedabad", "state": "Gujarat", "lat": 23.0225, "lng": 72.5714},
	{"city_name": "Jaipur", "state": "Rajasthan", "lat": 26.9124, "lng": 75.7873},
	{"city_name": "Surat", "state": "Gujarat", "lat": 21.1702, "lng": 72.8311},
	{"city_name": "Lucknow", "state": "Uttar Pradesh", "lat": 26.8467, "lng": 80.9462},
	{"city_name": "Kanpur", "state": "Uttar Pradesh", "lat": 26.4499, "lng": 80.3319},
	{"city_name": "Nagpur", "state": "Maharashtra", "lat": 21.1458, "lng": 79.0882},
	{"city_name": "Indore", "state": "Madhya Pradesh", "lat": 22.7196, "lng": 75.8577},
	{"city_name": "Bhopal", "state": "Madhya Pradesh", "lat": 23.2599, "lng": 77.4126},
	{"city_name": "Visakhapatnam", "state": "Andhra Pradesh", "lat": 17.6868, "lng": 83.2185},
	{"city_name": "Vadodara", "state": "Gujarat", "lat": 22.3072, "lng": 73.1812},
	{"city_name": "Patna", "state": "Bihar", "lat": 25.5941, "lng": 85.1376},
	{"city_name": "Ludhiana", "state": "Punjab", "lat": 30.9010, "lng": 75.8573},
	{"city_name": "Agra", "state": "Uttar Pradesh", "lat": 27.1767, "lng": 78.0081},
	{"city_name": "Coimbatore", "state": "Tamil Nadu", "lat": 11.0168, "lng": 76.9558},
	{"city_name": "Kochi", "state": "Kerala", "lat": 9.9312, "lng": 76.2673},
	{"city_name": "Chandigarh", "state": "Chandigarh", "lat": 30.7333, "lng": 76.7794},
	{"city_name": "Goa (Panaji)", "state": "Goa", "lat": 15.4909, "lng": 73.8278},
]


def after_install() -> None:
	_ensure_roles()
	_ensure_settings()
	_ensure_cities()
	frappe.db.commit()


def before_uninstall() -> None:
	pass


def before_tests() -> None:
	frappe.clear_cache()
	_ensure_roles()
	_ensure_settings()
	_ensure_cities()
	frappe.db.commit()


def _ensure_roles() -> None:
	for role in ROLES:
		if frappe.db.exists("Role", role["role_name"]):
			continue
		frappe.get_doc(
			{
				"doctype": "Role",
				"role_name": role["role_name"],
				"desk_access": role["desk_access"],
				"two_factor_auth": role["two_factor_auth"],
			}
		).insert(ignore_permissions=True)


def _ensure_settings() -> None:
	if not frappe.db.exists("DocType", "Rideshare Settings"):
		return
	doc = frappe.get_single("Rideshare Settings")
	# Touch defaults; .save() persists the singleton row if missing.
	doc.platform_fee_percent = doc.platform_fee_percent or 12
	doc.min_ride_price_per_km = doc.min_ride_price_per_km or 2
	doc.max_ride_price_per_km = doc.max_ride_price_per_km or 10
	doc.driver_payout_delay_hours = doc.driver_payout_delay_hours or 24
	doc.pending_booking_ttl_minutes = doc.pending_booking_ttl_minutes or 30
	doc.default_gateway = doc.default_gateway or "demo"
	doc.sms_provider = doc.sms_provider or "log"
	doc.maps_provider = doc.maps_provider or "OSM"
	doc.currency = doc.currency or "INR"
	doc.from_email = doc.from_email or "noreply@rideshare.local"
	if doc.auto_verify_drivers is None:
		doc.auto_verify_drivers = 1
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)


def _ensure_cities() -> None:
	if not frappe.db.exists("DocType", "City"):
		return
	for c in SEED_CITIES:
		if frappe.db.exists("City", c["city_name"]):
			continue
		frappe.get_doc(
			{
				"doctype": "City",
				"city_name": c["city_name"],
				"state": c["state"],
				"country": "India",
				"lat": c["lat"],
				"lng": c["lng"],
				"is_active": 1,
			}
		).insert(ignore_permissions=True)
