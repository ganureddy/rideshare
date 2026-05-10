// Frappe broadcasts realtime events on its built-in Socket.IO bridge
// (running on port 9000 in dev, behind nginx in prod). Clients join a
// room and receive a typed event.

import { io, Socket } from "socket.io-client";
import { ENV } from "@/env";
import { credentialsStore } from "@/auth/store";

let _socket: Socket | null = null;

export async function getSocket(): Promise<Socket> {
  if (_socket && _socket.connected) return _socket;
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

export async function subscribeToRide(
  rideId: string,
  onLocation: (loc: RideLocation) => void,
  onStatus?: (s: { ride: string; status: string }) => void
): Promise<() => void> {
  const sock = await getSocket();
  sock.emit("subscribe", { doctype: "Ride", docname: rideId });
  sock.emit("doc_subscribe", { doctype: "Ride", docname: rideId });
  const locHandler = (msg: RideLocation) => {
    if (msg && msg.ride === rideId) onLocation(msg);
  };
  const statusHandler = (msg: { ride: string; status: string }) => {
    if (onStatus && msg && msg.ride === rideId) onStatus(msg);
  };
  sock.on("rideshare:location", locHandler);
  sock.on("rideshare:status", statusHandler);
  return () => {
    sock.off("rideshare:location", locHandler);
    sock.off("rideshare:status", statusHandler);
    sock.emit("unsubscribe", { doctype: "Ride", docname: rideId });
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
): Promise<() => void> {
  const sock = await getSocket();
  // Frappe's `publish_realtime(room=...)` requires the client to be a
  // member of that room.  We subscribe both the doctype-shaped room and
  // the bare `chat:<name>` room so it works on either nginx config.
  sock.emit("subscribe", { doctype: "Chat Thread", docname: threadName });
  sock.emit("doc_subscribe", { doctype: "Chat Thread", docname: threadName });

  const handler = (msg: ChatMessageEvent) => {
    if (msg && msg.thread === threadName) onMessage(msg);
  };
  sock.on("rideshare:chat:message", handler);
  return () => {
    sock.off("rideshare:chat:message", handler);
    sock.emit("unsubscribe", { doctype: "Chat Thread", docname: threadName });
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
): Promise<() => void> {
  const sock = await getSocket();
  const handler = (msg: TypingEvent) => {
    if (msg && msg.thread === threadName) onTyping(msg);
  };
  sock.on("rideshare:chat:typing", handler);
  return () => sock.off("rideshare:chat:typing", handler);
}
