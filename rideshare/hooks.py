"""Frappe hooks for the Rideshare app (BlaBlaCar-style carpooling).

Stay declarative — every callable referenced here must exist as importable
Python in this app. Keep this file the single source of truth for cross-cutting
behaviour (events, scheduler, fixtures, asset bundles, jinja).
"""

from __future__ import annotations

app_name = "rideshare"
app_title = "Rideshare"
app_publisher = "Rideshare"
app_description = (
	"A BlaBlaCar-style intercity carpooling marketplace built on Frappe v15."
)
app_email = "team@rideshare.local"
app_license = "mit"

# ---------------------------------------------------------------------------
# Required apps
# ---------------------------------------------------------------------------
required_apps = ["frappe"]

# ---------------------------------------------------------------------------
# Asset bundles (loaded by Frappe Desk + public website)
# ---------------------------------------------------------------------------
web_include_css = "/assets/rideshare/css/rideshare.css"
web_include_js = "/assets/rideshare/js/rideshare.js"

# ---------------------------------------------------------------------------
# Website routes (public-facing pages live in `rideshare/www/` and
# `rideshare/templates/pages/`).  More are added per phase.
# ---------------------------------------------------------------------------
website_route_rules = [
	{"from_route": "/rides/<ride_name>", "to_route": "rides/ride"},
	{"from_route": "/u/<username>", "to_route": "u/profile"},
]

home_page = "index"

# ---------------------------------------------------------------------------
# Jinja extensions for portal pages and emails
# ---------------------------------------------------------------------------
jinja = {
	"methods": [
		"rideshare.utils.money.format_paise",
		"rideshare.utils.money.paise_to_rupees",
		"rideshare.utils.geo.format_distance",
	],
	"filters": [],
}

# ---------------------------------------------------------------------------
# Installation lifecycle
# ---------------------------------------------------------------------------
after_install = "rideshare.install.after_install"
before_uninstall = "rideshare.install.before_uninstall"

# ---------------------------------------------------------------------------
# Document Events  (cross-cutting only — keep doctype-specific logic in
# the doctype controller class).
# ---------------------------------------------------------------------------
doc_events: dict = {
	# Filled in later phases.  Phase 1 has no triggers yet.
}

# ---------------------------------------------------------------------------
# Scheduler  (jobs are wired in their respective phases.  Stubs here are
# real callables that return early when their feature is not yet active —
# never decorative no-ops.)
# ---------------------------------------------------------------------------
scheduler_events = {
	"hourly": [
		"rideshare.tasks.hourly.expire_pending_bookings",
		"rideshare.tasks.hourly.release_due_escrows",
	],
	"daily": [
		"rideshare.tasks.daily.auto_complete_overdue_trips",
		"rideshare.tasks.daily.cleanup_orphaned_otp_tokens",
	],
	"cron": {
		"*/5 * * * *": [
			"rideshare.tasks.cron.refresh_ride_search_cache",
		],
	},
}

# ---------------------------------------------------------------------------
# Fixtures — exported on `bench export-fixtures` and re-imported on
# `bench --site … migrate`.  Roles ship with v1; more are added per phase.
# ---------------------------------------------------------------------------
fixtures = [
	{
		"dt": "Role",
		"filters": [
			[
				"name",
				"in",
				[
					"Rider",
					"Driver",
					"Verified Driver",
					"Rideshare Admin",
					"Support Agent",
				],
			]
		],
	},
]

# ---------------------------------------------------------------------------
# Permission helpers  (registered in later phases; keep references commented
# until those modules exist so the boot loader stays clean).
# ---------------------------------------------------------------------------
# permission_query_conditions = {
# 	"Ride": "rideshare.api.permissions.ride_query",
# }
# has_permission = {
# 	"Ride": "rideshare.api.permissions.has_ride_permission",
# }

# ---------------------------------------------------------------------------
# Authentication hook  (used in Phase 2 to attach OTP / phone-verified gating).
# ---------------------------------------------------------------------------
# auth_hooks = ["rideshare.auth.validate"]

# ---------------------------------------------------------------------------
# Translation files (we ship en, hi, ta starting Phase 10 — keep folder).
# ---------------------------------------------------------------------------
# translations are auto-discovered under `rideshare/translations/`.

# ---------------------------------------------------------------------------
# Test setup
# ---------------------------------------------------------------------------
before_tests = "rideshare.install.before_tests"
