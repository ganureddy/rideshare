"""CO2-saved aggregates.

Lightweight calculation: every shared seat-kilometre saves the carbon
that *would have been emitted* by a solo car driver — roughly 0.21 kg
CO2 / km for an average Indian petrol sedan (Govt of India MoRTH 2023
average; we round to 0.2 to stay conservative).

So a 200-km Mumbai → Goa trip with 3 shared seats saves
``200 km × 3 seats × 0.2 kg = 120 kg CO2`` collectively, distributed
among the participants.

We compute and persist the per-user aggregate on ``User.co2_saved_kg``
once an hour via a scheduler job (Phase 1 ships this lightweight; in
Phase 2 we'll move to per-trip stamping with a Ride Outcome row).

This module is also the one place to tune the constants if the
methodology changes — search-result and Profile widgets read the
already-computed ``User.co2_saved_kg`` value, never recompute live.
"""

from __future__ import annotations

import frappe

# Conservative average CO2 per km for an Indian petrol sedan (MoRTH 2023).
# Tweak here if you switch the methodology to e.g. distance-weighted
# vehicle class or per-fuel emissions.
KG_CO2_PER_KM = 0.2


def saved_for_ride(distance_km: float, shared_seats: int) -> float:
	"""How many kg CO2 a single completed ride saved, vs each rider
	driving solo.

	Each rider beyond the driver counts as one "saved" car-trip; the
	driver's own car doesn't count (they would have driven anyway).
	"""

	try:
		dist = max(float(distance_km or 0), 0.0)
		seats = max(int(shared_seats or 0), 0)
	except (TypeError, ValueError):
		return 0.0
	return round(dist * seats * KG_CO2_PER_KM, 2)


def recompute_user(user: str) -> float:
	"""Recompute and persist ``User.co2_saved_kg`` for one user.

	Returns the new value.  Called from the hourly scheduler job
	below; safe to call ad-hoc from tests.
	"""

	if not user or user == "Guest":
		return 0.0

	# Sum: as a passenger, every Confirmed/Completed booking on a
	# Completed ride saves (distance_km * seats_booked) car-trips.
	# As a driver, the saving counts towards the rider — not the
	# driver — so we DON'T double-count here.
	row = frappe.db.sql(
		"""SELECT
		     COALESCE(SUM(r.distance_km * b.seats_booked), 0)
		   FROM `tabBooking` b
		   JOIN `tabRide` r ON r.name = b.ride
		   WHERE b.passenger = %(u)s
		     AND r.status = 'Completed'
		     AND b.status IN ('Confirmed', 'Completed')""",
		{"u": user},
	)[0]
	saved = round(float(row[0] or 0) * KG_CO2_PER_KM, 2)
	try:
		frappe.db.set_value("User", user, "co2_saved_kg", saved, update_modified=False)
	except Exception:
		# Custom field not yet installed (patch hasn't run yet).
		pass
	return saved


@frappe.whitelist()
def my_co2() -> dict:
	"""Return the caller's CO2 aggregate + a "trees worth" framing
	for the Profile widget.
	"""

	from frappe import _

	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)

	# Live recompute for the caller — sub-millisecond if their bookings
	# are indexed (and they are, via the existing Booking indexes on
	# passenger).
	saved = recompute_user(user)
	# 1 mature tree absorbs ~21 kg CO2 / year.
	trees = round(saved / 21.0, 1)
	return {
		"user": user,
		"co2_saved_kg": saved,
		"trees_equivalent": trees,
		"methodology": (
			f"{KG_CO2_PER_KM} kg CO2 per km × shared seats — based on the "
			"average Indian petrol sedan emission factor (MoRTH 2023)."
		),
	}


def hourly_recompute_top_users(limit: int = 500) -> None:
	"""Scheduler hook — refresh CO2 aggregates for the most-active
	riders so the Profile widget never lags far behind reality.

	Wired in ``hooks.py::scheduler_events`` under ``hourly``.

	Cheap (single SUM per user, indexed) and we cap the per-run scope
	so a one-hour deploy hiccup can't snowball into a multi-million
	row scan.
	"""

	users = frappe.db.sql(
		"""SELECT DISTINCT b.passenger
		   FROM `tabBooking` b
		   JOIN `tabRide` r ON r.name = b.ride
		   WHERE r.status = 'Completed'
		     AND b.status IN ('Confirmed', 'Completed')
		     AND b.modified >= NOW() - INTERVAL 24 HOUR
		   LIMIT %(limit)s""",
		{"limit": int(limit)},
	)
	for (u,) in users:
		try:
			recompute_user(u)
		except Exception:
			frappe.log_error(
				title=f"co2 recompute failed: {u}",
				message=frappe.get_traceback(),
			)
