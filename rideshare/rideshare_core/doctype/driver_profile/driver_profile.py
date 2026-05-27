"""Driver Profile controller — verification flow, role assignment."""

from __future__ import annotations

import frappe
from frappe.model.document import Document


class DriverProfile(Document):
	def validate(self) -> None:
		# Auto-verify in DEMO mode if Settings flag is on.
		auto = frappe.db.get_single_value("Rideshare Settings", "auto_verify_drivers")
		if auto and self.verification_status == "Pending":
			self.verification_status = "Verified"
			self.license_verified = 1
			self.id_verified = 1
		self.is_verified = 1 if self.verification_status == "Verified" else 0

	def on_update(self) -> None:
		_sync_driver_role(self.user, verified=bool(self.is_verified))

	def on_trash(self) -> None:
		_sync_driver_role(self.user, verified=False, remove=True)


def _sync_driver_role(user: str, *, verified: bool, remove: bool = False) -> None:
	"""Add/remove ``Driver`` and ``Verified Driver`` roles on the User.

	Mutates the ``roles`` child table in-place and saves once, with
	``ignore_permissions=True``, so this is safe to call from any context
	(including hooks running as a non-admin session user).
	"""

	if not user or not frappe.db.exists("User", user):
		return
	user_doc = frappe.get_doc("User", user)
	current = {r.role for r in user_doc.roles}

	desired: set[str] = set()
	if not remove:
		desired.add("Driver")
		if verified:
			desired.add("Verified Driver")

	to_remove = {"Driver", "Verified Driver"} - desired
	to_add = desired - current

	if not to_remove and not to_add:
		return  # No-op.

	# Mutate the child table directly to avoid the inner save in remove_roles.
	user_doc.roles = [r for r in user_doc.roles if r.role not in to_remove]
	for role in to_add:
		user_doc.append("roles", {"role": role})

	user_doc.flags.ignore_permissions = True
	user_doc.flags.ignore_validate_update_after_submit = True
	user_doc.save(ignore_permissions=True)
