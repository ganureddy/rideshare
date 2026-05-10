"""Driver onboarding — Driver Profile and Vehicle creation.

Single happy-path: user fills the wizard, we upsert their Driver Profile
and create a Vehicle row.  The auto-verify flag in Rideshare Settings
(default ON in DEMO mode) flips them to ``Verified`` immediately.
"""

from __future__ import annotations

import frappe
from frappe import _


@frappe.whitelist()
def upsert_driver_profile(
	full_name: str | None = None,
	bio: str | None = None,
	license_number: str | None = None,
	license_expiry: str | None = None,
	preferences_smoking: int = 0,
	preferences_pets: int = 0,
	preferences_music: str = "Some",
	preferences_chat: str = "Some",
) -> dict:
	"""Create or update the calling user's Driver Profile."""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	if full_name:
		user_doc = frappe.get_doc("User", user)
		user_doc.full_name = full_name
		first, _, last = full_name.partition(" ")
		user_doc.first_name = first
		user_doc.last_name = last
		user_doc.flags.ignore_permissions = True
		user_doc.save(ignore_permissions=True)

	existing = frappe.db.get_value("Driver Profile", {"user": user}, "name")
	if existing:
		profile = frappe.get_doc("Driver Profile", existing)
	else:
		profile = frappe.new_doc("Driver Profile")
		profile.user = user

	profile.bio = bio or profile.bio
	if license_number:
		profile.license_number = license_number
	if license_expiry:
		profile.license_expiry = license_expiry
	profile.preferences_smoking = int(preferences_smoking or 0)
	profile.preferences_pets = int(preferences_pets or 0)
	profile.preferences_music = preferences_music or "Some"
	profile.preferences_chat = preferences_chat or "Some"

	profile.flags.ignore_permissions = True
	profile.save(ignore_permissions=True)
	frappe.db.commit()

	return {
		"name": profile.name,
		"verification_status": profile.verification_status,
		"is_verified": bool(profile.is_verified),
	}


@frappe.whitelist()
def upsert_vehicle(
	make: str,
	model: str,
	year: int,
	seats_available: int,
	color: str | None = None,
	license_plate: str | None = None,
	vehicle: str | None = None,
) -> dict:
	"""Create or update a Vehicle owned by the calling user."""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	if vehicle:
		doc = frappe.get_doc("Vehicle", vehicle)
		if doc.owner_user != user:
			frappe.throw(_("Not your vehicle."), frappe.PermissionError)
	else:
		doc = frappe.new_doc("Vehicle")
		doc.owner_user = user

	doc.make = make
	doc.model = model
	doc.year = int(year)
	doc.seats_available = int(seats_available)
	doc.color = color
	if license_plate:
		doc.license_plate = license_plate

	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	frappe.db.commit()

	return {
		"name": doc.name,
		"make": doc.make,
		"model": doc.model,
		"is_verified": bool(doc.is_verified),
	}


@frappe.whitelist()
def my_vehicles() -> list[dict]:
	user = frappe.session.user
	if user == "Guest":
		return []
	return frappe.get_all(
		"Vehicle",
		filters={"owner_user": user},
		fields=["name", "make", "model", "year", "color", "seats_available", "is_verified"],
		order_by="creation desc",
	)
