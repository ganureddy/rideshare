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
          // Frappe's socket bridge accepts the same token header for auth
          // when configured behind nginx with auth-pass-through.
          api_key: creds.apiKey,
          api_secret: creds.apiSecret,
          user: creds.user
        }
      : undefined
  });
  return _socket;
}

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
  // Frappe's publish_realtime(room=...) translates into an event on the
  // server-side namespace; the socket.io client receives it as a top-level
  // event named after the `event=` param.
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
