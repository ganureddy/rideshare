"""User Push Token controller — minimal Document subclass.

We deliberately avoid hooking validation here: tokens are short-lived,
high-volume and rotate per-device, so the model stays a thin record and
all upsert / cleanup logic lives in :mod:`rideshare.utils.push`.
"""

from __future__ import annotations

from frappe.model.document import Document


class UserPushToken(Document):
	pass
