"""Server-rendered Razorpay Standard Checkout for the in-app WebView.

The mobile app opens this URL inside ``react-native-webview``
when the user taps "Pay & confirm".  The page:

  1. Pulls the booking's checkout context (order_id, key, prefill,
     amount) via the same authenticated session the WebView inherits.
  2. Renders Razorpay's hosted checkout JS, which opens a modal over
     the page (UPI / cards / netbanking).
  3. On success, POSTs the result up to the React Native host via
     ``window.ReactNativeWebView.postMessage`` so the app can call
     ``rideshare.api.bookings.confirm_payment`` and unmount the
     WebView.
  4. On failure / cancel, posts a ``payment-failed`` message instead.

Auth model
----------
The WebView shares the device's cookie session (set up at login by
the auth bridge in ``www/rideshare/m/oauth_callback.py``).  We don't
need to pass api_key/secret through the URL — Frappe's
``frappe.session.user`` is already populated by the time this view
runs.
"""

from __future__ import annotations

import frappe
from frappe import _


def get_context(context):
	context.no_cache = 1
	context.show_sidebar = 0
	context.title = "Pay"

	if frappe.session.user == "Guest":
		context.error = "Please sign in to complete payment."
		return context

	booking_name = (frappe.form_dict.get("booking") or "").strip()
	if not booking_name:
		context.error = "Missing booking id."
		return context

	# Reuse the REST helper so the auth + ownership checks live in one place.
	from rideshare.api.payments import checkout_context

	try:
		ctx = checkout_context(booking=booking_name)
	except frappe.PermissionError as exc:
		context.error = str(exc) or "Not allowed."
		return context
	except Exception as exc:
		context.error = f"Couldn't open checkout: {exc}"
		return context

	if ctx.get("already_paid"):
		context.error = (
			"This booking is already "
			f"{ctx.get('status', 'processed')} — no further payment needed."
		)
		return context

	if ctx.get("is_demo"):
		# DEMO mode shouldn't reach the WebView at all; the mobile app
		# branches on `is_demo` and calls confirm_payment directly.
		context.error = (
			"Demo mode is active — the app should auto-confirm without "
			"opening this checkout page.  Switch the gateway to "
			"`razorpay` in Rideshare Settings."
		)
		return context

	context.checkout = ctx
	context.error = None
	return context
