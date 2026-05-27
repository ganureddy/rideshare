"""HTML + JS Jinja chat page for the mobile WebView.

Auth flow
---------
1. The native React Native shell calls
   ``rideshare.api.chat.issue_chat_session_code(thread)`` over the
   authenticated REST channel.  That endpoint mints a 60 s, single-use,
   thread-bound exchange code and returns it.
2. The shell loads ``/rideshare/m/chat?thread=<id>&code=<one-shot>``
   inside ``react-native-webview``.
3. This view redeems the code, opens a cookie session for the bound
   user, and **HTTP 302 redirects** the WebView to a clean
   ``/rideshare/m/chat?thread=<id>`` URL — so the credentials never
   appear in browser history, nginx access logs or the WebView's
   navigation stack.
4. The cookie session is what Frappe's Socket.IO bridge authenticates
   against, so realtime chat (rideshare:chat:message + :typing) lights
   up immediately on page render.

Defence in depth
----------------
* No raw ``api_key`` / ``api_secret`` is ever read from the URL query
  string.
* The exchange code is single-use and expires 60 seconds after issue.
* The exchange code carries the thread id it was minted for; this view
  refuses to bind a session to a different conversation than the one
  the user actually authorised.
* If the WebView already has a cookie session (a likely path once
  redirect-to-clean-URL has fired), the code path is skipped entirely
  and the page renders straight from the existing session.
"""

from __future__ import annotations

from urllib.parse import quote

import frappe
from frappe import _


def get_context(context):
	context.no_cache = 1
	context.show_sidebar = 0
	context.title = "Chat"

	thread_name = (frappe.form_dict.get("thread") or "").strip()
	code = (frappe.form_dict.get("code") or "").strip()

	# 1. Bootstrap a cookie session from the one-shot exchange code, if
	#    we haven't already.
	if frappe.session.user == "Guest" and code:
		from rideshare.api.chat import consume_chat_session_code

		bound = consume_chat_session_code(code) or {}
		bound_user = bound.get("user")
		bound_thread = bound.get("thread")
		if bound_user and bound_thread:
			# Codes are scoped to one thread.  Refuse to grant access to
			# a different conversation than the code authorised.
			if thread_name and thread_name != bound_thread:
				context.error = "This sign-in link doesn't match the requested chat."
				return context
			try:
				frappe.local.login_manager.user = bound_user
				frappe.local.login_manager.post_login()
			except (AttributeError, RuntimeError):
				frappe.set_user(bound_user)

	# 2. After bootstrap, kick the browser to a clean URL so the code
	#    doesn't sit around in window.location / WebView history.
	if code and frappe.session.user != "Guest":
		clean = "/rideshare/m/chat"
		if thread_name:
			clean += f"?thread={quote(thread_name)}"
		frappe.local.flags.redirect_location = clean
		raise frappe.Redirect

	user = frappe.session.user
	if user == "Guest":
		context.error = "Please sign in to view this conversation."
		return context

	if not thread_name:
		context.error = "Missing chat thread id."
		return context

	thread = frappe.db.get_value(
		"Chat Thread",
		thread_name,
		["name", "thread_type", "subject", "status", "driver", "passenger", "ride", "booking"],
		as_dict=True,
	)
	if not thread:
		context.error = "This conversation doesn't exist."
		return context

	support_roles = {"Support Agent", "Rideshare Admin", "System Manager"}
	roles = set(frappe.get_roles(user))
	if user not in (thread.driver, thread.passenger) and not (roles & support_roles):
		context.error = "You don't have access to this conversation."
		return context

	# Decide my role for client-side rendering.
	my_role = "Unknown"
	if user == thread.driver:
		my_role = "Driver"
	elif user == thread.passenger:
		my_role = "Passenger"
	elif roles & support_roles:
		my_role = "Support"

	# Counterparty display name + phone (phone gated to Confirmed
	# bookings — same trust boundary as the native chat header).
	counterparty_user = thread.driver if user == thread.passenger else thread.passenger
	counterparty_label = "Rideshare"
	counterparty_phone = None
	if counterparty_user:
		row = frappe.db.get_value(
			"User", counterparty_user, ["full_name", "first_name", "mobile_no"], as_dict=True
		) or {}
		counterparty_label = row.get("full_name") or row.get("first_name") or counterparty_user
		# Only reveal phone once a booking on this thread is Confirmed.
		if thread.booking:
			b_status = frappe.db.get_value("Booking", thread.booking, "status")
			if b_status in ("Confirmed", "Completed"):
				counterparty_phone = row.get("mobile_no")

	# Last 100 messages — same shape the native chat uses.
	messages = frappe.db.sql(
		"""SELECT name, sender, sender_role, body, sent_at, is_system
		   FROM `tabChat Message`
		   WHERE thread = %s
		   ORDER BY sent_at DESC, name DESC
		   LIMIT 100""",
		thread_name,
		as_dict=True,
	)
	messages.reverse()

	# Hydrate sender display data once.
	user_ids = list({m["sender"] for m in messages if m.get("sender")})
	user_meta = {}
	if user_ids:
		for u in frappe.db.get_all(
			"User",
			filters={"name": ["in", user_ids]},
			fields=["name", "full_name", "user_image"],
		):
			user_meta[u.name] = u
	for m in messages:
		um = user_meta.get(m["sender"]) or {}
		m["sender_name"] = um.get("full_name") or m["sender"]
		m["sender_image"] = um.get("user_image")
		m["sent_at_iso"] = m["sent_at"].isoformat() if m.get("sent_at") else None

	context.thread = thread
	context.messages = messages
	context.my_role = my_role
	context.counterparty = {
		"user": counterparty_user,
		"label": counterparty_label,
		"phone": counterparty_phone,
	}
	context.csrf_token = frappe.sessions.get_csrf_token()
	context.error = None
	return context
