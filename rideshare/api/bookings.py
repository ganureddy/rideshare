"""Booking flow.

`create_booking`  → creates a Pending Booking and a `Created` Payment
                   Transaction, returning the gateway order ID for the
                   client to checkout against.

`confirm_payment` → verifies the gateway signature, holds the funds and
                   transitions the booking based on the ride's
                   ``instant_booking`` flag:

                     * instant_booking == 1 → status ``Confirmed`` (legacy
                       flow — driver opted into auto-acceptance).
                     * instant_booking == 0 → status ``Pending``, awaiting
                       the driver's review.  The booker may cancel for a
                       full refund while it is still Pending, and the
                       driver may either confirm or decline through
                       :func:`driver_confirm_booking` /
                       :func:`driver_cancel_booking`.

                   Either way the payment is captured and ``payment_status``
                   becomes ``Held``.  Idempotent on ``gateway_payment_id``.

`cancel_booking`        → passenger-initiated cancel.  Pending bookings
                         (driver hasn't accepted yet) get a 100% refund;
                         everything else uses the ride's cancellation
                         policy.

`driver_confirm_booking` → driver accepts a Pending booking.  Status
                          flips to ``Confirmed``; the chat thread between
                          driver and rider is auto-opened.

`driver_cancel_booking`  → driver declines a Pending or removes a
                          Confirmed rider before the trip starts.  Always
                          refunds 100% (driver-side fault).

`list_ride_bookings`     → driver-only listing of every booking on one of
                          their rides (Pending, Confirmed, Cancelled),
                          with display-friendly passenger info for the
                          mobile management screen.

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
	pay_later: int | bool = 0,
	defer: int | bool = 0,
) -> dict:
	"""Reserve seats and (optionally) create a payment order.

	Three flows depending on the payment-mode flags:

	  * **defer=1 (NEW, default in the mobile app since v2)** —
	    Booking lands Pending + Unpaid.  No gateway order is created.
	    The driver reviews and (if a non-instant ride) confirms.  Once
	    confirmed the rider sees a "Pay now" CTA in the app which
	    calls ``rideshare.api.payments.checkout_context`` to mint the
	    Razorpay order on demand.  For instant-booking rides we still
	    flip to Confirmed without payment so the seat is locked in;
	    the same "Pay now" CTA appears.

	  * **pay_later=1** — Legacy "pay the driver in cash at pickup".
	    Booking lands Pending + ``payment_status="Cash"``.  No gateway
	    round-trip ever.  Still works for sites that want it.

	  * **Pay now (no flags)** — Legacy upfront flow.  Gateway order
	    is created immediately so the mobile checkout WebView can
	    redeem it.  Booking lands Pending + Unpaid; payment
	    confirmation flips it to Confirmed/Held when the rider
	    completes Razorpay checkout.

	All paths are idempotent on (ride, passenger, status=Pending) so a
	flaky network → tap-Book-twice doesn't double-charge.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	pay_later_b = bool(int(pay_later or 0))
	defer_b = bool(int(defer or 0))

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
		# Flip Cash ↔ Unpaid if the rider reconsidered between attempts.
		# Cash bookings flip back to Unpaid the moment they kick off a
		# real Razorpay checkout.
		if pay_later_b:
			booking.payment_status = "Cash"
		elif defer_b:
			booking.payment_status = "Unpaid"
		else:
			booking.payment_status = booking.payment_status or "Unpaid"
		booking.save(ignore_permissions=True)
	else:
		booking = frappe.new_doc("Booking")
		booking.ride = ride
		booking.passenger = user
		booking.seats_booked = int(seats)
		booking.passenger_message = message
		booking.status = "Pending"
		booking.payment_status = "Cash" if pay_later_b else "Unpaid"
		booking.flags.ignore_permissions = True
		booking.insert(ignore_permissions=True)

	# defer=1 OR pay_later=1: skip the gateway, return early.  The
	# driver-side confirm flow + the rider-side cancel flow both work
	# unchanged because they branch on Booking.status, not payment_status.
	if pay_later_b or defer_b:
		# Auto-promote to Confirmed if the ride has instant_booking
		# turned on — the seat is held either way, the driver opted
		# into auto-acceptance, and making the rider wait for a Confirm
		# tap with no online payment is just friction.  For the new
		# deferred flow this still lands at Confirmed+Unpaid → rider
		# sees Pay-Now CTA.
		if int(ride_doc.instant_booking or 0):
			booking.status = "Confirmed"
			booking.save(ignore_permissions=True)
		# Open the rider/driver chat thread so they can coordinate
		# pickup details. Idempotent.
		try:
			from rideshare.api.chat import start_booking_chat as _open_chat
			_open_chat(booking.name)
		except Exception:
			frappe.log_error(
				title="Could not open booking chat for deferred booking",
				message=frappe.get_traceback(),
			)
		_broadcast_booking_change(
			booking,
			event="confirmed" if booking.status == "Confirmed" else "pending_review",
		)
		frappe.db.commit()
		return {
			"booking": booking.name,
			"booking_code": booking.booking_code,
			"amount": booking.total_amount,
			"currency": booking.currency or "INR",
			"pay_later": pay_later_b,
			"deferred": defer_b,
			"booking_status": booking.status,
			"payment_status": booking.payment_status,
		}

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
		"pay_later": False,
	}


