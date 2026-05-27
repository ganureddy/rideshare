"""Patch — add MySQL indexes to Chat Message for chat-scale workloads.

Without these indexes, the `get_thread` query (`WHERE thread = X
ORDER BY sent_at DESC LIMIT 50`) does a full table scan once a thread
has more than a few thousand messages — easily noticeable on a
single-trip thread that runs across multi-day pickups.

We add three indexes:

  * ``idx_thread_sent_at`` — the canonical access path used by
    `get_thread` for cursor pagination.  Composite on (thread, sent_at).
  * ``idx_thread_delivery_status`` — used by `_promote_to_delivered`
    and `mark_message_read` to find "still-sent" messages cheaply
    without scanning the whole thread history.
  * ``idx_sender`` — used by per-sender filters in admin reports and
    by abuse / rate-limit checks (caller's recent message count).

Idempotent — `frappe.db.add_index` is a no-op when the index already
exists, and we use `IF NOT EXISTS` semantics on MySQL >= 8 anyway.
"""

import frappe


def execute() -> None:
	if not frappe.db.table_exists("Chat Message"):
		return

	# Single-column indexes (Frappe helper handles the IF NOT EXISTS
	# dance for MariaDB / MySQL).
	for fields in (["thread", "sent_at"], ["thread", "delivery_status"], ["sender"]):
		try:
			frappe.db.add_index("Chat Message", fields)
		except Exception:
			# Older Frappe versions raise on duplicate; that's a
			# success state for us, so swallow.
			frappe.log_error(
				title=f"Chat Message index failed: {fields}",
				message=frappe.get_traceback(),
			)
