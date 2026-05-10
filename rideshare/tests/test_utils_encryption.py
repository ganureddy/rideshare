"""Unit tests for ``rideshare.utils.encryption`` (PII helpers)."""

from __future__ import annotations

from frappe.tests.utils import FrappeTestCase

from rideshare.utils.encryption import (
	decrypt_pii,
	encrypt_pii,
	mask_license,
	mask_phone,
)


class TestPiiHelpers(FrappeTestCase):
	def test_encrypt_decrypt_round_trip(self):
		ct = encrypt_pii("DL14 20211234567")
		self.assertIsNotNone(ct)
		self.assertNotEqual(ct, "DL14 20211234567")
		self.assertEqual(decrypt_pii(ct), "DL14 20211234567")

	def test_encrypt_handles_none_and_empty(self):
		self.assertIsNone(encrypt_pii(None))
		self.assertIsNone(encrypt_pii(""))
		self.assertIsNone(decrypt_pii(None))
		self.assertIsNone(decrypt_pii(""))

	def test_mask_phone(self):
		self.assertEqual(mask_phone("+919876543210"), "•••• ••3210")
		self.assertEqual(mask_phone(""), "")
		self.assertEqual(mask_phone("123"), "•••")

	def test_mask_license(self):
		# 11-char input, last 4 visible
		self.assertEqual(mask_license("DL142021123"), "•••••••1123")
		self.assertEqual(mask_license(""), "")
		self.assertEqual(mask_license("AB"), "••")
