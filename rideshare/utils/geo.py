"""Geographic helpers — distance, bearing, bounding-box.

Used by:
- price suggestion (₹/km × distance) in Phase 3,
- search ranking + bounding-box pre-filter in Phase 4,
- map preview formatting (Jinja).

We deliberately keep these dependency-free (math only) so the search
endpoint can be hot — no `requests`, no DB hops.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_RADIUS_KM: float = 6371.0088


@dataclass(frozen=True, slots=True)
class LatLng:
	"""Immutable point on the WGS84 sphere."""

	lat: float
	lng: float

	def __post_init__(self) -> None:
		if not -90.0 <= self.lat <= 90.0:
			raise ValueError(f"latitude {self.lat} out of range")
		if not -180.0 <= self.lng <= 180.0:
			raise ValueError(f"longitude {self.lng} out of range")


def haversine_km(a: LatLng, b: LatLng) -> float:
	"""Great-circle distance in km using the haversine formula."""

	lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
	dlat = lat2 - lat1
	dlng = math.radians(b.lng - a.lng)

	h = (
		math.sin(dlat / 2) ** 2
		+ math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
	)
	return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def bbox_km(centre: LatLng, radius_km: float) -> tuple[float, float, float, float]:
	"""Return (min_lat, min_lng, max_lat, max_lng) for a square bbox.

	Approximate — fine for SQL pre-filters; we re-run haversine on the
	candidate set for exact ranking.
	"""

	if radius_km <= 0:
		raise ValueError("radius_km must be positive")
	lat_delta = radius_km / 111.0
	lng_delta = radius_km / (111.0 * max(math.cos(math.radians(centre.lat)), 1e-6))
	return (
		centre.lat - lat_delta,
		centre.lng - lng_delta,
		centre.lat + lat_delta,
		centre.lng + lng_delta,
	)


def format_distance(km: float | None) -> str:
	"""Pretty-print a distance for templates.  ``None`` → empty string."""

	if km is None:
		return ""
	if km < 1:
		return f"{int(round(km * 1000))} m"
	if km < 10:
		return f"{km:.1f} km"
	return f"{int(round(km))} km"


def estimate_duration_minutes(distance_km: float, avg_kmph: float = 55.0) -> int:
	"""Rough ETA used until OSRM is wired up in Phase 3."""

	if distance_km <= 0 or avg_kmph <= 0:
		return 0
	return int(round(distance_km / avg_kmph * 60))