@frappe.whitelist()
def confirm_payment(
	booking: str,
	gateway_payment_id: str,
	gateway_order_id: str | None = None,
	gateway_signature: str | None = None,
) -> dict:
	"""Verify gateway signature and mark the booking Confirmed.

	When ``gateway_order_id`` isn't supplied (the mobile DEMO flow) we
	auto-resolve it from the most recent Created transaction on the
	booking — which is exactly what ``create_booking`` just produced.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	booking_doc = frappe.get_doc("Booking", booking)
	if booking_doc.passenger != user:
		frappe.throw(_("Not your booking."), frappe.PermissionError)

	if not gateway_order_id:
		gateway_order_id = frappe.db.get_value(
			"Payment Transaction",
			{"booking": booking_doc.name, "status": "Created"},
			"gateway_order_id",
			order_by="creation desc",
		)
		if not gateway_order_id:
			frappe.throw(_("No payment order found for this booking."))

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

	# Honour the ride's instant_booking flag.  When the driver opted into
	# auto-acceptance we go straight to Confirmed; otherwise the booking
	# stays Pending and the driver decides via driver_confirm_booking.
	instant = int(frappe.db.get_value("Ride", booking_doc.ride, "instant_booking") or 0)
	booking_doc.status = "Confirmed" if instant else "Pending"
	booking_doc.payment_status = "Held"
	booking_doc.save(ignore_permissions=True)

	# Auto-open the driver↔passenger chat thread for this booking — useful
	# in both flows: the booker can talk to the driver while the request is
	# under review.  Failure here mustn't block the confirm flow.
	try:
		from rideshare.api.chat import start_booking_chat as _open_chat

		_open_chat(booking_doc.name)
	except Exception:
		frappe.log_error(
			title="Could not open booking chat after payment confirm",
			message=frappe.get_traceback(),
		)

	_broadcast_booking_change(
		booking_doc,
		event="confirmed" if instant else "pending_review",
	)

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

	# Pending = the driver hasn't accepted yet.  Riders are never charged
	# for changing their mind in that window, so we refund 100% regardless
	# of the ride's policy.
	if doc.status == "Pending":
		return _refund_booking(
			doc.name,
			percentage=100,
			reason=reason or "Passenger cancelled before driver confirmation",
		)

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

	_broadcast_booking_change(doc, event="cancelled", extra={"reason": reason})

	frappe.db.commit()
	return {
		"booking": doc.name,
		"status": doc.status,
		"payment_status": doc.payment_status,
		"refund_percentage": percentage,
		"refund_amount": refund_amount,
	}


# ---------------------------------------------------------------------------
# Driver-side booking management
# ---------------------------------------------------------------------------


def _driver_assert_owner(booking_doc, user: str) -> str:
	"""Return the ride name after asserting ``user`` drives it."""

	driver = frappe.db.get_value("Ride", booking_doc.ride, "driver")
	if not driver:
		frappe.throw(_("Ride not found."))
	if driver != user:
		frappe.throw(
			_("Only the ride's driver can manage these bookings."),
			frappe.PermissionError,
		)
	return booking_doc.ride


@frappe.whitelist()
def driver_confirm_booking(booking: str) -> dict:
	"""Driver accepts a Pending booking → status ``Confirmed``.

	Idempotent: re-confirming an already-Confirmed booking returns a noop.
	A Cancelled or Completed booking can't be revived from here.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	doc = frappe.get_doc("Booking", booking)
	_driver_assert_owner(doc, user)

	if doc.status == "Confirmed":
		return {"booking": doc.name, "status": doc.status, "noop": True}
	if doc.status in ("Cancelled", "Completed"):
		frappe.throw(_("Booking is {0}; cannot confirm.").format(doc.status))

	# Re-validate seat capacity at confirm time so we don't overshoot if
	# multiple Pending requests landed for the same ride.
	ride = frappe.get_doc("Ride", doc.ride)
	other_seats = (
		frappe.db.sql(
			"""SELECT COALESCE(SUM(seats_booked), 0)
			   FROM `tabBooking`
			   WHERE ride = %s AND name != %s
			     AND status IN ('Confirmed', 'Completed')""",
			(doc.ride, doc.name),
		)[0][0]
		or 0
	)
	free = int(ride.seats_total or 0) - int(other_seats)
	if int(doc.seats_booked or 0) > free:
		frappe.throw(
			_(
				"Only {0} seat(s) are still free on this ride — can't confirm "
				"a {1}-seat booking."
			).format(max(free, 0), int(doc.seats_booked or 0))
		)

	doc.status = "Confirmed"
	doc.save(ignore_permissions=True)

	# Make sure the booking chat thread exists so the rider can be reached.
	try:
		from rideshare.api.chat import start_booking_chat as _open_chat

		_open_chat(doc.name)
	except Exception:
		frappe.log_error(
			title="Could not open booking chat after driver confirm",
			message=frappe.get_traceback(),
		)

	_broadcast_booking_change(doc, event="confirmed")
	frappe.db.commit()
	return {
		"booking": doc.name,
		"status": doc.status,
		"payment_status": doc.payment_status,
	}


