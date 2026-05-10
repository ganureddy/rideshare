"""Shared utilities for the Rideshare app.

Sub-modules:
- money: paise <-> rupees conversion + display formatting.
- encryption: thin wrapper over `frappe.utils.password` for PII fields.
- geo: distance / bbox math used by search and routing.
- notifications: provider-agnostic SMS / email / push abstraction.
- payments: payment-gateway abstraction (Razorpay first, Stripe stub).
"""

from __future__ import annotations
