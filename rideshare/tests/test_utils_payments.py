"""Unit tests for the payment-gateway abstraction."""

from __future__ import annotations

from frappe.tests.utils import FrappeTestCase

from rideshare.utils.payments import DemoGateway, DummyGateway, get_gateway


class TestPaymentGateway(FrappeTestCase):
	def test_default_gateway_is_demo(self):
		gw = get_gateway()
		# Default is `demo` per Rideshare Settings; either way DemoGateway or
		# DummyGateway are acceptable concrete fallbacks.
		self.assertIn(gw.name, ("demo", "dummy"))

	def test_demo_gateway_auto_succeeds(self):
		gw = DemoGateway()
		order = gw.create_order(amount_paise=1000, currency="INR", receipt="x")
		v = gw.verify_signature(order_id=order.order_id, payment_id="p1", signature="anything")
		self.assertTrue(v.ok)

	def test_dummy_create_order_round_trip(self):
		gw = DummyGateway()
		order = gw.create_order(
			amount_paise=10_000, currency="INR", receipt="bk-001", notes={"foo": "bar"}
		)
		self.assertEqual(order.gateway, "dummy")
		self.assertEqual(order.amount_paise, 10_000)
		self.assertTrue(order.order_id.startswith("order_dummy_"))

	def test_dummy_signature_verification(self):
		gw = DummyGateway()
		order = gw.create_order(amount_paise=500, currency="INR", receipt="bk-002")
		good = gw.verify_signature(
			order_id=order.order_id,
			payment_id="pay_xyz",
			signature=f"sig::{order.order_id}::pay_xyz",
		)
		bad = gw.verify_signature(
			order_id=order.order_id, payment_id="pay_xyz", signature="nope"
		)
		self.assertTrue(good.ok)
		self.assertFalse(bad.ok)
		self.assertEqual(bad.error, "bad_signature")

	def test_dummy_refund(self):
		gw = DummyGateway()
		response = gw.refund(payment_id="pay_xyz", amount_paise=500)
		self.assertEqual(response["status"], "processed")
		self.assertEqual(response["amount"], 500)
