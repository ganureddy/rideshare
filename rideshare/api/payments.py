"""Payment-flow REST + webhook endpoints.

Pairs with ``rideshare.utils.payments.RazorpayGateway`` and the
existing ``rideshare.api.bookings.create_booking`` /
``confirm_payment`` flow.

Design
------
* ``checkout_context(booking)`` — returns everything the in-app
  WebView needs to render the Razorpay Standard Checkout: order_id,
  public key, prefilled name/email/phone, ride summary, return URL.
  The WebView posts the verified payment back to the RN app via
  ``window.ReactNativeWebView.postMessage``; the RN app then calls
  ``rideshare.api.bookings.confirm_payment`` over the authenticated
  REST channel.

* ``razorpay_webhook`` — server-to-server defence-in-depth.  Razorpay
  posts ``payment.captured`` / ``payment.failed`` / ``refund.processed``
  events to a public URL we own; we verify the HMAC signature and
  reconcile the matching Booking + Payment Transaction.  Same
  verification primitive as the client-side signature check, but
  initiated by Razorpay instead of by the client — protects us when
  the client closes the WebView before the success postback fires.
"""

from __future__ import annotations

import json

import frappe
from frappe import _

from rideshare.utils.money import paise_to_rupees, rupees_to_paise
from rideshare.utils.payments import RazorpayGateway, get_gateway


