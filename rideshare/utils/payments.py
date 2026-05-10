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


_GATEWAYS: dict[str, type[PaymentGateway]] = {
	DummyGateway.name: DummyGateway,
	DemoGateway.name: DemoGateway,
}


def register_gateway(cls: type[PaymentGateway]) -> type[PaymentGateway]:
	"""Decorator used by Phase 5's Razorpay implementation."""

	_GATEWAYS[cls.name] = cls
	return cls


def get_gateway(name: str | None = None) -> PaymentGateway:
	"""Return the requested gateway, or the configured default.

	Phase 1: ``Rideshare Settings`` doesn't exist yet, so we always
	return :class:`DummyGateway` unless ``name`` is supplied.
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
