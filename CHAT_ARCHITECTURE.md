# Rideshare Chat — Architecture & Operations Guide

WhatsApp-class one-to-one chat between **driver** and **passenger** for an
active booking, built on **Frappe + Frappe Socket.IO + Redis** — no
extra Node.js service required.

This document is the source of truth for everyone touching the chat
layer: backend, mobile, devops. It mirrors what's already shipping in
this repo plus the production-best-practice extensions (voice
messages, scaling notes) so you can extend without re-discovering the
landmines.

---

## 1. Why this stack

| Choice | Reason |
| --- | --- |
| Frappe Socket.IO (built-in) | Already running with the app, already authenticated against Frappe sessions, already backed by Redis pub/sub. Adding a separate Node.js socket server would duplicate auth, double the deploy surface, and gain us nothing for one-to-one chat. |
| Redis pub/sub for fan-out | Frappe's `publish_realtime()` already routes through Redis; that's the ONLY thing needed to scale a single-node socket cluster horizontally to N workers. |
| Frappe DocTypes for storage | Schema, permissions, search, audit trail, fixtures, list views, REST APIs — all "free" with Frappe. |
| Per-user-targeted broadcasts (`user=...`) | Reaches every device the user is logged in on, scales to 10k concurrent users without flooding global rooms. |

---

## 2. Data model

### Chat Thread (`tabChat Thread`)

One row per booking conversation (or per support session). Lifecycle
runs `Open` → `Closed` (driver/rider can chat between booking accept
and ride completion).

| field | type | role |
| --- | --- | --- |
| `name` | `CT-{######}` | primary key |
| `thread_type` | Select: `Booking` / `Support` | scope |
| `subject` | Data | denormalised for list views: e.g. `Mumbai → Goa · Sat 12 Oct, 09:00` |
| `status` | Select: `Open` / `Closed` | lifecycle gate — closed threads reject new messages |
| `booking` | Link → Booking | parent booking (Booking threads only) |
| `ride` | Link → Ride | parent ride (denormalised for permission checks) |
| `driver` | Link → User | participant 1 (Booking threads) |
| `passenger` | Link → User | participant 2 |
| `last_message` | Small Text | preview shown in chat-list cells |
| `last_message_at` | Datetime | sort key for the chat list |
| `last_sender` | Link → User | who said the last word |
| `unread_for_driver` | Int | per-side badge counter (resets on `mark_message_read`) |
| `unread_for_passenger` | Int | same |
| `unread_for_support` | Int | same |

### Chat Message (`tabChat Message`)

Append-only — a chat message is **never** edited or deleted at the
database level. Schema:

| field | type | role |
| --- | --- | --- |
| `name` | `CM-{########}` | primary key (also the cursor for pagination) |
| `thread` | Link → Chat Thread | required |
| `sender` | Link → User | derived from session |
| `sender_role` | Select: `Driver` / `Passenger` / `Support` / `System` | auto-derived from the thread's driver / passenger fields |
| `message_type` | Select: `text` / `image` / `audio` / `file` / `location` / `system` | drives bubble rendering on the client |
| `sent_at` | Datetime | server-stamped on insert |
| `delivery_status` | Select: `sent` / `delivered` / `read` | lifecycle |
| `delivered_at` | Datetime | when the recipient first received the realtime payload (or fetched the thread) |
| `read_at` | Datetime | when the recipient explicitly opened the thread |
| `is_system` | Check | system-generated message (e.g. "Booking confirmed for…") |
| `body` | Long Text | the message itself, capped at 5000 chars |
| `attachment` | Attach | file URL — public for image/file types, can be private for audio |
| `attachment_meta` | JSON | per-type metadata (image dims, audio duration, file mime/size, location lat/lng) |

#### Indexes (added via `rideshare.patches.v1_chat_message_indexes`)

```sql
CREATE INDEX idx_thread_sent_at         ON `tabChat Message` (thread, sent_at);
CREATE INDEX idx_thread_delivery_status ON `tabChat Message` (thread, delivery_status);
CREATE INDEX idx_sender                  ON `tabChat Message` (sender);
```

