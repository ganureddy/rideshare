"""Mobile-app deep-link login page served at ``/rideshare/login``.

This is the URL the React Native app sends users to for any flow that
needs to bounce through the browser (e.g. magic links from SMS, OAuth
callbacks). It also doubles as a web fallback so testers can sign in
from a browser when the APK isn't installed yet.

The page renders a slim phone-number form, calls the same
``rideshare.api.auth.login_or_signup`` endpoint as the public web flow,
and — when present — closes itself by redirecting to the app deep-link
``rideshare://auth?token=...``.

Note: the *primary* mobile auth path is the native ``login_with_phone``
JSON endpoint (returns api_key/secret). This web page exists for the
``?next=`` deep-link case and for QA convenience.
"""

from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	context.title = "Rideshare — Log in"
	# Always render the page; if the user is already logged in we still want
	# them to see a "you're signed in — open the app" CTA rather than
	# auto-bouncing to /me.
	context.is_authenticated = frappe.session.user != "Guest"
	context.user = frappe.session.user if context.is_authenticated else None
	return context
