"""PII encryption helpers built on Frappe's password vault.

Rule #5 of the project brief: phone, license number, license plate and
similar PII must be encrypted at rest.  Frappe ships with a per-site
encryption key in ``site_config.json`` that backs the ``Password`` field
type.  We wrap the lower-level API here so call sites stay readable and
so unit tests can monkey-patch the storage cheaply.
"""

from __future__ import annotations

from typing import Final

from frappe.utils.password import decrypt as _decrypt
from frappe.utils.password import encrypt as _encrypt

_PII_ENCRYPTION_VERSION: Final[str] = "v1"


def encrypt_pii(plaintext: str | None) -> str | None:
	"""Encrypt ``plaintext`` for at-rest storage; ``None`` round-trips.

	Empty strings are stored as ``None`` to keep DB indexes sparse.
	"""

	if plaintext is None or plaintext == "":
		return None
	return f"{_PII_ENCRYPTION_VERSION}:{_encrypt(plaintext)}"


def decrypt_pii(ciphertext: str | None) -> str | None:
	"""Decrypt a value produced by :func:`encrypt_pii`.

	Tolerates legacy unprefixed values for forward-compat with the
	``Password`` field type, which stores ciphertext without our version
	tag.  Returns ``None`` for ``None`` / empty inputs.
	"""

	if not ciphertext:
		return None
	if ciphertext.startswith(f"{_PII_ENCRYPTION_VERSION}:"):
		return _decrypt(ciphertext[len(_PII_ENCRYPTION_VERSION) + 1 :])
	return _decrypt(ciphertext)


def mask_phone(phone: str | None) -> str:
	"""Return ``+91 •••• ••1234`` style masking for UI display."""

	if not phone:
		return ""
	digits = "".join(ch for ch in phone if ch.isdigit())
	if len(digits) < 4:
		return "•" * len(digits)
	return f"•••• ••{digits[-4:]}"


def mask_license(license_number: str | None) -> str:
	"""Mask a driving licence number, keeping last 4 chars visible."""

	if not license_number:
		return ""
	if len(license_number) <= 4:
		return "•" * len(license_number)
	return "•" * (len(license_number) - 4) + license_number[-4:]