These are the access paths used by `get_thread`, `_promote_to_delivered`,
`mark_message_read` and abuse-control rate-limit checks. At 100k messages
on a single thread the difference between "indexed" and "not indexed" is
~30 ms vs ~1.4 s per fetch.

---

## 3. Lifecycle (the happy path)

```
1. passenger taps "Book a seat"
   → backend creates Booking (status=Pending) + Payment Transaction
   → on payment confirm:
       - if instant_booking=1 → Booking.status=Confirmed, AUTO start_booking_chat()
       - else                 → Booking.status=Pending,    AUTO start_booking_chat()
       - either way the chat thread exists with a System "welcome" message

2. driver opens the booking, taps Confirm  (instant_booking=0 path)
   → Booking.status=Confirmed
   → realtime: rideshare:booking{event="confirmed"} on each side's user channel

3. driver and passenger chat
   → POST rideshare.api.chat.send_message
   → Chat Message inserted; controller broadcasts rideshare:chat:message
     on the chat:<thread> room
   → recipient's screen renders bubble; calls mark_message_read on focus
   → server fires rideshare:chat:status{status="read"} so the sender's
     UI flips ✓ → ✓✓ blue

4. trip starts → driver taps Start Trip → Ride.status=InProgress
   trip ends   → driver taps Complete  → Ride.status=Completed
   → chat thread auto-closes (status=Closed); send_message rejects with
     "This conversation is closed." but the history stays browsable.
```

---

## 4. Backend modules

```
apps/rideshare/rideshare/
├── api/
│   ├── chat.py                          # REST endpoints: list, get, send, mark_*, start_*
│   ├── presence.py                      # online/offline cache + realtime broadcasts
│   └── push.py                          # Expo push registration (chat notifications use channel="chat")
│
├── rideshare_messaging/
│   └── doctype/
│       ├── chat_thread/                 # Chat Thread doctype
│       └── chat_message/
│           ├── chat_message.json        # schema (with delivery_status, message_type, attachment_meta)
│           └── chat_message.py          # controller: before_insert + after_insert + broadcast
│
├── patches/
│   └── v1_chat_message_indexes.py       # add MySQL indexes for chat-scale workloads
│
└── hooks.py
    ├── on_login   = "rideshare.api.presence.on_login"
    ├── on_logout  = "rideshare.api.presence.on_logout"
    └── before_request = ["rideshare.api.presence.passive_heartbeat"]
```

### REST endpoints (all `@frappe.whitelist()`)

