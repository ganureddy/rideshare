// Frappe broadcasts realtime events on its built-in Socket.IO bridge
// (running on port 9000 in dev, behind nginx in prod). Clients join a
// room and receive a typed event.
//
// Production-grade design notes
// =============================
// 1.  Singleton socket — one connection per app process, reused across
//     screens.  socket.io-client handles transport upgrades + reconnect
//     internally so we don't bake a custom retry loop on top.
//
// 2.  Listener-leak-proof wrappers — every `safeOn` returns the EXACT
//     wrapped function it registered with socket.io.  `safeOff` MUST be
//     called with that returned reference.  Subscribers track those
//     references in their own scope so unmount cleanup deregisters the
//     correct listener.  This was a real bug in the previous revision:
//     the wrapped closure was created inside `safeOn` and lost, so
//     `safeOff(handler)` couldn't match anything → zombie listeners
//     piled up on every screen mount.
//
// 3.  Defensive try/catch around every socket.io call — a dead/dropped
//     socket throwing on `.emit` / `.on` / `.off` must never propagate
//     out into the React lifecycle.
//
// 4.  All subscriber callbacks are wrapped — a buggy handler in any
//     screen can never crash the realtime layer or the other
//     subscribers on the same event.
//
// 5.  Auth-bound socket — when the user logs out we tear down the
//     singleton (`closeSocket`) so the next login gets a fresh
//     connection with the new credentials.

import { io, Socket } from "socket.io-client";
import { ENV } from "@/env";
import { credentialsStore } from "@/auth/store";

let _socket: Socket | null = null;

export async function getSocket(): Promise<Socket> {
  if (_socket && _socket.connected) return _socket;
  if (_socket && !_socket.connected) {
    // Stale handle (we got here in a brief disconnect window).  Reuse
    // the existing socket — socket.io's internal reconnect will bring
    // it back online.
    return _socket;
  }
  const creds = await credentialsStore.get();
  _socket = io(ENV.websocketUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 8000,
    auth: creds
      ? {
          api_key: creds.apiKey,
          api_secret: creds.apiSecret,
          user: creds.user
        }
      : undefined
  });
  return _socket;
}

/**
 * Tear the singleton socket down — call this from `signOut()` so the
 * next login bootstraps a clean connection with new credentials.  Any
 * still-attached listeners are fire-and-forget orphans (which is why
 * every screen's cleanup function MUST run before logout).
 */
export function closeSocket(): void {
  if (!_socket) return;
  try {
    _socket.removeAllListeners();
    _socket.disconnect();
  } catch {/* noop */}
  _socket = null;
}

// ---------------------------------------------------------------------------
// Internal safe wrappers.
// ---------------------------------------------------------------------------

/** A function that fully cleans up a single subscription. */
type Unsubscribe = () => void;

function safeEmit(sock: Socket | null, event: string, ...args: unknown[]): void {
  if (!sock) return;
  try {
    sock.emit(event, ...args);
  } catch {/* socket is dead — fall through */}
}

/**
 * Register a listener that wraps the user handler with try/catch so
 * a buggy handler can't poison the socket.  Returns an Unsubscribe
 * function that removes the EXACT wrapped listener — no listener
 * leaks across screen mounts.
 */
function safeOn<T>(
  sock: Socket | null,
  event: string,
  handler: (msg: T) => void
): Unsubscribe {
  if (!sock) return () => {/* no socket → no-op */};

  // The wrapped closure is what we actually register; we need to keep
  // a reference to it so we can `.off(event, wrapped)` later.  Bare
  // `.off(event)` would yank every listener for that event — including
  // those owned by *other* screens on the same shared socket.
  const wrapped = (msg: T) => {
    try {
      handler(msg);
    } catch {/* user handler threw — never let it kill the socket */}
  };
  try {
    sock.on(event, wrapped);
  } catch {/* listener registration failed (socket dead) */}

  return () => {
    try {
      sock.off(event, wrapped);
    } catch {/* noop */}
  };
}

