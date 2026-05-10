"""Booking flow.

`create_booking`  → creates a Pending Booking and a `Created` Payment
                   Transaction, returning the gateway order ID for the
                   client to checkout against.

`confirm_payment` → verifies the gateway signature, marks the booking
                   `Confirmed` + payment `Held`.  Idempotent on
                   gateway_payment_id.

`cancel_booking`  → applies the cancellation policy and creates a
                   Cancellation Log + refund Payment Transaction.

`my_bookings`     → list bookings for the current user.
"""

from __future__ import annotations

import json
import secrets

import frappe
from frappe import _
from frappe.utils import get_datetime, now_datetime, time_diff_in_hours

from rideshare.utils.money import rupees_to_paise
from rideshare.utils.payments import get_gateway


@frappe.whitelist()
def create_booking(
	ride: str,
	seats: int = 1,
	message: str | None = None,
) -> dict:
	"""Reserve seats and create a payment order.

	Returns the gateway order ID and key — the client uses this to launch
	checkout (or, in DEMO mode, just calls confirm_payment immediately).
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	ride_doc = frappe.get_doc("Ride", ride)
	if ride_doc.status not in ("Published",):
		frappe.throw(_("This ride is not bookable."))

	# Reuse a Pending booking by the same passenger if one exists for this
	# ride (avoids accidental double-rows on retry).
	existing = frappe.db.get_value(
		"Booking",
		{"ride": ride, "passenger": user, "status": "Pending"},
		"name",
	)
	if existing:
		booking = frappe.get_doc("Booking", existing)
		booking.seats_booked = int(seats)
		booking.passenger_message = message or booking.passenger_message
		booking.save(ignore_permissions=True)
	else:
		booking = frappe.new_doc("Booking")
		booking.ride = ride
		booking.passenger = user
		booking.seats_booked = int(seats)
		booking.passenger_message = message
		booking.status = "Pending"
		booking.payment_status = "Unpaid"
		booking.flags.ignore_permissions = True
		booking.insert(ignore_permissions=True)

	gw = get_gateway()
	amount_paise = rupees_to_paise(booking.total_amount)
	idem_key = secrets.token_hex(16)
	order = gw.create_order(
		amount_paise=amount_paise,
		currency=booking.currency or "INR",
		receipt=booking.name,
		notes={"booking": booking.name, "user": user},
	)

	txn = frappe.new_doc("Payment Transaction")
	txn.booking = booking.name
	txn.amount = booking.total_amount
	txn.currency = booking.currency or "INR"
	txn.gateway = gw.name
	txn.status = "Created"
	txn.gateway_order_id = order.order_id
	txn.idempotency_key = idem_key
	txn.raw_response = json.dumps(order.raw)
	txn.insert(ignore_permissions=True)
	frappe.db.commit()

	return {
		"booking": booking.name,
		"booking_code": booking.booking_code,
		"amount": booking.total_amount,
		"currency": booking.currency or "INR",
		"gateway": gw.name,
		"order_id": order.order_id,
		"key_id": frappe.db.get_single_value("Rideshare Settings", "razorpay_key_id") or "",
		"is_demo": gw.name == "demo",
	}


@frappe.whitelist()
def confirm_payment(
	booking: str,
	gateway_order_id: str,
	gateway_payment_id: str,
	gateway_signature: str | None = None,
) -> dict:
	"""Verify gateway signature and mark the booking Confirmed."""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	booking_doc = frappe.get_doc("Booking", booking)
	if booking_doc.passenger != user:
		frappe.throw(_("Not your booking."), frappe.PermissionError)

	# Idempotency: if we've already captured this gateway_payment_id,
	# return success without doing the work twice.
	existing = frappe.db.get_value(
		"Payment Transaction",
		{"gateway_payment_id": gateway_payment_id, "status": "Captured"},
		"name",
	)
	if existing:
		return {
			"booking": booking_doc.name,
			"status": booking_doc.status,
			"payment_status": booking_doc.payment_status,
			"already_captured": True,
		}

	gw = get_gateway()
	verification = gw.verify_signature(
		order_id=gateway_order_id,
		payment_id=gateway_payment_id,
		signature=gateway_signature or "",
	)
	if not verification.ok:
		_mark_payment_failed(booking_doc.name, gateway_order_id, verification.error)
		frappe.throw(_("Payment signature verification failed."))

	# Update the matching Created transaction.
	txn_name = frappe.db.get_value(
		"Payment Transaction",
		{"booking": booking_doc.name, "gateway_order_id": gateway_order_id},
		"name",
	)
	if txn_name:
		txn = frappe.get_doc("Payment Transaction", txn_name)
		txn.status = "Captured"
		txn.gateway_payment_id = gateway_payment_id
		txn.gateway_signature = gateway_signature
		txn.captured_on = now_datetime()
		txn.save(ignore_permissions=True)

	booking_doc.status = "Confirmed"
	booking_doc.payment_status = "Held"
	booking_doc.save(ignore_permissions=True)
	frappe.db.commit()

	return {
		"booking": booking_doc.name,
		"booking_code": booking_doc.booking_code,
		"status": booking_doc.status,
		"payment_status": booking_doc.payment_status,
	}


def _mark_payment_failed(booking_name: str, order_id: str, error: str | None) -> None:
	txn_name = frappe.db.get_value(
		"Payment Transaction", {"booking": booking_name, "gateway_order_id": order_id}, "name"
	)
	if not txn_name:
		return
	txn = frappe.get_doc("Payment Transaction", txn_name)
	txn.status = "Failed"
	txn.raw_response = json.dumps({"error": error or "unknown"})
	txn.save(ignore_permissions=True)


# ---------------------------------------------------------------------------
# Cancellation policy
# ---------------------------------------------------------------------------

POLICY_REFUND_TABLE = {
	"Flexible": [(2, 100), (0, 50)],   # ≥2h: 100%, <2h: 50%, drive-time: 0%
	"Moderate": [(24, 100), (2, 50), (0, 0)],
	"Strict": [(48, 100), (24, 50), (0, 0)],
}


def _refund_percentage(policy: str, hours_to_departure: float) -> int:
	rules = POLICY_REFUND_TABLE.get(policy, POLICY_REFUND_TABLE["Moderate"])
	for threshold, pct in rules:
		if hours_to_departure >= threshold:
			return pct
	return 0


@frappe.whitelist()
def cancel_booking(booking: str, reason: str | None = None) -> dict:
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	doc = frappe.get_doc("Booking", booking)
	if doc.passenger != user:
		frappe.throw(_("Not your booking."), frappe.PermissionError)
	if doc.status in ("Cancelled", "Completed"):
		return {"status": doc.status, "noop": True}

	ride = frappe.get_doc("Ride", doc.ride)
	hours = max(time_diff_in_hours(get_datetime(ride.departure_datetime), now_datetime()), 0)
	pct = _refund_percentage(ride.cancellation_policy or "Moderate", hours)
	return _refund_booking(doc.name, percentage=pct, reason=reason or "Passenger cancellation")


def _refund_booking(booking: str, *, percentage: int, reason: str) -> dict:
	doc = frappe.get_doc("Booking", booking)
	refund_amount = round(float(doc.total_amount or 0) * percentage / 100, 2)

	doc.status = "Cancelled"
	if percentage >= 100:
		doc.payment_status = "Refunded"
	elif percentage > 0:
		doc.payment_status = "Refunded"  # partial still flagged Refunded
	else:
		# Money stays Held → Released to driver as compensation.
		doc.payment_status = "Held"
	doc.save(ignore_permissions=True)

	log = frappe.new_doc("Cancellation Log")
	log.booking = doc.name
	log.cancelled_by = frappe.session.user
	log.refund_percentage = percentage
	log.refund_amount = refund_amount
	log.reason = reason
	log.insert(ignore_permissions=True)

	if refund_amount > 0:
		# Issue a refund Payment Transaction.
		gw = get_gateway()
		captured = frappe.db.get_value(
			"Payment Transaction",
			{"booking": doc.name, "status": "Captured"},
			["name", "gateway_payment_id"],
			as_dict=True,
		)
		if captured and captured.get("gateway_payment_id"):
			gw.refund(
				payment_id=captured["gateway_payment_id"],
				amount_paise=int(refund_amount * 100),
				notes={"booking": doc.name, "reason": reason},
			)
		refund_txn = frappe.new_doc("Payment Transaction")
		refund_txn.booking = doc.name
		refund_txn.amount = -refund_amount
		refund_txn.currency = doc.currency or "INR"
		refund_txn.gateway = gw.name
		refund_txn.status = "Refunded"
		refund_txn.idempotency_key = secrets.token_hex(16)
		refund_txn.raw_response = json.dumps({"reason": reason, "percentage": percentage})
		refund_txn.insert(ignore_permissions=True)

	frappe.db.commit()
	return {
		"booking": doc.name,
		"status": doc.status,
		"payment_status": doc.payment_status,
		"refund_percentage": percentage,
		"refund_amount": refund_amount,
	}


@frappe.whitelist()
def my_bookings() -> list[dict]:
	user = frappe.session.user
	if user == "Guest":
		return []
	rows = frappe.db.sql(
		"""SELECT b.name, b.ride, b.status, b.payment_status, b.seats_booked,
		          b.total_amount, b.currency, b.booking_code, b.booked_on,
		          r.origin_city, r.destination_city, r.departure_datetime,
		          r.estimated_arrival
		   FROM `tabBooking` b
		   JOIN `tabRide` r ON r.name = b.ride
		   WHERE b.passenger = %s
		   ORDER BY b.booked_on DESC
		   LIMIT 50""",
		user,
		as_dict=True,
	)
	return rows
