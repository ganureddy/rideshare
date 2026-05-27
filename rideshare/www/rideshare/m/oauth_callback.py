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

DEFAULT_RETURN_TO = "rideshare://auth/callback"


def _resolve_return_to() -> str:
	"""Pick the deep-link prefix the device should be bounced to.

	The mobile app passes its own ``Linking.createURL("auth/callback")``
	value through ``google_login_url`` → preserved in Frappe's OAuth
	state → echoed back as a ``return_to`` query param when this page
	is finally rendered.

	We only honour values that look like a mobile/app scheme so this
	endpoint can't be turned into an open redirector that hands an
	exchange code to a third-party origin.
	"""

	candidate = (frappe.form_dict.get("return_to") or "").strip()
	if candidate.startswith(("rideshare://", "exp://")):
		return candidate
	return DEFAULT_RETURN_TO


def _build_deeplink(base: str, params: dict[str, str]) -> str:
	sep = "&" if "?" in base else "?"
	pairs = "&".join(f"{k}={quote(v)}" for k, v in params.items())
	return f"{base}{sep}{pairs}"


def get_context(context):
	context.no_cache = 1
	context.title = "Signing you in…"

	return_to = _resolve_return_to()

	if frappe.session.user == "Guest":
		context.error = (
			"We couldn't complete the Google sign-in. Please try again."
		)
		context.deeplink = _build_deeplink(
			return_to, {"status": "error", "reason": "guest"}
		)
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
		context.deeplink = _build_deeplink(
			return_to,
			{"status": "error", "reason": str(exc) or "unknown"},
		)
		return context

	# Deep link carries only an opaque, single-use code.  The app trades
	# it for the real api_key/api_secret server-side via
	# rideshare.api.auth.exchange_mobile_token.
	context.error = None
	context.deeplink = _build_deeplink(return_to, {"status": "ok", "code": code})
	context.user_full_name = full_name
	return context


