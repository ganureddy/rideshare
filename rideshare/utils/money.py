"""Money helpers — DB stores integer paise, UI shows rupees.

Rationale: Rule #4 of the project brief.  Storing paise as ``int`` avoids
floating-point drift across price suggestions, refunds and platform-fee
splits.  We expose Currency-typed fields in DocTypes for ergonomics, but
business logic always rounds-trips through these helpers.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from frappe import _

PAISE_PER_RUPEE: int = 100


def rupees_to_paise(amount: float | int | str | Decimal) -> int:
	"""Convert a rupee amount (any input flavour) to integer paise.

	Uses banker's-safe rounding (HALF_UP) — important for refund splits
	where 50% of an odd paise count must not silently lose ₹0.005.
	"""

	if amount is None:
		return 0
	dec = Decimal(str(amount))
	paise = (dec * PAISE_PER_RUPEE).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
	return int(paise)


def paise_to_rupees(paise: int | float | str | None) -> Decimal:
	"""Inverse of :func:`rupees_to_paise`.  Returns a 2-decimal Decimal."""

	if paise is None:
		return Decimal("0.00")
	return (Decimal(str(paise)) / PAISE_PER_RUPEE).quantize(Decimal("0.01"))


def format_paise(paise: int | float | None, currency: str = "INR") -> str:
	"""Render paise as a localised currency string (Jinja-safe)."""

	rupees = paise_to_rupees(paise)
	if currency == "INR":
		return f"₹{rupees:,.2f}"
	return f"{currency} {rupees:,.2f}"


def split_platform_fee(total_paise: int, fee_percent: float) -> tuple[int, int]:
	"""Split ``total_paise`` into (platform_fee_paise, driver_payout_paise).

	The platform fee is rounded HALF_UP so the driver never loses the
	rounding sub-paise.
	"""

	if total_paise < 0:
		raise ValueError(_("Amount cannot be negative"))
	if not 0 <= fee_percent <= 100:
		raise ValueError(_("Fee percent must be between 0 and 100"))

	fee = (Decimal(total_paise) * Decimal(str(fee_percent)) / Decimal(100)).quantize(
		Decimal("1"), rounding=ROUND_HALF_UP
	)
	fee_paise = int(fee)
	return fee_paise, total_paise - fee_paise
