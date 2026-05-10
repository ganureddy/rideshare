"""End-to-end smoke test for the marketplace.

Covers Phases 2–5: mobile signup, driver onboarding, publishing a ride,
public search, booking + payment confirmation, and cancellation.
"""

from __future__ import annotations

from contextlib import contextmanager

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, now_datetime

from rideshare.api import auth, bookings, onboarding, rides, search


@contextmanager
def acting_as(user_id: str):
	prev = frappe.session.user
	frappe.set_user(user_id)
	try:
		yield
	finally:
		frappe.set_user(prev)


class TestEndToEndFlow(FrappeTestCase):
	def setUp(self):
		# Reset to Administrator so cleanup has full permissions even when
		# a previous test left the session as a low-privilege user.
		frappe.set_user("Administrator")

		# Ensure cities + settings exist (install hook may not have run in test DB).
		from rideshare.install import _ensure_cities, _ensure_settings, _ensure_roles

		_ensure_roles()
		_ensure_settings()
		_ensure_cities()

		# Wipe any leftover test data from prior runs.  Keyed on the test
		# users we use in this module.
		test_users = [
			"919000000001@rideshare.local",
			"919000000002@rideshare.local",
			"9000000001@rideshare.local",
			"9000000002@rideshare.local",
		]
		for b in frappe.get_all(
			"Booking", filters={"passenger": ["in", test_users]}, pluck="name"
		):
			frappe.delete_doc("Booking", b, force=True, ignore_permissions=True)
		for txn in frappe.get_all(
			"Payment Transaction",
			filters={"gateway_order_id": ["like", "order_demo_%"]},
			pluck="name",
		):
			# Best-effort cleanup of demo gateway transactions.
			try:
				frappe.delete_doc(
					"Payment Transaction", txn, force=True, ignore_permissions=True
				)
			except Exception:
				pass
		for r in frappe.get_all(
			"Ride", filters={"driver": ["in", test_users]}, pluck="name"
		):
			frappe.delete_doc("Ride", r, force=True, ignore_permissions=True)
		for v in frappe.get_all(
			"Vehicle", filters={"owner_user": ["in", test_users]}, pluck="name"
		):
			frappe.delete_doc("Vehicle", v, force=True, ignore_permissions=True)
		for dp in frappe.get_all(
			"Driver Profile", filters={"user": ["in", test_users]}, pluck="name"
		):
			frappe.delete_doc("Driver Profile", dp, force=True, ignore_permissions=True)
		for u in test_users:
			if frappe.db.exists("User", u):
				try:
					frappe.delete_doc("User", u, force=True, ignore_permissions=True)
				except Exception:
					pass
		frappe.db.commit()

	def test_full_marketplace_flow(self):
		# 1. Driver signup via mobile.
		drv = auth.login_or_signup("9000000001", full_name="Driver Dee")
		self.assertTrue(drv["is_new"])
		driver_user = drv["user"]
		self.assertTrue(frappe.db.exists("User", driver_user))

		# 2. Driver onboarding — profile + vehicle.
		with acting_as(driver_user):
			profile = onboarding.upsert_driver_profile(
				full_name="Driver Dee",
				bio="Friendly weekend driver",
				license_number="DL-9999",
				preferences_music="Some",
			)
			self.assertEqual(profile["verification_status"], "Verified")
			self.assertTrue(profile["is_verified"])

			veh = onboarding.upsert_vehicle(
				make="Maruti",
				model="Swift",
				year=2022,
				seats_available=3,
				color="White",
			)
			self.assertTrue(veh["name"].startswith("VEH-"))

		# 3. Publish a ride.
		import json as _json

		payload = _json.dumps(
			{
				"vehicle": veh["name"],
				"origin_city": "Delhi",
				"destination_city": "Jaipur",
				"origin_lat": 28.6139,
				"origin_lng": 77.2090,
				"destination_lat": 26.9124,
				"destination_lng": 75.7873,
				"departure_datetime": str(add_days(now_datetime(), 3)),
				"seats_total": 3,
				"price_per_seat": 800,
				"instant_booking": False,
				"women_only": False,
				"max_2_back": True,
				"description": "Weekend drive to Jaipur",
				"cancellation_policy": "Moderate",
				"waypoints": [],
			}
		)
		with acting_as(driver_user):
			ride = rides.publish_ride(payload)
		self.assertEqual(ride["status"], "Published")
		ride_name = ride["name"]
		ride_doc = frappe.get_doc("Ride", ride_name)
		self.assertGreater(ride_doc.distance_km or 0, 100)
		self.assertEqual(ride_doc.seats_available, 3)

		# 4. Passenger signup.
		pas = auth.login_or_signup("9000000002", full_name="Passenger Pat")
		passenger_user = pas["user"]

		# 5. Public search finds the ride.
		res = search.search_rides(origin="Delhi", destination="Jaipur")
		self.assertGreaterEqual(res["count"], 1)
		ride_in_results = next((r for r in res["results"] if r["name"] == ride_name), None)
		self.assertIsNotNone(ride_in_results)
		self.assertEqual(ride_in_results["driver_name"], "Driver Dee")

		# 6. Booking + DEMO payment confirmation.
		import secrets

		payment_id = "pay_demo_" + secrets.token_hex(8)
		with acting_as(passenger_user):
			b = bookings.create_booking(ride=ride_name, seats=2, message="Hi!")
			self.assertEqual(b["gateway"], "demo")
			self.assertTrue(b["is_demo"])

			confirm = bookings.confirm_payment(
				booking=b["booking"],
				gateway_order_id=b["order_id"],
				gateway_payment_id=payment_id,
				gateway_signature="sig",
			)
		self.assertEqual(confirm["status"], "Confirmed")
		self.assertEqual(confirm["payment_status"], "Held")

		# Idempotent confirm: same gateway_payment_id is a no-op.
		with acting_as(passenger_user):
			again = bookings.confirm_payment(
				booking=b["booking"],
				gateway_order_id=b["order_id"],
				gateway_payment_id=payment_id,
				gateway_signature="sig",
			)
		self.assertTrue(again.get("already_captured"))

		# Seats decremented.
		ride_doc.reload()
		self.assertEqual(ride_doc.seats_available, 1)

		# 7. Passenger sees the booking in /me/trips.
		with acting_as(passenger_user):
			my = bookings.my_bookings()
		self.assertEqual(len(my), 1)
		self.assertEqual(my[0]["status"], "Confirmed")

		# 8. Passenger cancels (Moderate policy + 3 days out → 100% refund).
		with acting_as(passenger_user):
			cancel = bookings.cancel_booking(booking=b["booking"], reason="plans changed")
		self.assertEqual(cancel["status"], "Cancelled")
		self.assertEqual(cancel["refund_percentage"], 100)
		self.assertEqual(cancel["payment_status"], "Refunded")

		# Seats restored.
		ride_doc.reload()
		self.assertEqual(ride_doc.seats_available, 3)


class TestAuthEndpoints(FrappeTestCase):
	def test_login_creates_user_and_assigns_rider_role(self):
		res = auth.login_or_signup("8888888888", full_name="Test Rider")
		self.assertTrue(frappe.db.exists("User", res["user"]))
		self.assertIn("Rider", frappe.get_roles(res["user"]))

	def test_login_normalises_indian_mobile(self):
		res = auth.login_or_signup("7777777777")
		mobile = frappe.db.get_value("User", res["user"], "mobile_no")
		self.assertEqual(mobile, "+917777777777")

	def test_invalid_mobile_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			auth.login_or_signup("abc")
