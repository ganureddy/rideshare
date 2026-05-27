"""City lookup DocType — used as origin/destination/waypoint references."""

from __future__ import annotations

import re

import frappe
from frappe.model.document import Document


def slugify(value: str) -> str:
	value = (value or "").strip().lower()
	value = re.sub(r"[^a-z0-9]+", "-", value)
	return value.strip("-") or "city"


class City(Document):
	def validate(self) -> None:
		if self.lat is not None and not -90 <= float(self.lat) <= 90:
			frappe.throw("Latitude must be between -90 and 90.")
		if self.lng is not None and not -180 <= float(self.lng) <= 180:
			frappe.throw("Longitude must be between -180 and 180.")

	def before_save(self) -> None:
		base = slugify(self.city_name)
		if not self.slug or self.slug.startswith(base) is False:
			candidate = base
			n = 1
			while frappe.db.exists("City", {"slug": candidate, "name": ["!=", self.name]}):
				n += 1
				candidate = f"{base}-{n}"
			self.slug = candidate