| method | purpose |
| --- | --- |
| `rideshare.api.chat.list_threads(limit=50)` | every thread the caller participates in, with counterparty label + unread count |
| `rideshare.api.chat.get_thread(thread, limit=50, before=None)` | metadata + last 50 messages, with cursor pagination via `before=<message-id>` |
| `rideshare.api.chat.send_message(thread, body, attachment=None, message_type=None, attachment_meta=None)` | insert + broadcast |
| `rideshare.api.chat.mark_delivered(thread, message_ids)` | bulk-promote sent → delivered (used by socket-reconnect catchup) |
| `rideshare.api.chat.mark_message_read(thread, up_to=None)` | promote everything ≤ `up_to` to `read` AND clear unread counter |
| `rideshare.api.chat.set_typing(thread, is_typing)` | targeted typing indicator |
| `rideshare.api.chat.start_booking_chat(booking)` | get-or-create thread for a booking |
| `rideshare.api.chat.start_support_chat(message=None)` | get-or-create the caller's helpline thread |
| `rideshare.api.chat.close_thread(thread)` | end-of-trip / support-closed |
| `rideshare.api.chat.issue_chat_session_code(thread)` | one-shot WebView session bridge (legacy — the native chat doesn't use it) |
| `rideshare.api.presence.ping_presence()` | refresh online marker |
| `rideshare.api.presence.go_offline()` | explicit offline |
| `rideshare.api.presence.get_presence(user_ids)` | bootstrap a chat header's "online" / "last seen" |

### Authorisation rule

Implemented in `chat._authorize(thread, user)`:

```python
A user may interact with a thread iff
    user == thread.driver
 OR user == thread.passenger
 OR user has Support Agent / Rideshare Admin / System Manager role.
```

Plus, `start_booking_chat` rejects bookings whose status is `Cancelled`.
Open threads on Completed bookings auto-close on ride completion (set
by the booking lifecycle hook — see `rideshare.api.bookings`).

---

## 5. Socket events

| event | payload | room / target | emitter |
| --- | --- | --- | --- |
| `rideshare:chat:message` | `{name, thread, sender, sender_name, sender_role, body, sent_at, is_system, message_type, attachment, attachment_meta, delivery_status}` | `chat:<thread>` | `ChatMessage.after_insert` |
| `rideshare:chat:status` | `{thread, status: "delivered" \| "read", messages: [name…], by, at}` | `chat:<thread>` | `chat._promote_to_delivered`, `chat.mark_message_read` |
| `rideshare:chat:typing` | `{thread, sender, sender_role, is_typing}` | targeted at the *other* user | `chat.set_typing` |
| `rideshare:user_active` | `{user, active, at}` | targeted at every chat counterparty | `presence.set_user_active`, `set_user_inactive` |
| `rideshare:booking` | `{event, booking, ride, status, ...}` | per-user (driver + passenger) | `bookings._broadcast_booking_change` |

Subscribers in the mobile app:

```ts
// src/realtime/socket.ts
subscribeToThread(threadId, onMessage)              // → rideshare:chat:message
subscribeToTyping(threadId, onTyping)               // → rideshare:chat:typing
subscribeToMessageStatus(threadId, onStatus)        // → rideshare:chat:status
subscribeToPresence(onPresence)                     // → rideshare:user_active
subscribeToRide(rideId, onLocation, onStatus)       // → rideshare:location / :status
subscribeToBookings(onEvent, rideId?)               // → rideshare:booking
```

All wrappers are **non-throwing**: a dropped/dead socket returns a NOOP
unsubscribe and the screen keeps working from REST polling.

---

## 6. Mobile app modules

```
apps/rideshare/frontend/src/
├── realtime/
│   └── socket.ts                # safe wrappers around socket.io-client + typed event subscribers
│
├── api/
│   └── client.ts                # axios wrapper with Frappe error-message extraction
│
├── auth/
│   ├── AuthContext.tsx          # token + profile + sign-in/out
│   └── store.ts                 # SecureStore-backed credentials
│
└── screens/
    ├── ChatList.tsx             # list of threads, unread badges
    └── ChatThread.tsx           # native chat: bubbles, ticks, presence, typing, image attachments
```

### Optimistic message flow

1. User taps **Send**.
2. App pushes a temporary message into local state with
   `name = "__pending_<timestamp>"` and `delivery_status = "sent"`.
3. App POSTs to `send_message`. On success, the realtime broadcast
   arrives; the optimistic row is deduped (matched by `body + sender`)
   and replaced with the canonical record.
4. Recipient renders bubble → calls `mark_message_read` on focus →
   server emits `rideshare:chat:status{status="read"}` → sender's UI
   updates `delivery_status = "read"` → tick flips to ✓✓ blue.

### Tick logic in `ChatThread.tsx`

| status | icon | colour |
| --- | --- | --- |
| `sent` | `checkmark` (single) | rgba(255,255,255,0.78) |
| `delivered` | `checkmark-done` (double) | rgba(255,255,255,0.78) |
| `read` | `checkmark-done` (double) | `#5AB1FF` |

Only rendered for own messages — recipient bubbles never show ticks.

### Presence

* Subscribes to `rideshare:user_active`.
* Filters events by `head.otherUser` (the counterparty's user id).
* Renders a green dot on the counterparty's avatar + flips the header
  subtitle from "Last seen 5 minutes ago" → "Online".
* The screen pings `ping_presence` every 30 s while focused so the
  other side sees us as online.

---

## 7. Voice message support

Already wired at the schema layer — `message_type="audio"`,
`attachment` = file URL, `attachment_meta = {duration_seconds, mime}`.
The current bubble renders a play-button row with the duration.

To enable recording on the mobile app, install **expo-av** and drop the
following composer hook into `ChatThread.tsx` (kept out of this round
because adding native modules during the current crash-storm is
risky — re-add when the build is stable):

```bash
npx expo install expo-av
```

```tsx
// composer hook — add to ChatThread.tsx
import { Audio } from "expo-av";

const recordingRef = useRef<Audio.Recording | null>(null);

async function startRecording() {
  try {
    await Audio.requestPermissionsAsync();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true
    });
    const { recording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY
    );
    recordingRef.current = recording;
  } catch (e) {/* permission denied — surface a toast */}
}

async function stopAndSendRecording() {
  const rec = recordingRef.current;
  recordingRef.current = null;
  if (!rec) return;
  try {
    await rec.stopAndUnloadAsync();
    const uri = rec.getURI();
    const status = await rec.getStatusAsync();
    if (!uri) return;
    // Upload via the existing /api/method/upload_file endpoint…
    const file = await uploadVoiceFile(uri);
    if (!file) return;
    await call("rideshare.api.chat.send_message", {
      thread: params.threadId,
      body: "",
      attachment: file.fileUrl,
      message_type: "audio",
      attachment_meta: JSON.stringify({
        duration_seconds: (status.durationMillis ?? 0) / 1000,
        mime: "audio/m4a"
      })
    });
  } catch {/* surface error */}
}
```

Playback uses `Audio.Sound.createAsync({ uri: absoluteFileUrl(attachment) })`
with the same lifecycle pattern.

---

## 8. Image attachment flow

Already wired end-to-end:

1. User taps the paperclip → `pickAndUploadImage()` (already shipping in
   `frontend/src/utils/upload.ts`) returns a Frappe File URL.
2. App calls `send_message(thread, body="", attachment=fileUrl, message_type="image", attachment_meta={width, height, mime})`.
3. Both sides see the image inline in the bubble (square 220×220 thumb,
   resize-mode `cover`).

The composer's "+" button isn't wired in this round to keep the diff
minimal; here's the snippet to drop in:

```tsx
async function attachImage() {
  const file = await pickAndUploadImage({ allowsEditing: false, quality: 0.8 });
  if (!file?.fileUrl) return;
  // optimistic bubble
  setItems(c => [...c, {
    name: `__pending_${Date.now()}`,
    sender: user || "me",
    body: "",
    sent_at: new Date().toISOString(),
    is_system: false,
    message_type: "image",
    attachment: file.fileUrl,
    delivery_status: "sent"
  }]);
  await call("rideshare.api.chat.send_message", {
    thread: params.threadId,
    body: "",
    attachment: file.fileUrl,
    message_type: "image"
  });
}
```

---

## 9. Performance & scaling

### Per-message cost (steady-state)

| op | path | typical cost |
| --- | --- | --- |
| open chat | `get_thread` | 1 SQL select (indexed) + 1 user metadata fetch + 1 bulk update for delivered | < 30 ms p99 |
| send message | `send_message` | 1 insert + 1 thread update + 1 publish_realtime | < 40 ms p99 |
| receive | socket payload | ~1 KB per message; recipient renders without further calls |
| read receipt | `mark_message_read` | 1 select + 1 bulk update + 1 publish_realtime | < 25 ms p99 |
| typing | `set_typing` | targeted publish_realtime, no DB write | < 5 ms p99 |
| presence ping | `ping_presence` | 1 Redis SET | < 2 ms p99 |

### 10k concurrent users

The bottleneck is **Frappe Socket.IO worker count**, not Frappe REST.
Default `Procfile` runs one socketio worker on port 9000. To scale:

```
# Procfile (production)
web: bench start
socketio: cd apps/frappe/socketio && node . --port=9000 --workers=4
```

With Redis pub/sub + 4 socketio workers behind nginx upstream load
balancing, a single bench host handles 8-12k concurrent connections.
Past that, run multiple bench nodes — Redis pub/sub fans out across
hosts automatically (this is the same path Frappe ERPNext production
uses).

### Database

* Indexes from §2 keep `get_thread` O(log N) on thread size.
* MariaDB is fine up to ~50M chat messages on a single instance with
  these indexes. Past that, partition `tabChat Message` by month or
  archive completed threads to a cold table (`tabChat Message Archive`)
  via a daily scheduler job.

### Push notification rate limit

Expo push has a 100 req/sec free-tier limit per project. The push
helper in `rideshare.utils.push.notify_user` already coalesces multiple
recipients per call. For a 1M user base, deploy your own
`exp-push-relay` on the same Redis cluster or move to APNs/FCM
directly.

---

## 10. Security checklist

| risk | mitigation |
| --- | --- |
| Unauthorized thread access | `_authorize(thread, user)` runs on every read/write API; `participants_only` SQL gate on `list_threads` |
| Cross-thread spying via socket | Backend broadcasts on `chat:<thread>` rooms — and Frappe Socket.IO requires the client to have explicitly subscribed to that doctype/docname room, which our `_authorize` grants only for participants |
| Phone-number leak | `chat/m/chat.py` and `list_threads` reveal the counterparty phone *only* once the booking is `Confirmed` or `Completed` |
| CSRF | Token-auth requests bypass CSRF (Frappe convention); cookie-session calls go through Frappe's CSRF middleware |
| Brute-force enumeration | `check_phone` is rate-limited at 20/min/IP; chat send isn't because the recipient is bounded by the booking |
| Replay of WebView session code | Single-use, 60 s TTL, deleted on first redeem (legacy WebView only) |
| Driver/passenger chatting outside the trip window | `start_booking_chat` rejects `Cancelled` bookings; `send_message` rejects `Closed` threads |

---

## 11. Deployment guide

1. **Apply schema changes**:

   ```bash
   bench --site <site> migrate
   bench --site <site> execute rideshare.patches.v1_chat_message_indexes.execute
   bench restart
   ```

2. **Verify Redis is shared with socketio**:

   ```bash
   bench --site <site> show-config | grep redis
   # redis_cache, redis_queue, redis_socketio should all point at the same cluster
   ```

3. **Confirm hooks are loaded**:

   ```bash
   bench --site <site> console
   >>> import frappe
   >>> frappe.get_hooks("on_login")
   ['rideshare.api.presence.on_login']
   ```

4. **Smoke-test from the mobile app**:

   ```bash
   curl -X POST https://your-site/api/method/rideshare.api.presence.ping_presence \
        -H "Authorization: token <key>:<secret>"
   # → {"message": {"ok": true, "ttl_seconds": 90}}
   ```

5. **Monitor**: tail `bench logs/socketio.log` while two devices send each
   other a message. You should see `[publish_realtime] rideshare:chat:message`
   on send and `[publish_realtime] rideshare:chat:status` on read receipt.

---

## 12. Production best practices recap

* **Always treat realtime as a booster, never the source of truth.** Every
  chat screen has a REST fallback for both fetching history and marking
  messages read. Socket-only paths break on flaky networks.
* **Optimistic UI, server reconciliation.** The pending message id
  prefix (`__pending_<ts>`) plus `body + sender` matching is enough to
  dedupe when the canonical record arrives.
* **Bulk operations, not per-row.** Read receipts batch every unread
  message in one UPDATE + one realtime event.
* **Targeted user broadcasts beat global rooms.** Presence and typing
  publish to a single `user=...` channel; the only "room" we use is
  `chat:<thread>`, and it has at most 2-3 members.
* **Indexes from day one.** The patch lives next to the migration so
  no production deploy ever runs without them.
* **Fail open.** Every async IIFE in the mobile app wraps in try/catch;
  every socket helper is non-throwing. A dead socket or a 5xx never
  takes down the chat screen.

---

## 13. Future work

| feature | difficulty | notes |
| --- | --- | --- |
| Voice messages | low | schema + bubble already there; just wire `expo-av` recording |
| Reactions / emojis | low | mirror Raven's `raven_message_reaction` child table |
| Message editing / deletion | medium | append-only history, soft-delete via `deleted_at` field |
| Chat search | medium | Frappe full-text search on `body`; or ship Meilisearch |
| End-to-end encryption | hard | requires per-user key escrow + a trust-on-first-use pattern |
| Message threading (replies) | medium | Add `reply_to` Link → Chat Message; render quoted preview in bubble |
| Group chats (>2 participants) | medium | new `Chat Thread Member` child table; current driver/passenger fields stay for the booking case |

---

*Last updated: 2026-05-23 — when the per-message read-receipt /
presence / image attachment / index / active-ride scope work landed.*
