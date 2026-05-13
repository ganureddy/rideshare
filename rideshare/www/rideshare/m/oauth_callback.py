"""Mobile OAuth landing page.

Frappe's standard OAuth flow ends by redirecting the browser to whatever
URL the caller supplied as ``redirect_to`` in the authorize URL state.
For the mobile app we point that to ``/rideshare/m/oauth-callback``,
which:

  1. Asserts the session is no longer Guest (Google completed).
  2. Mints a one-shot **exchange code** (60 s TTL, single use) bound to
     the authenticated user via
     :func:`rideshare.api.auth.mint_mobile_exchange_code`.
  3. Renders an HTML page that bounces the system browser to
     ``rideshare://auth/callback?status=ok&code=<one-shot>``.

The React Native app catches the deep link, calls
``rideshare.api.auth.exchange_mobile_token(code)`` to swap the code for
the actual ``(api_key, api_secret)`` pair, and persists them in
``SecureStore``.  The raw credentials therefore never appear in any
URL the OS / browser / shoulder-surfer can see.
"""

from __future__ import annotations

from urllib.parse import quote

import frappe


def get_context(context):
	context.no_cache = 1
	context.title = "Signing you in…"

	if frappe.session.user == "Guest":
		context.error = (
			"We couldn't complete the Google sign-in. Please try again."
		)
		context.deeplink = "rideshare://auth/callback?status=error&reason=guest"
		return context

	try:
		from rideshare.api.auth import mint_mobile_exchange_code

		code = mint_mobile_exchange_code()
		user_id = frappe.session.user
		full_name = frappe.db.get_value("User", user_id, "full_name") or user_id
	except Exception as exc:
		frappe.log_error(
			title="Mobile OAuth: could not mint exchange code",
			message=frappe.get_traceback(),
		)
		context.error = str(exc) or "Unable to issue exchange code."
		context.deeplink = (
			f"rideshare://auth/callback?status=error&reason={quote(str(exc) or 'unknown')}"
		)
		return context

	# Deep link carries only an opaque, single-use code.  The app trades
	# it for the real api_key/api_secret server-side via
	# rideshare.api.auth.exchange_mobile_token.
	context.error = None
	context.deeplink = f"rideshare://auth/callback?status=ok&code={quote(code)}"
	context.user_full_name = full_name
	return context
