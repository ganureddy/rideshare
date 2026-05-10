"""Vehicle controller — validation + auto-verify in DEMO mode."""

from __future__ import annotations

import frappe
from frappe.model.document import Document


class Vehicle(Document):
	def validate(self) -> None:
		if not 1 <= int(self.seats_available or 0) <= 7:
			frappe.throw("Passenger seats must be between 1 and 7.")
		if self.year and not 1980 <= int(self.year) <= 2100:
			frappe.throw("Year must be between 1980 and 2100.")

		if frappe.db.get_single_value("Rideshare Settings", "auto_verify_drivers"):
			self.is_verified = 1
