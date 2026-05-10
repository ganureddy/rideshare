"""Unit tests for ``rideshare.utils.money``.

Pure-function tests — no DB touched, fast.
"""

from __future__ import annotations

from decimal import Decimal

from frappe.tests.utils import FrappeTestCase

from rideshare.utils.money import (
	format_paise,
	paise_to_rupees,
	rupees_to_paise,
	split_platform_fee,
)


class TestMoneyHelpers(FrappeTestCase):
	def test_rupees_to_paise_handles_int_float_str_decimal(self):
		self.assertEqual(rupees_to_paise(100), 10_000)
		self.assertEqual(rupees_to_paise(100.50), 10_050)
		self.assertEqual(rupees_to_paise("99.99"), 9_999)
		self.assertEqual(rupees_to_paise(Decimal("12.34")), 1_234)

	def test_rupees_to_paise_rounds_half_up(self):
		self.assertEqual(rupees_to_paise("0.005"), 1)
		self.assertEqual(rupees_to_paise("0.004"), 0)

	def test_rupees_to_paise_none_is_zero(self):
		self.assertEqual(rupees_to_paise(None), 0)

	def test_paise_to_rupees_round_trip(self):
		self.assertEqual(paise_to_rupees(10_050), Decimal("100.50"))
		self.assertEqual(paise_to_rupees(0), Decimal("0.00"))
		self.assertEqual(paise_to_rupees(None), Decimal("0.00"))

	def test_format_paise_inr_default(self):
		self.assertEqual(format_paise(150_000), "₹1,500.00")
		self.assertEqual(format_paise(0), "₹0.00")
		self.assertEqual(format_paise(None), "₹0.00")

	def test_format_paise_other_currency(self):
		self.assertEqual(format_paise(150_000, currency="USD"), "USD 1,500.00")

	def test_split_platform_fee_typical(self):
		fee, payout = split_platform_fee(100_000, fee_percent=12)
		self.assertEqual(fee, 12_000)
		self.assertEqual(payout, 88_000)
		self.assertEqual(fee + payout, 100_000)

	def test_split_platform_fee_zero_percent(self):
		fee, payout = split_platform_fee(100_000, fee_percent=0)
		self.assertEqual((fee, payout), (0, 100_000))

	def test_split_platform_fee_rounding_protects_payout(self):
		# 12.5% of 333 paise = 41.625 → fee=42, payout=291 (sum preserved)
		fee, payout = split_platform_fee(333, fee_percent=12.5)
		self.assertEqual(fee + payout, 333)

	def test_split_platform_fee_rejects_invalid(self):
		with self.assertRaises(ValueError):
			split_platform_fee(-1, fee_percent=10)
		with self.assertRaises(ValueError):
			split_platform_fee(100, fee_percent=-5)
		with self.assertRaises(ValueError):
			split_platform_fee(100, fee_percent=120)
