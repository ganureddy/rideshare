"""Payment-gateway abstraction used by Phase 5.

Defines the typed contract that Razorpay (primary) and Stripe (later) must
implement.  Phase 1 ships:
- ``PaymentGateway`` ABC,
- ``PaymentOrder`` / ``PaymentVerification`` value types,
- a registry + lookup keyed on ``Rideshare Settings.default_gateway``,
- a ``DummyGateway`` used by tests to avoid hitting real APIs.

Concrete Razorpay implementation lands in Phase 5; importing this module
must remain side-effect-free.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import ClassVar

import frappe

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PaymentOrder:
	"""Server-side handle for a not-yet-paid order on the gateway."""

	gateway: str
	order_id: str
	amount_paise: int
	currency: str
	receipt: str
	raw: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PaymentVerification:
	"""Result of verifying a client-side payment signature."""

	ok: bool
	gateway: str
	order_id: str
	payment_id: str | None
	signature: str | None
	error: str | None = None
	raw: dict = field(default_factory=dict)


class PaymentGateway(ABC):
	"""Common server-side interface for payment gateways."""

	name: ClassVar[str] = "abstract"
	display_name: ClassVar[str] = "Abstract Gateway"

	@abstractmethod
	def create_order(
		self,
		*,
		amount_paise: int,
		currency: str,
		receipt: str,
		notes: dict[str, str] | None = None,
	) -> PaymentOrder:
		"""Create an order on the gateway and return its handle."""

	@abstractmethod
	def verify_signature(
		self, *, order_id: str, payment_id: str, signature: str
	) -> PaymentVerification:
		"""Verify a payment-completion signature returned by the client."""

	@abstractmethod
	def refund(self, *, payment_id: str, amount_paise: int, notes: dict | None = None) -> dict:
		"""Initiate a refund. Returns the gateway's raw response."""

	@abstractmethod
	def parse_webhook(self, *, body: bytes, signature: str) -> dict:
		"""Verify and decode a webhook payload."""


class DummyGateway(PaymentGateway):
	"""Deterministic in-memory gateway used by tests."""

	name: ClassVar[str] = "dummy"
	display_name: ClassVar[str] = "Dummy (test)"

	def create_order(
		self,
		*,
		amount_paise: int,
		currency: str,
		receipt: str,
		notes: dict[str, str] | None = None,
	) -> PaymentOrder:
		return PaymentOrder(
			gateway=self.name,
			order_id=f"order_dummy_{receipt}",
			amount_paise=amount_paise,
			currency=currency,
			receipt=receipt,
			raw={"notes": notes or {}},
		)

	def verify_signature(
		self, *, order_id: str, payment_id: str, signature: str
	) -> PaymentVerification:
		ok = signature == f"sig::{order_id}::{payment_id}"
		return PaymentVerification(
			ok=ok,
			gateway=self.name,
			order_id=order_id,
			payment_id=payment_id,
			signature=signature,
			error=None if ok else "bad_signature",
		)

	def refund(self, *, payment_id: str, amount_paise: int, notes: dict | None = None) -> dict:
		return {
			"id": f"rfnd_dummy_{payment_id}",
			"payment_id": payment_id,
			"amount": amount_paise,
			"notes": notes or {},
			"status": "processed",
		}

	def parse_webhook(self, *, body: bytes, signature: str) -> dict:
		import json

		return json.loads(body or b"{}")