@frappe.whitelist()
def driver_cancel_booking(booking: str, reason: str | None = None) -> dict:
	"""Driver removes a rider from their ride.

	Allowed any time before the ride is ``InProgress`` or ``Completed``.
	Always refunds 100% — the rider isn't responsible for a driver-side
	removal.  Works for both Pending (decline) and Confirmed (remove)
	statuses.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	doc = frappe.get_doc("Booking", booking)
	_driver_assert_owner(doc, user)

	if doc.status in ("Cancelled", "Completed"):
		return {"booking": doc.name, "status": doc.status, "noop": True}

	ride_status = frappe.db.get_value("Ride", doc.ride, "status")
	if ride_status in ("InProgress", "Completed"):
		frappe.throw(
			_("Ride is {0}; passengers can't be removed at this stage.").format(ride_status)
		)

	tag = "Driver declined the request" if doc.status == "Pending" else "Driver removed the rider"
	return _refund_booking(
		doc.name,
		percentage=100,
		reason=f"{tag}: {reason}" if reason else tag,
	)


@frappe.whitelist()
def list_ride_bookings(ride: str) -> dict:
	"""Driver-only view of every booking on one of their rides.

	Returns the seat ledger plus a hydrated list grouped by status so the
	mobile management screen can render Pending / Confirmed / Cancelled
	tabs without further queries.
	"""

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	ride_row = frappe.db.get_value(
		"Ride",
		ride,
		[
			"name",
			"driver",
			"status",
			"origin_city",
			"destination_city",
			"departure_datetime",
			"seats_total",
			"seats_available",
			"price_per_seat",
			"instant_booking",
		],
		as_dict=True,
	)
	if not ride_row:
		frappe.throw(_("Ride not found."))
	if ride_row.driver != user:
		frappe.throw(_("Not your ride."), frappe.PermissionError)

	rows = frappe.db.sql(
		"""SELECT b.name, b.status, b.payment_status, b.seats_booked,
		          b.total_amount, b.booking_code, b.passenger_message,
		          b.booked_on,
		          b.passenger,
		          u.full_name AS passenger_name,
		          u.user_image AS passenger_image,
		          u.mobile_no AS passenger_mobile
		   FROM `tabBooking` b
		   JOIN `tabUser` u ON u.name = b.passenger
		   WHERE b.ride = %s
		   ORDER BY
		     FIELD(b.status, 'Pending', 'Confirmed', 'Completed', 'Cancelled'),
		     b.booked_on ASC""",
		ride,
		as_dict=True,
	)

	# Phone numbers for non-confirmed bookers stay hidden — same trust
	# boundary as ride_summary.contacts.
	for r in rows:
		if r["status"] not in ("Confirmed", "Completed"):
			r["passenger_mobile"] = None

	pending_seats = sum(
		int(r.get("seats_booked") or 0) for r in rows if r["status"] == "Pending"
	)
	confirmed_seats = sum(
		int(r.get("seats_booked") or 0)
		for r in rows
		if r["status"] in ("Confirmed", "Completed")
	)

	return {
		"ride": ride_row,
		"bookings": rows,
		"counts": {
			"pending": sum(1 for r in rows if r["status"] == "Pending"),
			"confirmed": sum(1 for r in rows if r["status"] == "Confirmed"),
			"cancelled": sum(1 for r in rows if r["status"] == "Cancelled"),
			"pending_seats": pending_seats,
			"confirmed_seats": confirmed_seats,
		},
	}


# ---------------------------------------------------------------------------
# Realtime — fan booking lifecycle changes out to driver + passenger so
# their dashboards / detail screens refresh without polling.
# ---------------------------------------------------------------------------


def _broadcast_booking_change(
	booking_doc, *, event: str, extra: dict | None = None
) -> None:
	"""Push a booking status update to interested parties.

	Three delivery channels are used so the message lands regardless of
	which screen the user has open:

	  * ``user=<driver>``    — driver's personal channel (dashboard).
	  * ``user=<passenger>`` — booker's personal channel (RideDetail).
	  * ``room=ride:<ride>`` — anyone watching the live tracking room.

	A best-effort Expo push is sent in parallel so the right party hears
	about the change even if the app is in the background, plus a
	transactional email through the ``Rideshare`` Email Account for the
	moments where a permanent record matters (e.g. driver confirming a
	seat — the rider often needs the ride details in their inbox).
	"""

	try:
		ride = frappe.db.get_value(
			"Ride",
			booking_doc.ride,
			[
				"driver",
				"instant_booking",
				"origin_city",
				"destination_city",
				"departure_datetime",
				"price_per_seat",
				"currency",
			],
			as_dict=True,
		)
	except Exception:
		ride = None
	driver = (ride or {}).get("driver")

	payload = {
		"event": event,
		"booking": booking_doc.name,
		"booking_code": booking_doc.booking_code,
		"ride": booking_doc.ride,
		"passenger": booking_doc.passenger,
		"status": booking_doc.status,
		"payment_status": booking_doc.payment_status,
		"seats_booked": int(booking_doc.seats_booked or 0),
		"instant_booking": bool((ride or {}).get("instant_booking") or 0),
	}
	if extra:
		payload.update(extra)

	# Per-user delivery: most reliable across nginx + socketio configs.
	for u in {driver, booking_doc.passenger}:
		if not u:
			continue
		try:
			frappe.publish_realtime(
				event="rideshare:booking",
				message=payload,
				user=u,
				after_commit=False,
			)
		except Exception:
			frappe.log_error(
				title="Booking realtime publish failed",
				message=frappe.get_traceback(),
			)

	# Room delivery for live-tracking listeners (driver + every confirmed
	# rider already subscribed to ride:<id>).
	try:
		frappe.publish_realtime(
			event="rideshare:booking",
			message=payload,
			room=f"ride:{booking_doc.ride}",
			after_commit=False,
		)
	except Exception:
		pass

	# Push notifications — pick recipient + copy by event type.
	_push_for_booking_event(
		booking_doc,
		event=event,
		ride_row=ride or {},
		driver=driver,
		extra=extra or {},
	)

	# Transactional email — currently only fires for "confirmed" (driver
	# accepted the rider's seat).  Pushed onto Frappe's Email Queue so a
	# slow SMTP doesn't stretch the confirm request.
	_email_for_booking_event(
		booking_doc,
		event=event,
		ride_row=ride or {},
		driver=driver,
	)


def _push_for_booking_event(
	booking_doc,
	*,
	event: str,
	ride_row: dict,
	driver: str | None,
	extra: dict,
) -> None:
	"""Translate a lifecycle event into a Expo push for the right party."""

	try:
		from rideshare.utils.push import notify_user
	except Exception:
		return

	def _name(user_id: str | None) -> str:
		if not user_id:
			return "Someone"
		return (
			frappe.db.get_value("User", user_id, "full_name") or user_id
		)

	route = (
		f"{ride_row.get('origin_city') or 'pickup'} → "
		f"{ride_row.get('destination_city') or 'destination'}"
	)
	seats = int(booking_doc.seats_booked or 0)
	seat_label = f"{seats} seat" if seats == 1 else f"{seats} seats"
	data = {
		"type": "booking",
		"event": event,
		"booking": booking_doc.name,
		"ride": booking_doc.ride,
		"status": booking_doc.status,
	}

	if event == "pending_review":
		# Driver gets notified that someone wants in.
		if not driver:
			return
		notify_user(
			driver,
			title="New booking request",
			body=f"{_name(booking_doc.passenger)} wants {seat_label} on {route}.",
			data=data,
			channel="bookings",
		)

	elif event == "confirmed":
		# Passenger learns their seat is locked in.  Skip if it was an
		# instant_booking (the passenger just paid; their UI already
		# reflects the confirmation).
		if ride_row.get("instant_booking"):
			return
		notify_user(
			booking_doc.passenger,
			title="Booking confirmed",
			body=f"Driver accepted your seat on {route}. See you there!",
			data=data,
			channel="bookings",
		)

	elif event == "cancelled":
		# The notification target depends on who triggered it; we can
		# infer this from the cancellation log we just wrote.
		cancelled_by = _last_cancelled_by(booking_doc.name)
		# Passenger-initiated → notify driver.  Anything else (driver
		# decline / remove) → notify passenger.
		if cancelled_by and cancelled_by == booking_doc.passenger:
			if driver:
				notify_user(
					driver,
					title="Booking cancelled",
					body=f"{_name(booking_doc.passenger)} cancelled their {seat_label} on {route}.",
					data=data,
					channel="bookings",
				)
		else:
			reason = (extra or {}).get("reason") or "Driver removed your booking."
			notify_user(
				booking_doc.passenger,
				title="Booking cancelled",
				body=f"Your seat on {route} was cancelled. {reason}".strip(),
				data=data,
				channel="bookings",
			)


EMAIL_SENDER_NAME = "Rideshare"


def _user_real_email(user_id: str | None) -> str | None:
	"""Resolve a user's deliverable email through the shared auth helper.

	Kept as a thin wrapper so all bookings call-sites read like a local
	helper while the actual policy (synthetic placeholder filtering,
	secondary-address column) lives next to the rest of the auth code.
	"""

	from rideshare.api.auth import get_user_real_email

	return get_user_real_email(user_id)


def _email_account_sender() -> str | None:
	"""Format ``Rideshare <addr>`` from the Email Account row, or None."""

	try:
		email = frappe.db.get_value(
			"Email Account",
			{"name": "Rideshare", "enable_outgoing": 1},
			"email_id",
		)
	except Exception:
		email = None
	return f"{EMAIL_SENDER_NAME} <{email}>" if email else None


def _format_departure(value) -> str | None:
	if not value:
		return None
	try:
		return frappe.utils.format_datetime(value, "EEEE, d MMM yyyy · h:mm a")
	except Exception:
		return str(value)


def _email_for_booking_event(
	booking_doc,
	*,
	event: str,
	ride_row: dict,
	driver: str | None,
) -> None:
	"""Route booking lifecycle emails through the ``Rideshare`` Email Account.

	Two events trigger mail today:

	  * ``pending_review`` — a rider just booked a non-instant ride;
	    the driver receives a "you have a new booking request" email.
	  * ``confirmed`` — the driver accepted the rider's seat; the
	    rider receives the trip confirmation with a Pay-Now CTA when
	    the booking is still unpaid.

	Errors are swallowed (logged) — a failed mail must never roll back
	the seat update that just succeeded.
	"""

	if event not in ("pending_review", "confirmed"):
		return

	try:
		origin = ride_row.get("origin_city") or "Pickup"
		destination = ride_row.get("destination_city") or "Destination"
		route = f"{origin} → {destination}"
		departure_str = _format_departure(ride_row.get("departure_datetime"))
		seats = int(booking_doc.seats_booked or 0)
		seat_label = "1 seat" if seats == 1 else f"{seats} seats"
		amount = booking_doc.total_amount
		currency = booking_doc.currency or ride_row.get("currency") or "INR"
		booking_code = booking_doc.booking_code or booking_doc.name
		passenger_name = (
			frappe.db.get_value("User", booking_doc.passenger, "full_name") or "Your rider"
		)
		driver_name = (
			(frappe.db.get_value("User", driver, "full_name") if driver else None)
			or "Your driver"
		)
		sender = _email_account_sender()

		if event == "pending_review":
			# Mirror push: only mail the driver when there's a real
			# decision to make.  Instant-booking rides skip the
			# pending_review event entirely upstream, but defend in
			# depth.
			if ride_row.get("instant_booking"):
				return
			driver_email = _user_real_email(driver)
			if not driver_email:
				return
			html = _render_booking_pending_email(
				driver_name=driver_name,
				passenger_name=passenger_name,
				route=route,
				departure_str=departure_str,
				seat_label=seat_label,
				amount=amount,
				currency=currency,
				booking_code=booking_code,
			)
			frappe.sendmail(
				recipients=[driver_email],
				subject=f"New booking request · {route}",
				message=html,
				sender=sender,
				reference_doctype="Booking",
				reference_name=booking_doc.name,
				now=False,
				delayed=True,
			)
			return

		# event == "confirmed"
		# Mirror push: skip instant-booking confirmations (the rider
		# just tapped Pay; their UI already shows Confirmed, mailing
		# them about their own action is noisy).
		if ride_row.get("instant_booking"):
			return
		passenger_email = _user_real_email(booking_doc.passenger)
		if not passenger_email:
			return

		# In the new deferred-payment flow the booking is Confirmed by
		# the driver but still Unpaid — let the rider know they can now
		# pay.  Older "paid first" bookings will have payment_status =
		# Held/Cash and skip the CTA.
		needs_payment = (booking_doc.payment_status or "").lower() == "unpaid"
		html = _render_booking_confirmed_email(
			passenger_name=passenger_name,
			driver_name=driver_name,
			route=route,
			departure_str=departure_str,
			seat_label=seat_label,
			amount=amount,
			currency=currency,
			booking_code=booking_code,
			needs_payment=needs_payment,
		)
		frappe.sendmail(
			recipients=[passenger_email],
			subject=f"Your seat on {route} is confirmed",
			message=html,
			sender=sender,
			reference_doctype="Booking",
			reference_name=booking_doc.name,
			now=False,
			delayed=True,
		)
	except Exception:
		frappe.log_error(
			title=f"Booking email failed ({event})",
			message=frappe.get_traceback(),
		)


def _email_summary_table(rows: list[tuple[str, str]]) -> str:
	"""Render the dashed (label, value) summary block used in both emails."""

	parts = []
	for label, value in rows:
		if not value:
			continue
		parts.append(
			"<tr>"
			f"<td style='color:#6b7280;padding:8px 0;font-size:13px;'>{frappe.utils.escape_html(label)}</td>"
			f"<td style='text-align:right;font-weight:600;padding:8px 0;font-size:13px;color:#111827;'>{value}</td>"
			"</tr>"
		)
	return "".join(parts)


def _render_booking_confirmed_email(
	*,
	passenger_name: str,
	driver_name: str,
	route: str,
	departure_str: str | None,
	seat_label: str,
	amount: float | None,
	currency: str,
	booking_code: str,
	needs_payment: bool = False,
) -> str:
	"""Modern, branded HTML email for booking-confirmed.

	Subtle CSS animations on the header (clients that strip <style>
	fall back to the static gradient).  No external assets — everything
	inline so Gmail / Apple Mail / Outlook all render the same.
	"""

	try:
		amount_str = f"{frappe.utils.escape_html(currency)} {float(amount or 0):,.2f}"
	except (TypeError, ValueError):
		amount_str = ""

	rows = _email_summary_table([
		("Route", frappe.utils.escape_html(route)),
		("Departure", frappe.utils.escape_html(departure_str or "")),
		("Seats", frappe.utils.escape_html(seat_label)),
		("Amount", amount_str),
		(
			"Booking code",
			f"<span style='font-family:monospace;'>{frappe.utils.escape_html(booking_code)}</span>",
		),
	])

	cta = ""
	if needs_payment:
		cta = """
        <p style="margin:0 0 18px;color:#0F4FA8;font-size:14px;font-weight:600;">
          You can pay for your seat now to lock it in.
        </p>
        <a href="https://ride.emrid.store/rideshare" style="display:inline-block;background:#10B981;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700;font-size:14px;">Pay now in the app →</a>
