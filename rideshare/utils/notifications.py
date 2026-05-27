"""Provider-agnostic notification layer.

Phase 1 ships:
- a registry of providers selected by ``Rideshare Settings``,
- an in-memory ``LogProvider`` used by tests and dev,
- a typed ``NotificationProvider`` ABC for SMS / OTP.

The MSG91 implementation is wired up in Phase 2.  We keep the abstraction
here so call sites can already write::

    from rideshare.utils.notifications import get_sms_provider
    get_sms_provider().send_otp(phone, otp_code)

…and Phase 2 simply swaps the concrete provider.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import ClassVar

import frappe

logger = logging.getLogger(__name__)


@dataclass
class NotificationResult:
	"""Outcome of a single send attempt — provider-agnostic."""

	ok: bool
	provider: str
	provider_message_id: str | None = None
	error: str | None = None
	raw: dict = field(default_factory=dict)


class NotificationProvider(ABC):
	"""Common interface for SMS / OTP / transactional message providers."""

	name: ClassVar[str] = "abstract"

	@abstractmethod
	def send_otp(self, phone: str, otp: str, *, purpose: str = "login") -> NotificationResult:
		"""Send a one-time-password text message."""

	@abstractmethod
	def send_transactional(
		self, phone: str, template: str, variables: dict[str, str]
	) -> NotificationResult:
		"""Send a templated transactional SMS (booking confirmed, etc.)."""


class LogProvider(NotificationProvider):
	"""Fallback used in dev / tests — writes to the Frappe error log only."""

	name: ClassVar[str] = "log"

	def send_otp(self, phone: str, otp: str, *, purpose: str = "login") -> NotificationResult:
		logger.info("rideshare.sms.otp phone=%s purpose=%s otp=%s", phone, purpose, otp)
		frappe.logger("rideshare").info(
			f"[LogProvider] OTP for {phone} ({purpose}) = {otp}"
		)
		return NotificationResult(ok=True, provider=self.name, provider_message_id="log")

	def send_transactional(
		self, phone: str, template: str, variables: dict[str, str]
	) -> NotificationResult:
		frappe.logger("rideshare").info(
			f"[LogProvider] tx-sms to={phone} template={template} vars={variables}"
		)
		return NotificationResult(ok=True, provider=self.name, provider_message_id="log")


_PROVIDERS: dict[str, type[NotificationProvider]] = {LogProvider.name: LogProvider}


def register_provider(cls: type[NotificationProvider]) -> type[NotificationProvider]:
	"""Decorator used by Phase 2's MSG91 provider to register itself."""

	_PROVIDERS[cls.name] = cls
	return cls


def get_sms_provider() -> NotificationProvider:
	"""Return the concrete provider per ``Rideshare Settings.sms_provider``.

	Phase 1: the Settings DocType doesn't exist yet, so we always fall
	back to :class:`LogProvider`.  Phase 2 introduces the setting and
	flips this to the configured value.
	"""

	provider_name = "log"
	try:
		if frappe.db.exists("DocType", "Rideshare Settings"):
			provider_name = (
				frappe.db.get_single_value("Rideshare Settings", "sms_provider") or "log"
			)
	except Exception:  # noqa: BLE001 - never fail email/SMS path on settings glitch
		logger.warning("rideshare.notifications: settings unavailable, using LogProvider")

	cls = _PROVIDERS.get(provider_name, LogProvider)
	return cls()


def send_email_async(
	*,
	recipients: list[str],
	subject: str,
	template: str,
	args: dict | None = None,
	reference_doctype: str | None = None,
	reference_name: str | None = None,
) -> None:
	"""Enqueue an email through Frappe's Email Queue.

	Always backgrounded — Rule #6.
	"""

	frappe.enqueue(
		"frappe.email.queue.send",
		queue="short",
		recipients=recipients,
		subject=subject,
		template=template,
		args=args or {},
		reference_doctype=reference_doctype,
		reference_name=reference_name,
		now=False,
	)