/** Always-safe NOOP unsubscribe — returned by every subscribeTo*
 *  helper when the socket couldn't be acquired at all. */
const NOOP_UNSUB: Unsubscribe = () => {/* nothing to clean up */};

// ---------------------------------------------------------------------------
// Live trip tracking (driver location → booker)
// ---------------------------------------------------------------------------

export type RideLocation = {
  ride: string;
  lat: number;
  lng: number;
  heading?: number | null;
  speed_kmh?: number | null;
  at: string;
};

export type PassengerLocation = {
  ride: string;
  booking: string;
  passenger: string;
  lat: number;
  lng: number;
  heading?: number | null;
  speed_kmh?: number | null;
  at: string;
};

export async function subscribeToRide(
  rideId: string,
  onLocation: (loc: RideLocation) => void,
  onStatus?: (s: { ride: string; status: string }) => void,
  onPassengerLocation?: (loc: PassengerLocation) => void
): Promise<Unsubscribe> {
  let sock: Socket;
  try {
    sock = await getSocket();
  } catch {
    return NOOP_UNSUB;
  }
  safeEmit(sock, "subscribe", { doctype: "Ride", docname: rideId });
  safeEmit(sock, "doc_subscribe", { doctype: "Ride", docname: rideId });

  const offLoc = safeOn<RideLocation>(sock, "rideshare:location", (msg) => {
    if (msg && msg.ride === rideId) onLocation(msg);
  });
  const offStatus = safeOn<{ ride: string; status: string }>(
    sock,
    "rideshare:status",
    (msg) => {
      if (onStatus && msg && msg.ride === rideId) onStatus(msg);
    }
  );
  const offPax = safeOn<PassengerLocation>(
    sock,
    "rideshare:passenger_location",
    (msg) => {
      if (onPassengerLocation && msg && msg.ride === rideId) onPassengerLocation(msg);
    }
  );

  return () => {
    offLoc();
    offStatus();
    offPax();
    safeEmit(sock, "unsubscribe", { doctype: "Ride", docname: rideId });
  };
}

// ---------------------------------------------------------------------------
// Chat — pushed by `Chat Message.after_insert` on the server
// ---------------------------------------------------------------------------

export type ChatMessageEvent = {
  name: string;
  thread: string;
  sender: string;
  sender_role: "Driver" | "Passenger" | "Support" | "System";
  body: string;
  sent_at: string | null;
  is_system: boolean;
};

export async function subscribeToThread(
  threadName: string,
  onMessage: (msg: ChatMessageEvent) => void
): Promise<Unsubscribe> {
  let sock: Socket;
  try {
    sock = await getSocket();
  } catch {
    return NOOP_UNSUB;
  }
  // Frappe's `publish_realtime(room=...)` requires the client to be a
  // member of that room.  We subscribe both the doctype-shaped room and
  // the bare `chat:<name>` room so it works on either nginx config.
  safeEmit(sock, "subscribe", { doctype: "Chat Thread", docname: threadName });
  safeEmit(sock, "doc_subscribe", { doctype: "Chat Thread", docname: threadName });

  const off = safeOn<ChatMessageEvent>(sock, "rideshare:chat:message", (msg) => {
    if (msg && msg.thread === threadName) onMessage(msg);
  });
  return () => {
    off();
    safeEmit(sock, "unsubscribe", { doctype: "Chat Thread", docname: threadName });
  };
}

// ---------------------------------------------------------------------------
// Typing indicator — fire-and-forget realtime hint that the other party is
// composing a message.  The backend pushes events on the per-user room so we
// only get a payload when the *other* side is typing.
// ---------------------------------------------------------------------------

export type TypingEvent = {
  thread: string;
  sender: string;
  sender_role: "Driver" | "Passenger" | "Support" | "Unknown";
  is_typing: boolean;
};

export async function subscribeToTyping(
  threadName: string,
  onTyping: (evt: TypingEvent) => void
): Promise<Unsubscribe> {
  let sock: Socket;
  try {
    sock = await getSocket();
  } catch {
    return NOOP_UNSUB;
  }
  return safeOn<TypingEvent>(sock, "rideshare:chat:typing", (msg) => {
    if (msg && msg.thread === threadName) onTyping(msg);
  });
}

