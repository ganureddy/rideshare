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
	# Rideshare end-user (phone-number) login lives at /rideshare/login —
	# backed directly by www/rideshare/login.{html,py}. Frappe's standard
	# email/password backend login stays on /login.
	{"from_route": "/rideshare/signup", "to_route": "signup"},
	# Mobile-only WebView entry points: the OAuth landing page, the deep-link
	# login, the Jinja realtime chat, and checkout. They ship under
	# www/rideshare/m/ — the rules below give them clean URLs.
	{"from_route": "/rideshare/m/oauth-callback", "to_route": "rideshare/m/oauth_callback"},
	{"from_route": "/rideshare/m/chat", "to_route": "rideshare/m/chat"},
	{"from_route": "/rideshare/m/checkout", "to_route": "rideshare/m/checkout"},
	{"from_route": "/rideshare", "to_route": "index"},
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
	# Every Website User created via any path (phone signup, Google
	# OAuth, Apple, an admin manually adding one) gets the Rider role
	# so they can immediately call the Rideshare API.  Phone signup
	# also adds the role inline, so this hook is just the backstop
	# for OAuth-created users.
	"User": {
		"after_insert": "rideshare.api.auth.ensure_rider_role",
	},
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
		"rideshare.api.co2.hourly_recompute_top_users",
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
# Login / logout — chat presence integration (Raven-style).
# Each hook runs once per session lifecycle event; both are idempotent.
# ---------------------------------------------------------------------------
on_login = "rideshare.api.presence.on_login"
on_logout = "rideshare.api.presence.on_logout"

# ---------------------------------------------------------------------------
# Passive presence heartbeat — refreshes the caller's "online" marker on
# every authenticated REST call.  Cheap (one Redis SET ... EX) and means
# we don't need the mobile app to ping us every 30 s explicitly to stay
# online.  See `rideshare.api.presence` for cache shape and TTL.
# ---------------------------------------------------------------------------
before_request = ["rideshare.api.presence.passive_heartbeat"]

# ---------------------------------------------------------------------------
# Translation files (we ship en, hi, ta starting Phase 10 — keep folder).
# ---------------------------------------------------------------------------
# translations are auto-discovered under `rideshare/translations/`.

# ---------------------------------------------------------------------------
# Test setup
# ---------------------------------------------------------------------------
before_tests = "rideshare.install.before_tests"