class DemoGateway(PaymentGateway):
	"""Demo gateway used by the public site — auto-confirms every payment.

	Every ``create_order`` call returns an order whose signature predictably
	verifies in ``verify_signature``.  This lets the entire booking flow
	be exercised end-to-end without real Razorpay credentials.
	"""

	name: ClassVar[str] = "demo"
	display_name: ClassVar[str] = "Demo (auto-success)"

	def create_order(
		self,
		*,
		amount_paise: int,
		currency: str,
		receipt: str,
		notes: dict[str, str] | None = None,
	) -> PaymentOrder:
		import secrets

		return PaymentOrder(
			gateway=self.name,
			order_id=f"order_demo_{secrets.token_hex(6)}",
			amount_paise=amount_paise,
			currency=currency,
			receipt=receipt,
			raw={"notes": notes or {}, "demo": True},
		)

	def verify_signature(
		self, *, order_id: str, payment_id: str, signature: str
	) -> PaymentVerification:
		# Demo always succeeds.
		return PaymentVerification(
			ok=True,
			gateway=self.name,
			order_id=order_id,
			payment_id=payment_id,
			signature=signature,
			raw={"demo": True},
		)

	def refund(self, *, payment_id: str, amount_paise: int, notes: dict | None = None) -> dict:
		return {
			"id": f"rfnd_demo_{payment_id}",
			"payment_id": payment_id,
			"amount": amount_paise,
			"notes": notes or {},
			"status": "processed",
			"demo": True,
		}

	def parse_webhook(self, *, body: bytes, signature: str) -> dict:
		import json

		return json.loads(body or b"{}")


class RazorpayGateway(PaymentGateway):
	"""Production Razorpay implementation.

	Uses the official ``razorpay`` Python SDK (already shipped by the
	Frappe ``payments`` app).  Keys are read from ``Rideshare
	Settings`` — ``razorpay_key_id`` (Data) + ``razorpay_key_secret``
	(Password).

	Notes
	-----
	* Razorpay deals exclusively in paise on the API surface.  We
	  always pass amounts as integers; never pass floats — the SDK
	  silently truncates.
	* Signature verification: Razorpay returns
	  ``HMAC_SHA256(order_id|payment_id, secret)`` to the client;
	  we recompute server-side and compare.  This is the **only**
	  authoritative confirmation that a payment was real — never
	  trust ``payment_id`` alone.
	* Webhook payload: Razorpay also posts a server-to-server
	  ``payment.captured`` event.  We verify that with a different
	  HMAC (``HMAC_SHA256(body, webhook_secret)``) and use it as a
	  defense-in-depth: even if the client never calls back, the
	  webhook captures the payment.
	"""

	name: ClassVar[str] = "razorpay"
	display_name: ClassVar[str] = "Razorpay (UPI / Card / Netbanking)"

	def __init__(self) -> None:
		try:
			import razorpay
		except ImportError as exc:  # pragma: no cover
			raise frappe.ValidationError(
				"razorpay SDK not installed — run "
				"`bench pip install razorpay` and restart."
			) from exc

		settings = frappe.get_single("Rideshare Settings")
		key_id = (settings.razorpay_key_id or "").strip()
		# get_password returns the decrypted secret.
		key_secret = settings.get_password("razorpay_key_secret", raise_exception=False) or ""
		if not key_id or not key_secret:
			raise frappe.ValidationError(
				"Razorpay is not configured.  Set Razorpay Key ID + "
				"Razorpay Key Secret in Rideshare Settings."
			)
		self._client = razorpay.Client(auth=(key_id, key_secret))
		self._key_id = key_id

	@property
	def key_id(self) -> str:
		"""Public Razorpay Key — safe to ship to the client / WebView."""

		return self._key_id

	def create_order(
		self,
		*,
		amount_paise: int,
		currency: str,
		receipt: str,
		notes: dict[str, str] | None = None,
	) -> PaymentOrder:
		# Razorpay accepts a `receipt` of up to 40 chars — booking names
		# fit well within that.  Notes are echoed back in webhook events
		# so we use them to round-trip our internal IDs.
		try:
			order = self._client.order.create(
				dict(
					amount=int(amount_paise),
					currency=(currency or "INR").upper(),
					receipt=str(receipt)[:40],
					notes=notes or {},
					payment_capture=1,
				)
			)
		except Exception as exc:  # pragma: no cover
			logger.exception("razorpay create_order failed")
			frappe.throw(f"Razorpay couldn't create the order: {exc}")
		return PaymentOrder(
			gateway=self.name,
			order_id=order["id"],
			amount_paise=int(order.get("amount") or amount_paise),
			currency=str(order.get("currency") or currency),
			receipt=str(order.get("receipt") or receipt),
			raw=dict(order),
		)

	def verify_signature(
		self, *, order_id: str, payment_id: str, signature: str
	) -> PaymentVerification:
		# Razorpay's signature is HMAC_SHA256(order_id + "|" + payment_id, secret).
		# The SDK exposes a one-call helper that throws on mismatch;
		# we wrap it so callers always receive a PaymentVerification.
		try:
			self._client.utility.verify_payment_signature(
				{
					"razorpay_order_id": order_id,
					"razorpay_payment_id": payment_id,
					"razorpay_signature": signature,
				}
			)
			ok = True
			error = None
		except Exception as exc:
			ok = False
			error = str(exc) or "signature_mismatch"
		return PaymentVerification(
			ok=ok,
			gateway=self.name,
			order_id=order_id,
			payment_id=payment_id,
			signature=signature,
			error=error,
		)

	def refund(
		self, *, payment_id: str, amount_paise: int, notes: dict | None = None
	) -> dict:
		try:
			res = self._client.payment.refund(
				payment_id,
				{
					"amount": int(amount_paise),
					"notes": notes or {},
					"speed": "normal",
				},
			)
			return dict(res)
		except Exception as exc:  # pragma: no cover
			logger.exception("razorpay refund failed")
			frappe.throw(f"Razorpay refund failed: {exc}")

	def parse_webhook(self, *, body: bytes, signature: str) -> dict:
		"""Verify and decode an incoming Razorpay webhook payload.

		The webhook secret is configured in the Razorpay dashboard
		(Webhooks → Active Events → Webhook Secret).  We store it on
		``Rideshare Settings.razorpay_webhook_secret`` (Password).

		Returns the decoded JSON body if the signature checks out;
		raises a ValidationError otherwise so callers can return 400.
		"""

		import json

		settings = frappe.get_single("Rideshare Settings")
		webhook_secret = settings.get_password(
			"razorpay_webhook_secret", raise_exception=False
		) or ""
		if not webhook_secret:
			frappe.throw(
				"Razorpay webhook secret not configured.  Set "
				"`razorpay_webhook_secret` on Rideshare Settings."
			)
		try:
			self._client.utility.verify_webhook_signature(
				body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else body,
				signature,
				webhook_secret,
			)
		except Exception as exc:
			frappe.throw(f"Webhook signature failed: {exc}")
		return json.loads(body or b"{}")