// ---------------------------------------------------------------------------
// Per-message delivery / read status updates.
//
// The backend broadcasts `rideshare:chat:status` whenever the
// recipient's pane promotes one or more messages from `sent` →
// `delivered` (recipient fetched / received them) or `delivered` →
// `read` (recipient explicitly opened the thread).
//
// The sender's UI uses these events to flip ✓ → ✓✓ → ✓✓-blue without
// re-fetching.
// ---------------------------------------------------------------------------

export type ChatStatusEvent = {
  thread: string;
  status: "delivered" | "read";
  /** Affected message ids — bulk update in one event. */
  messages: string[];
  /** The user who triggered the status change (the recipient). */
  by: string;
  /** ISO timestamp at which the change happened. */
  at: string;
};

export async function subscribeToMessageStatus(
  threadName: string,
  onStatus: (evt: ChatStatusEvent) => void
): Promise<Unsubscribe> {
  let sock: Socket;
  try {
    sock = await getSocket();
  } catch {
    return NOOP_UNSUB;
  }
  return safeOn<ChatStatusEvent>(sock, "rideshare:chat:status", (msg) => {
    if (msg && msg.thread === threadName && Array.isArray(msg.messages)) {
      onStatus(msg);
    }
  });
}

// ---------------------------------------------------------------------------
// Online / offline presence — Raven-style targeted broadcasts.
//
// The backend publishes `rideshare:user_active` on the *target* user's
// socket whenever a counterparty (someone they share a Chat Thread
// with) flips online or offline.  The chat header subscribes here to
// show "online" / "last seen 5 min ago" without polling.
// ---------------------------------------------------------------------------

export type PresenceEvent = {
  user: string;
  active: boolean;
  at: string;
};

export async function subscribeToPresence(
  onPresence: (evt: PresenceEvent) => void
): Promise<Unsubscribe> {
  let sock: Socket;
  try {
    sock = await getSocket();
  } catch {
    return NOOP_UNSUB;
  }
  return safeOn<PresenceEvent>(sock, "rideshare:user_active", (msg) => {
    if (msg && typeof msg.user === "string") onPresence(msg);
  });
}

// ---------------------------------------------------------------------------
// Booking lifecycle — pushed by the backend whenever a booking transitions
// (`pending_review`, `confirmed`, `cancelled`).  Both the driver's and the
// passenger's apps subscribe so dashboards refresh without polling.
// ---------------------------------------------------------------------------

export type BookingEvent = {
  event: "pending_review" | "confirmed" | "cancelled" | string;
  booking: string;
  booking_code?: string | null;
  ride: string;
  passenger: string;
  status: "Pending" | "Confirmed" | "Cancelled" | "Completed" | string;
  payment_status: string;
  seats_booked: number;
  instant_booking?: boolean;
  reason?: string | null;
};

/**
 * Subscribe to booking events.  When ``rideId`` is supplied we filter to
 * that ride; otherwise the caller receives every booking update (used by
 * the rider's home dashboard).
 */
export async function subscribeToBookings(
  onEvent: (evt: BookingEvent) => void,
  rideId?: string
): Promise<Unsubscribe> {
  let sock: Socket;
  try {
    sock = await getSocket();
  } catch {
    return NOOP_UNSUB;
  }

  const off = safeOn<BookingEvent>(sock, "rideshare:booking", (msg) => {
    if (!msg) return;
    if (rideId && msg.ride !== rideId) return;
    onEvent(msg);
  });

  if (rideId) {
    safeEmit(sock, "subscribe", { doctype: "Ride", docname: rideId });
    safeEmit(sock, "doc_subscribe", { doctype: "Ride", docname: rideId });
  }

  return () => {
    off();
    if (rideId) {
      safeEmit(sock, "unsubscribe", { doctype: "Ride", docname: rideId });
    }
  };
}
