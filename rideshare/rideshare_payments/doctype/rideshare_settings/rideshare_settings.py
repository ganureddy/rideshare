"""Rideshare Settings — Single DocType controller."""

from __future__ import annotations

from frappe import _
from frappe.model.document import Document


class RideshareSettings(Document):
	def validate(self) -> None:
		if self.platform_fee_percent is None or not 0 <= float(self.platform_fee_percent) <= 100:
			from frappe import throw

			throw(_("Platform Fee % must be between 0 and 100."))
		if self.min_ride_price_per_km and self.max_ride_price_per_km:
			if float(self.min_ride_price_per_km) > float(self.max_ride_price_per_km):
				from frappe import throw

				throw(_("Min price per km cannot exceed max price per km."))