# Register the gateway so `get_gateway("razorpay")` resolves.
_GATEWAYS: dict[str, type[PaymentGateway]] = {
	DummyGateway.name: DummyGateway,
	DemoGateway.name: DemoGateway,
	RazorpayGateway.name: RazorpayGateway,
}


def register_gateway(cls: type[PaymentGateway]) -> type[PaymentGateway]:
	"""Decorator for adding new gateways (Stripe, Cashfree, etc.) later."""

	_GATEWAYS[cls.name] = cls
	return cls


def get_gateway(name: str | None = None) -> PaymentGateway:
	"""Return the requested gateway, or the configured default.

	Resolution order:
	  1. Explicit ``name`` argument (used by tests + admin tools).
	  2. ``Rideshare Settings.default_gateway`` (single-doctype lookup).
	  3. ``DemoGateway`` fallback so booking continues to work even
	     when the settings doc hasn't been initialised on a fresh
	     bench.

	Razorpay activation is intentionally a *runtime* decision so the
	same code path drives DEMO/UAT/PROD environments — the only
	difference is the value stored in Settings.
	"""

	if name is None:
		try:
			if frappe.db.exists("DocType", "Rideshare Settings"):
				name = frappe.db.get_single_value(
					"Rideshare Settings", "default_gateway"
				)
		except Exception:  # noqa: BLE001
			logger.warning("rideshare.payments: settings unavailable, using DemoGateway")

	cls = _GATEWAYS.get(name or DemoGateway.name, DemoGateway)
	return cls()