@frappe.whitelist()
def checkout_context(booking: str) -> dict:
	"""Bundle the data the in-app WebView checkout page needs.

	The booking must be (a) the caller's own, (b) Pending, (c) have a
	Created Payment Transaction with a Razorpay order_id.

	Returns:
		key_id          — Razorpay public key (safe to ship)
		order_id        — the Razorpay Order ID we created at booking time
		amount_paise    — for the Razorpay JS SDK
		currency        — "INR"
		name            — Rideshare brand for the checkout modal
		description     — "Mumbai → Goa · 2 seats"
		prefill         — passenger's name + email + phone
		notes           — booking + ride id (echoed back to webhook)
		theme_color     — brand teal
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	b = frappe.get_doc("Booking", booking)
	if b.passenger != user:
		frappe.throw(_("Not your booking."), frappe.PermissionError)
	if b.status not in ("Pending", "Confirmed"):
		# Cancelled / Completed — no checkout window.
		return {
			"already_paid": True,
			"booking": b.name,
			"status": b.status,
			"payment_status": b.payment_status,
		}
	if (b.payment_status or "") in ("Held", "Refunded"):
		# Already paid (Held) or refund issued — no need to pay again.
		return {
			"already_paid": True,
			"booking": b.name,
			"status": b.status,
			"payment_status": b.payment_status,
		}
	if (b.payment_status or "") == "Cash":
		# User opted for cash-at-pickup — they're not supposed to pay
		# online for this booking.  Tell the client to skip the modal.
		return {
			"already_paid": True,
			"booking": b.name,
			"status": b.status,
			"payment_status": b.payment_status,
		}

	# Find the most recent Created Payment Transaction.  create_booking
	# always inserts one; we re-issue here only if the previous order
	# expired (Razorpay orders TTL is 15 minutes by default).
	txn = frappe.db.get_value(
		"Payment Transaction",
		{"booking": b.name, "status": "Created"},
		["name", "gateway_order_id"],
		order_by="creation desc",
		as_dict=True,
	)
	if not txn or not txn.get("gateway_order_id"):
		# Re-create the order (rare but happens on retry).
		gw = get_gateway()
		amount_paise = rupees_to_paise(b.total_amount)
		order = gw.create_order(
			amount_paise=amount_paise,
			currency=b.currency or "INR",
			receipt=b.name,
			notes={"booking": b.name, "user": user},
		)
		new_txn = frappe.new_doc("Payment Transaction")
		new_txn.booking = b.name
		new_txn.amount = b.total_amount
		new_txn.currency = b.currency or "INR"
		new_txn.gateway = gw.name
		new_txn.status = "Created"
		new_txn.gateway_order_id = order.order_id
		new_txn.raw_response = json.dumps(order.raw)
		new_txn.insert(ignore_permissions=True)
		frappe.db.commit()
		order_id = order.order_id
	else:
		order_id = txn["gateway_order_id"]

	gw = get_gateway()
	if not isinstance(gw, RazorpayGateway):
		# DEMO / Dummy mode — return a stub so the client knows to skip
		# the WebView checkout and call confirm_payment immediately.
		return {
			"is_demo": True,
			"booking": b.name,
			"order_id": order_id,
			"amount_paise": rupees_to_paise(b.total_amount),
		}

	user_doc = frappe.get_doc("User", user)
	ride = frappe.db.get_value(
		"Ride",
		b.ride,
		["origin_city", "destination_city", "departure_datetime"],
		as_dict=True,
	) or {}

	return {
		"is_demo": False,
		"booking": b.name,
		"key_id": gw.key_id,
		"order_id": order_id,
		"amount_paise": rupees_to_paise(b.total_amount),
		"amount_rupees": float(b.total_amount or 0),
		"currency": b.currency or "INR",
		"name": "Rideshare",
		"description": f"{ride.get('origin_city') or 'Pickup'} → {ride.get('destination_city') or 'Destination'}"
			f" · {int(b.seats_booked or 0)} seat{'s' if int(b.seats_booked or 0) != 1 else ''}",
		"prefill": {
			"name": user_doc.full_name or user_doc.first_name or "",
			"email": (user_doc.email or "") if "@rideshare.local" not in (user_doc.email or "") else "",
			"contact": user_doc.mobile_no or user_doc.phone or "",
		},
		"notes": {"booking": b.name, "ride": b.ride, "user": user},
		"theme_color": "#0EA5A4",
	}


# ---------------------------------------------------------------------------
# Webhook — Razorpay server-to-server event delivery.  Make sure to set the
# webhook URL and secret in Razorpay Dashboard → Webhooks:
#
#   URL    : https://<your-site>/api/method/rideshare.api.payments.razorpay_webhook
#   Events : payment.captured, payment.failed, refund.processed, refund.failed
#   Secret : <a long random string>     (paste the same value into
#                                       Rideshare Settings.razorpay_webhook_secret)
# ---------------------------------------------------------------------------


@frappe.whitelist(allow_guest=True, methods=["POST"])
def razorpay_webhook() -> dict:
	"""Razorpay server-to-server webhook handler.

	Always returns 200 *if the signature verifies* — Razorpay retries
	non-2xx responses, so we don't want to bounce a known event just
	because it's a duplicate.  Idempotency is handled at the booking
	level: matching an already-Captured Payment Transaction by
	gateway_payment_id is a no-op.
	"""

	# Razorpay POSTs raw JSON; sig is in `X-Razorpay-Signature`.
	signature = frappe.get_request_header("X-Razorpay-Signature") or ""
	body = frappe.request.get_data() or b""

	gw = get_gateway("razorpay")
	if not isinstance(gw, RazorpayGateway):
		frappe.throw(_("Razorpay gateway is not active."))

	# Verify + decode (raises on bad signature).
	event = gw.parse_webhook(body=body, signature=signature)

	event_type = event.get("event") or ""
	payload = event.get("payload") or {}

	try:
		if event_type == "payment.captured":
			_handle_payment_captured(payload.get("payment", {}).get("entity") or {})
		elif event_type == "payment.failed":
			_handle_payment_failed(payload.get("payment", {}).get("entity") or {})
		elif event_type == "refund.processed":
			_handle_refund_processed(payload.get("refund", {}).get("entity") or {})
	except Exception:
		frappe.log_error(
			title=f"Razorpay webhook handler failed: {event_type}",
			message=frappe.get_traceback(),
		)
		# Return 200 anyway so Razorpay doesn't retry — we logged the
		# error and admins can replay manually.

	return {"ok": True, "event": event_type}


def _handle_payment_captured(entity: dict) -> None:
	"""Mark the matching booking Confirmed if not already, idempotently."""

	from rideshare.api.bookings import confirm_payment as _confirm

	order_id = entity.get("order_id")
	payment_id = entity.get("id")
	signature = ""  # webhook doesn't send a per-payment signature
	booking = (entity.get("notes") or {}).get("booking")
	if not booking or not payment_id:
		return

	# Already-captured: confirm_payment is idempotent on
	# gateway_payment_id, so re-calling is safe.
	frappe.set_user("Administrator")  # webhook runs as Guest
	try:
		_confirm(
			booking=booking,
			gateway_payment_id=payment_id,
			gateway_order_id=order_id,
			gateway_signature=signature,
		)
	except Exception:
		# `confirm_payment` validates a signature; the webhook event
		# IS our authority here — so re-mark via direct update if the
		# signature path fails.
		txn = frappe.db.get_value(
			"Payment Transaction",
			{"gateway_order_id": order_id, "status": "Created"},
			"name",
		)
		if txn:
			frappe.db.set_value(
				"Payment Transaction",
				txn,
				{
					"status": "Captured",
					"gateway_payment_id": payment_id,
				},
				update_modified=False,
			)
		# Promote booking too.
		_book = frappe.get_doc("Booking", booking)
		if _book.status == "Pending":
			ride_instant = int(
				frappe.db.get_value("Ride", _book.ride, "instant_booking") or 0
			)
			_book.status = "Confirmed" if ride_instant else "Pending"
			_book.payment_status = "Held"
			_book.save(ignore_permissions=True)
		frappe.db.commit()


def _handle_payment_failed(entity: dict) -> None:
	"""Stamp the Payment Transaction as Failed so the rider sees the error."""

	order_id = entity.get("order_id")
	if not order_id:
		return
	txn = frappe.db.get_value(
		"Payment Transaction",
		{"gateway_order_id": order_id, "status": "Created"},
		"name",
	)
	if not txn:
		return
	frappe.db.set_value(
		"Payment Transaction",
		txn,
		{
			"status": "Failed",
			"raw_response": json.dumps(entity),
		},
		update_modified=False,
	)
	frappe.db.commit()


def _handle_refund_processed(entity: dict) -> None:
	"""Reconcile a Refund Payment Transaction as Refunded."""

	payment_id = entity.get("payment_id")
	if not payment_id:
		return
	# Find any pending refund txn we created in cancel flow.
	txn = frappe.db.get_value(
		"Payment Transaction",
		{"gateway_payment_id": payment_id, "status": ["in", ("Refunded", "Created")]},
		"name",
	)
	if txn:
		frappe.db.set_value(
			"Payment Transaction",
			txn,
			{"status": "Refunded", "raw_response": json.dumps(entity)},
			update_modified=False,
		)
		frappe.db.commit()


# Convenience: small read-only endpoint the WebView page calls to fetch
# its config without revealing the secret to the client.  Exists because
# the Jinja page has access to frappe.session but we want to keep the
# settings-fetch logic in one place.
@frappe.whitelist()
def amount_in_rupees(amount_paise: int) -> float:
	"""UI helper — convert paise → rupees."""

	return paise_to_rupees(int(amount_paise))
