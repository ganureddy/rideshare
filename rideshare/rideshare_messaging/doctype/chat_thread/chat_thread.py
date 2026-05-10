"""Chat Thread controller — keeps unread counters in sync.

A Chat Thread is either:

* ``thread_type = "Booking"`` — 1:1 between the ride's driver (publisher)
  and the passenger (booker).  Both `driver` and `passenger` are set;
  `booking` and `ride` link the conversation to a trip.
* ``thread_type = "Support"`` — between a single user (`passenger`) and
  the rideshare support pool.  `driver` is empty; any ``Support Agent``
  or ``Rideshare Admin`` may reply.

We deliberately keep messages in their own ``Chat Message`` doctype
rather than as a child table so we can paginate efficiently and so the
realtime layer can broadcast just the latest record.
"""

from __future__ import annotations

import frappe
from frappe.model.document import Document


class ChatThread(Document):
	def validate(self) -> None:
		self.subject = (self.subject or "").strip()[:240]
		if self.thread_type == "Booking":
			if not (self.driver and self.passenger):
				frappe.throw("Booking chat needs both driver and passenger.")
		elif self.thread_type == "Support":
			if not self.passenger:
				frappe.throw("Support chat needs a requester (passenger).")
