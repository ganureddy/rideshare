"""Unit tests for ``rideshare.utils.geo``."""

from __future__ import annotations

from frappe.tests.utils import FrappeTestCase

from rideshare.utils.geo import (
	LatLng,
	bbox_km,
	estimate_duration_minutes,
	format_distance,
	haversine_km,
)


class TestGeoHelpers(FrappeTestCase):
	def test_latlng_validates_range(self):
		LatLng(0, 0)  # ok
		with self.assertRaises(ValueError):
			LatLng(91, 0)
		with self.assertRaises(ValueError):
			LatLng(0, 181)

	def test_haversine_known_distance_delhi_mumbai(self):
		# Delhi → Mumbai great-circle ≈ 1148 km (±5 km tolerance)
		delhi = LatLng(28.6139, 77.2090)
		mumbai = LatLng(19.0760, 72.8777)
		self.assertAlmostEqual(haversine_km(delhi, mumbai), 1148.0, delta=5)

	def test_haversine_zero_for_same_point(self):
		p = LatLng(12.34, 56.78)
		self.assertEqual(haversine_km(p, p), 0.0)

	def test_bbox_km_contains_centre(self):
		centre = LatLng(28.6, 77.2)
		min_lat, min_lng, max_lat, max_lng = bbox_km(centre, 50)
		self.assertLess(min_lat, centre.lat)
		self.assertGreater(max_lat, centre.lat)
		self.assertLess(min_lng, centre.lng)
		self.assertGreater(max_lng, centre.lng)
		# A 50 km bbox at lat=28.6 spans roughly 0.45° lat and 0.51° lng.
		self.assertAlmostEqual(max_lat - min_lat, 50 * 2 / 111.0, delta=0.01)

	def test_bbox_km_rejects_non_positive(self):
		with self.assertRaises(ValueError):
			bbox_km(LatLng(0, 0), 0)

	def test_format_distance(self):
		self.assertEqual(format_distance(None), "")
		self.assertEqual(format_distance(0.4), "400 m")
		self.assertEqual(format_distance(2.5), "2.5 km")
		self.assertEqual(format_distance(123.6), "124 km")

	def test_estimate_duration_minutes(self):
		self.assertEqual(estimate_duration_minutes(0), 0)
		self.assertEqual(estimate_duration_minutes(55, avg_kmph=55), 60)
		self.assertEqual(estimate_duration_minutes(110, avg_kmph=55), 120)