"""
	else:
		cta = """
        <a href="https://ride.emrid.store/rideshare" style="display:inline-block;background:#1976D2;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700;font-size:14px;">Open Rideshare →</a>
"""

	return f"""\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Booking confirmed</title>
<style>
  @keyframes rsPulse {{
    0%, 100% {{ transform: scale(1); }}
    50%      {{ transform: scale(1.04); }}
  }}
  @keyframes rsShimmer {{
    0%   {{ background-position: 0% 50%; }}
    50%  {{ background-position: 100% 50%; }}
    100% {{ background-position: 0% 50%; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;font-size:1px;color:#f4f6fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    {frappe.utils.escape_html(driver_name)} confirmed your seat on {frappe.utils.escape_html(route)}.
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="540" style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e9f2;box-shadow:0 10px 30px rgba(15,23,42,.06);">
        <tr>
          <td style="
              background:linear-gradient(120deg,#10B981 0%,#0EA371 35%,#10B981 65%,#34D399 100%);
              background-size:200% 200%;
              animation:rsShimmer 8s ease infinite;
              padding:36px 32px 32px;text-align:center;color:#ffffff;">
            <div style="display:inline-block;width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.18);line-height:64px;font-size:30px;animation:rsPulse 2.5s ease-in-out infinite;">✓</div>
            <div style="margin-top:14px;font-size:13px;letter-spacing:2px;font-weight:700;text-transform:uppercase;opacity:.9;">Seat Confirmed</div>
            <div style="margin-top:6px;font-size:24px;font-weight:800;letter-spacing:-.4px;">{frappe.utils.escape_html(route)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:26px 32px 6px;color:#111827;font-size:15px;line-height:1.55;">
            <p style="margin:0 0 14px;">Hi {frappe.utils.escape_html(passenger_name)},</p>
            <p style="margin:0 0 14px;">
              Great news — <strong>{frappe.utils.escape_html(driver_name)}</strong> has accepted
              your seat. Here are the details so you can plan your trip.
            </p>
            <table style="width:100%;border-collapse:collapse;margin-top:14px;background:#f8fafc;border-radius:12px;">
              <tr><td style="padding:6px 14px;"><table style="width:100%;border-collapse:collapse;">{rows}</table></td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 32px 32px;">
            {cta}
            <p style="margin:18px 0 0;color:#9ca3af;font-size:12px;">
              Chat with your driver and follow them live in the app.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 32px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;text-align:center;">
            Booking <span style="font-family:monospace;">{frappe.utils.escape_html(booking_code)}</span> · Rideshare
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
"""


def _render_booking_pending_email(
	*,
	driver_name: str,
	passenger_name: str,
	route: str,
	departure_str: str | None,
	seat_label: str,
	amount: float | None,
	currency: str,
	booking_code: str,
) -> str:
	"""Driver-facing 'new booking request' email."""

	try:
		amount_str = f"{frappe.utils.escape_html(currency)} {float(amount or 0):,.2f}"
	except (TypeError, ValueError):
		amount_str = ""

	rows = _email_summary_table([
		("Route", frappe.utils.escape_html(route)),
		("Departure", frappe.utils.escape_html(departure_str or "")),
		("Seats requested", frappe.utils.escape_html(seat_label)),
		("Earnings", amount_str),
		(
			"Booking code",
			f"<span style='font-family:monospace;'>{frappe.utils.escape_html(booking_code)}</span>",
		),
	])

	return f"""\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>New booking request</title>
<style>
  @keyframes rsShimmer {{
    0%   {{ background-position: 0% 50%; }}
    50%  {{ background-position: 100% 50%; }}
    100% {{ background-position: 0% 50%; }}
  }}
  @keyframes rsRing {{
    0%, 90%, 100% {{ transform: rotate(0); }}
    5%, 15%       {{ transform: rotate(-12deg); }}
    10%, 20%      {{ transform: rotate(12deg); }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;font-size:1px;color:#f4f6fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    {frappe.utils.escape_html(passenger_name)} wants {frappe.utils.escape_html(seat_label)} on {frappe.utils.escape_html(route)}.
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f6fb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="540" style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e9f2;box-shadow:0 10px 30px rgba(15,23,42,.06);">
        <tr>
          <td style="
              background:linear-gradient(120deg,#1976D2 0%,#0F4FA8 35%,#1976D2 65%,#21A0FF 100%);
              background-size:200% 200%;
              animation:rsShimmer 8s ease infinite;
              padding:36px 32px 32px;text-align:center;color:#ffffff;">
            <div style="display:inline-block;font-size:36px;animation:rsRing 2s ease-in-out infinite;">🔔</div>
            <div style="margin-top:10px;font-size:13px;letter-spacing:2px;font-weight:700;text-transform:uppercase;opacity:.9;">New Booking Request</div>
            <div style="margin-top:6px;font-size:24px;font-weight:800;letter-spacing:-.4px;">{frappe.utils.escape_html(route)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:26px 32px 6px;color:#111827;font-size:15px;line-height:1.55;">
            <p style="margin:0 0 14px;">Hi {frappe.utils.escape_html(driver_name)},</p>
            <p style="margin:0 0 14px;">
              <strong>{frappe.utils.escape_html(passenger_name)}</strong> would like to book
              <strong>{frappe.utils.escape_html(seat_label)}</strong> on your upcoming ride.
              Open the app to <strong>confirm</strong> or <strong>decline</strong> the request.
            </p>
            <table style="width:100%;border-collapse:collapse;margin-top:14px;background:#f8fafc;border-radius:12px;">
              <tr><td style="padding:6px 14px;"><table style="width:100%;border-collapse:collapse;">{rows}</table></td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 32px 8px;">
            <a href="https://ride.emrid.store/rideshare" style="display:inline-block;background:#1976D2;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700;font-size:14px;">Review the request →</a>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px 28px;color:#6b7280;font-size:12px;line-height:1.5;text-align:center;">
            Riders see the trip confirmed only after you accept. They'll be charged after confirmation.
          </td>
        </tr>
        <tr>
          <td style="padding:14px 32px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;text-align:center;">
            Booking <span style="font-family:monospace;">{frappe.utils.escape_html(booking_code)}</span> · Rideshare
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
"""


def _last_cancelled_by(booking_name: str) -> str | None:
	row = frappe.db.get_value(
		"Cancellation Log",
		{"booking": booking_name},
		"cancelled_by",
		order_by="creation desc",
	)
	return row or None


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
