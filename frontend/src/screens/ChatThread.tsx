// Native realtime chat for one Chat Thread.
//
// Replaces the previous react-native-webview shell.  The WebView version
// rendered a second header (causing the duplicated avatar/name look),
// shipped its own socket.io client, and crashed unreliably on some
// devices.  This implementation is 100% React Native:
//
//   * History       — rideshare.api.chat.get_thread (paginated by `before`)
//   * Live updates  — subscribeToThread (Frappe Socket.IO bridge)
//   * Typing pill   — subscribeToTyping
//   * Send          — rideshare.api.chat.send_message (optimistic)
//   * Read receipts — rideshare.api.chat.mark_read on focus
//
// The input auto-focuses on mount so the keyboard pops without an extra
// tap, matching WhatsApp's behaviour.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Linking,
  AppState,
  AppStateStatus
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, RouteProp, useFocusEffect } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { absoluteFileUrl } from "@/utils/upload";
import {
  subscribeToThread,
  subscribeToTyping,
  subscribeToMessageStatus,
  subscribeToPresence,
  ChatMessageEvent,
  TypingEvent,
  ChatStatusEvent,
  PresenceEvent
} from "@/realtime/socket";
import { colors, radii, spacing, shadow } from "@/theme";
import { Image } from "react-native";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "ChatThread">;

export type DeliveryStatus = "sent" | "delivered" | "read";

type ServerMessage = {
  name: string;
  sender: string;
  sender_role?: "Driver" | "Passenger" | "Support" | "System" | string;
  sender_name?: string;
  body: string;
  sent_at?: string | null;
  is_system?: boolean | number;
  message_type?: "text" | "image" | "audio" | "file" | "location" | "system" | string;
  attachment?: string | null;
  attachment_meta?: Record<string, unknown> | null;
  delivery_status?: DeliveryStatus;
};

type ThreadHead = {
  title: string;
  subtitle: string;
  phone?: string | null;
  myRole?: string;
  /** The other person's user id — used by presence subscription. */
  otherUser?: string | null;
};

type Presence = {
  active: boolean;
  /** ISO timestamp of last activity (live or persisted). */
  lastSeen: string | null;
};

const TYPING_THROTTLE_MS = 2500;
const TYPING_STOP_MS = 3500;

export function ChatThreadScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation();
  const { user } = useAuth();
  const inputRef = useRef<TextInput | null>(null);
  const listRef = useRef<FlatList<ServerMessage> | null>(null);
  const lastTypingAt = useRef<number>(0);
  const stopTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [head, setHead] = useState<ThreadHead>({
    title: "Conversation",
    subtitle: "Loading…"
  });
  const [items, setItems] = useState<ServerMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [presence, setPresence] = useState<Presence>({ active: false, lastSeen: null });

  // -- Initial fetch + thread metadata ------------------------------------
  const loadAll = useCallback(async () => {
    setError(null);
    setLoading(true);
    if (!params?.threadId) {
      setError("This chat link is missing — open from the trip again.");
      setLoading(false);
      return;
    }
    try {
      const res = await call<{
        thread: { name: string; thread_type: string; subject?: string; driver?: string; passenger?: string };
        messages: ServerMessage[];
        my_role: string;
      }>("rideshare.api.chat.get_thread", { thread: params.threadId, limit: 50 });

      // Header text — pull the counterparty's display label from the list
      // endpoint (it already does the lookup; saves a per-thread query
      // here).  We don't fail the screen if it errors, just fall back to
      // a generic title.
      let title = "Conversation";
      let subtitle = res.thread.subject || "Tap to message";
      let phone: string | null = null;
      // For booking threads we know the other party; presence + read
      // receipts use their user id.
      const myRole = res.my_role;
      const otherUser =
        myRole === "Driver"
          ? res.thread.passenger || null
          : myRole === "Passenger"
            ? res.thread.driver || null
            : null;
      try {
        const list = await call<Array<{ name: string; counterparty?: { label?: string; phone?: string | null } }>>(
          "rideshare.api.chat.list_threads",
          { limit: 200 }
        );
        const row = Array.isArray(list) ? list.find((r) => r.name === params.threadId) : null;
        if (res.thread.thread_type === "Support") {
          title = "Rideshare Support";
          subtitle = "Average reply under 30 minutes";
        } else if (row?.counterparty?.label) {
          title = row.counterparty.label;
          phone = row.counterparty.phone || null;
          subtitle = res.thread.subject || "Tap to message";
        }
      } catch {/* ignore — header just stays generic */}

      setHead({ title, subtitle, phone, myRole, otherUser });
      setItems(
        Array.isArray(res.messages)
          ? res.messages.filter((m) => m && typeof m.name === "string")
          : []
      );

      // Bootstrap the counterparty's online state with one REST call;
      // the realtime subscription below keeps it fresh after that.
      if (otherUser) {
        try {
          const p = await call<Record<string, { active: boolean; last_seen: string | null }>>(
            "rideshare.api.presence.get_presence",
            { user_ids: otherUser }
          );
          const row = p?.[otherUser];
          if (row) setPresence({ active: !!row.active, lastSeen: row.last_seen });
        } catch {/* presence is best-effort */}
      }
    } catch (e: any) {
      setError(e?.message ?? "Couldn't open chat.");
    } finally {
      setLoading(false);
    }
  }, [params?.threadId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Promote read receipts when the screen gains focus.  The new
  // mark_message_read endpoint promotes every unread message to
  // "read" *and* clears the per-side unread counter — one round-trip,
  // two effects.
  //
  // The same focus effect also drives presence: a 30 s heartbeat
  // while the screen is foregrounded, paused while the user
  // backgrounds the app (otherwise we leak both an interval and the
  // false "online" signal to the counterparty).  We hook AppState
  // to pause/resume the ping in lockstep with foreground/background.
  useFocusEffect(
    useCallback(() => {
      let intervalId: ReturnType<typeof setInterval> | null = null;
      let cancelled = false;

      const pingNow = () => {
        call("rideshare.api.presence.ping_presence").catch(() => {});
      };
      const startHeartbeat = () => {
        if (intervalId || cancelled) return;
        pingNow();
        intervalId = setInterval(pingNow, 30_000);
      };
      const stopHeartbeat = () => {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      };

      // Initial mark-read + presence kick.
      call("rideshare.api.chat.mark_message_read", { thread: params.threadId }).catch(() => {});
      startHeartbeat();

      const onAppState = (next: AppStateStatus) => {
        if (next === "active") {
          startHeartbeat();
          // Catch up missed messages on resume.
          call("rideshare.api.chat.mark_message_read", { thread: params.threadId }).catch(() => {});
        } else {
          stopHeartbeat();
          // Best-effort "I'm gone" so the counterparty's chat header
          // flips to "Last seen just now" immediately.
          call("rideshare.api.presence.go_offline").catch(() => {});
        }
      };
      const sub = AppState.addEventListener("change", onAppState);

      return () => {
        cancelled = true;
        stopHeartbeat();
        try { sub.remove(); } catch {/* RN <0.65 returns void; ignore */}
        // When the screen unfocuses (back navigation), tell the server
        // we're offline so the typing indicator clears out and the
        // counterparty's online dot flips off.
        call("rideshare.api.presence.go_offline").catch(() => {});
      };
    }, [params.threadId])
  );

  // -- Realtime ------------------------------------------------------------
  useEffect(() => {
    let unsubMsg: (() => void) | null = null;
    let unsubTyping: (() => void) | null = null;
    let unsubStatus: (() => void) | null = null;
    let unsubPresence: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        unsubMsg = await subscribeToThread(params.threadId, (msg: ChatMessageEvent) => {
          if (cancelled) return;
          if (!msg || typeof msg.name !== "string") return;
          setItems((cur) => {
            // Optimistic message names start with "__pending_"; reconcile
            // when the real one arrives by body+sender.  Defensive
            // type-checks: server messages have always carried a `name`,
            // but a malformed payload shouldn't crash the screen.
            const filtered = cur.filter((m) => {
              if (typeof m?.name !== "string") return true;
              return !(
                m.name.startsWith("__pending_") &&
                m.sender === msg.sender &&
                m.body === msg.body
              );
            });
            if (filtered.some((m) => m.name === msg.name)) return filtered;
            return [...filtered, normaliseEvent(msg)];
          });
          // Promote messages we just received to read on the server.
          call("rideshare.api.chat.mark_message_read", { thread: params.threadId }).catch(() => {});
        });
      } catch {/* socket optional */}

      try {
        unsubTyping = await subscribeToTyping(params.threadId, (evt: TypingEvent) => {
          if (cancelled) return;
          if (evt.sender === user) return;
          setTyping(!!evt.is_typing);
        });
      } catch {/* socket optional */}

      try {
        unsubStatus = await subscribeToMessageStatus(
          params.threadId,
          (evt: ChatStatusEvent) => {
            if (cancelled) return;
            const ids = new Set(evt.messages || []);
            if (ids.size === 0) return;
            setItems((cur) =>
              cur.map((m) =>
                ids.has(m.name)
                  ? { ...m, delivery_status: evt.status }
                  : m
              )
            );
          }
        );
      } catch {/* socket optional */}
    })();

    // Presence subscription — only meaningful for booking threads
    // where we know the other party.
    (async () => {
      try {
        unsubPresence = await subscribeToPresence((evt: PresenceEvent) => {
          if (cancelled) return;
          // We don't know the other user yet on first subscribe; the
          // condition is re-checked against the latest head.otherUser
          // through state, but presence handlers can't read state.
          // We filter at handler time instead.
          if (head.otherUser && evt.user !== head.otherUser) return;
          setPresence({ active: !!evt.active, lastSeen: evt.at || null });
        });
      } catch {/* socket optional */}
    })();

    return () => {
      cancelled = true;
      if (unsubMsg) unsubMsg();
      if (unsubTyping) unsubTyping();
      if (unsubStatus) unsubStatus();
      if (unsubPresence) unsubPresence();
    };
  }, [params.threadId, user, head.otherUser]);

  // -- Send ---------------------------------------------------------------
  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    const optimistic: ServerMessage = {
      name: `__pending_${Date.now()}`,
      sender: user || "me",
      sender_role: head.myRole as any,
      sender_name: "You",
      body,
      sent_at: new Date().toISOString(),
      is_system: false,
      message_type: "text",
      delivery_status: "sent"
    };
    setItems((cur) => [...cur, optimistic]);
    setDraft("");
    Promise.resolve().then(() => scrollToBottom());
    pushTyping(false);
    try {
      await call("rideshare.api.chat.send_message", {
        thread: params.threadId,
        body
      });
    } catch (e: any) {
      // Roll the optimistic message back and put the draft back into the box.
      setItems((cur) => cur.filter((m) => m.name !== optimistic.name));
      setDraft(body);
      Alert.alert("Couldn't send", e?.message ?? "Try again.");
    } finally {
      setSending(false);
    }
  }

  /** Inline-send for canned replies — same pipeline as `send()` but
   *  takes the body directly so we don't have to round-trip through
   *  React state. */
  async function sendQuickReply(body: string) {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    const optimistic: ServerMessage = {
      name: `__pending_${Date.now()}`,
      sender: user || "me",
      sender_role: head.myRole as any,
      sender_name: "You",
      body: trimmed,
      sent_at: new Date().toISOString(),
      is_system: false,
      message_type: "text",
      delivery_status: "sent"
    };
    setItems((cur) => [...cur, optimistic]);
    Promise.resolve().then(() => scrollToBottom());
    try {
      await call("rideshare.api.chat.send_message", {
        thread: params.threadId,
        body: trimmed
      });
    } catch (e: any) {
      setItems((cur) => cur.filter((m) => m.name !== optimistic.name));
      Alert.alert("Couldn't send", e?.message ?? "Try again.");
    } finally {
      setSending(false);
    }
  }

  function pushTyping(active: boolean) {
    if (!active) {
      if (stopTypingTimer.current) {
        clearTimeout(stopTypingTimer.current);
        stopTypingTimer.current = null;
      }
      lastTypingAt.current = 0;
      call("rideshare.api.chat.set_typing", { thread: params.threadId, is_typing: 0 }).catch(
        () => {}
      );
      return;
    }
    const now = Date.now();
    if (now - lastTypingAt.current > TYPING_THROTTLE_MS) {
      lastTypingAt.current = now;
      call("rideshare.api.chat.set_typing", { thread: params.threadId, is_typing: 1 }).catch(
        () => {}
      );
    }
    if (stopTypingTimer.current) clearTimeout(stopTypingTimer.current);
    stopTypingTimer.current = setTimeout(() => {
      lastTypingAt.current = 0;
      call("rideshare.api.chat.set_typing", { thread: params.threadId, is_typing: 0 }).catch(
        () => {}
      );
    }, TYPING_STOP_MS);
  }

  function onChange(text: string) {
    setDraft(text);
    pushTyping(text.trim().length > 0);
  }

  function scrollToBottom() {
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 50);
  }

  useEffect(() => {
    scrollToBottom();
  }, [items.length]);

  const initials = useMemo(() => {
    return (head.title || "?")
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }, [head.title]);

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{initials}</Text>
          {presence.active ? <View style={s.presenceDot} /> : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>{head.title}</Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {typing
              ? `${head.title.split(" ")[0] || head.title} is typing…`
              : presence.active
                ? "Online"
                : presence.lastSeen
                  ? `Last seen ${fmtRelative(presence.lastSeen)}`
                  : head.subtitle}
          </Text>
        </View>
        {head.phone ? (
          <TouchableOpacity
            onPress={() => Linking.openURL(`tel:${head.phone}`).catch(() => {})}
            style={s.callBtn}
            hitSlop={6}
            activeOpacity={0.85}
          >
            <Ionicons name="call" size={16} color={colors.primaryText} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={loadAll}
          style={s.reloadBtn}
          hitSlop={6}
          activeOpacity={0.85}
        >
          <Ionicons name="refresh" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color={colors.text} />
          </View>
        ) : error ? (
          <View style={s.center}>
            <Ionicons name="warning-outline" size={32} color={colors.warn} />
            <Text style={s.errText}>{error}</Text>
            <TouchableOpacity style={s.retryBtn} onPress={loadAll} activeOpacity={0.85}>
              <Text style={s.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            ref={(r) => {
              listRef.current = r;
            }}
            data={items}
            keyExtractor={(m) => m.name}
            contentContainerStyle={s.listContent}
            renderItem={({ item, index }) => (
              <MessageBubble
                msg={item}
                mine={isMine(item, user, head.myRole)}
                prev={items[index - 1]}
                next={items[index + 1]}
              />
            )}
            onContentSizeChange={scrollToBottom}
            keyboardShouldPersistTaps="handled"
          />
        )}

        {/* Quick replies — one-tap canned messages.  These live above
            the composer (NOT above the message list) so they stay
            within thumb reach without occluding chat history. */}
        <QuickReplies
          role={head.myRole}
          onPick={(text) => {
            // Inline-send: skip the composer to keep the UX punchy.
            // The text is short (< 60 chars) so we don't need a draft
            // edit step.
            if (sending) return;
            setDraft(""); // clear any in-progress draft
            // Reuse the existing send pipeline by stuffing draft and
            // calling send().  Setting state and immediately calling
            // send() races, so we inline a tiny copy of the send
            // logic here.
            sendQuickReply(text);
          }}
        />

        {/* Composer */}
        <View style={s.composer}>
          <View style={s.inputWrap}>
            <TextInput
              ref={(r) => {
                inputRef.current = r;
              }}
              style={s.input}
              value={draft}
              onChangeText={onChange}
              placeholder="Type a message…"
              placeholderTextColor={colors.mute}
              autoFocus
              multiline
              maxLength={2000}
              returnKeyType="default"
            />
          </View>
          <TouchableOpacity
            style={[s.sendBtn, (!draft.trim() || sending) && s.sendBtnDisabled]}
            onPress={send}
            disabled={!draft.trim() || sending}
            activeOpacity={0.85}
          >
            {sending ? (
              <ActivityIndicator color={colors.primaryText} size="small" />
            ) : (
              <Ionicons name="send" size={16} color={colors.primaryText} />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// --- helpers ------------------------------------------------------------

function normaliseEvent(evt: ChatMessageEvent): ServerMessage {
  return {
    name: evt.name,
    sender: evt.sender,
    sender_role: evt.sender_role,
    sender_name: (evt as any).sender_name,
    body: evt.body,
    sent_at: evt.sent_at || null,
    is_system: !!evt.is_system
  };
}

function isMine(m: ServerMessage, viewer: string | null, myRole?: string): boolean {
  if (m.sender_role === "System") return false;
  if (viewer && m.sender === viewer) return true;
  if (myRole && m.sender_role && m.sender_role === myRole) return true;
  return false;
}

function fmtClock(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "5 minutes ago" / "yesterday" — used for last-seen and message ticks. */
function fmtRelative(iso?: string | null): string {
  if (!iso) return "recently";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return "recently";
  const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 30) return "just now";
  if (sec < 90) return "1 minute ago";
  if (sec < 3600) return `${Math.round(sec / 60)} minutes ago`;
  if (sec < 7200) return "1 hour ago";
  if (sec < 86400) return `${Math.round(sec / 3600)} hours ago`;
  if (sec < 172800) return "yesterday";
  return `${Math.round(sec / 86400)} days ago`;
}

/** WhatsApp-style ticks for own messages. */
function DeliveryTicks({ status }: { status?: DeliveryStatus }) {
  if (!status) return null;
  // sent     → single ✓ (white/translucent on dark bubble)
  // delivered → ✓✓
  // read     → ✓✓ in blue
  const tick = status === "sent" ? "checkmark" : "checkmark-done";
  const colour = status === "read" ? "#5AB1FF" : "rgba(255,255,255,0.78)";
  return (
    <Ionicons
      name={tick}
      size={13}
      color={colour}
      style={{ marginLeft: 4 }}
    />
  );
}

function MessageBubble({
  msg,
  mine,
  prev,
  next
}: {
  msg: ServerMessage;
  mine: boolean;
  prev?: ServerMessage;
  next?: ServerMessage;
}) {
  if (msg.is_system) {
    return (
      <View style={s.systemWrap}>
        <Text style={s.systemText}>{msg.body}</Text>
      </View>
    );
  }
  const showName =
    !mine &&
    (!prev || prev.sender !== msg.sender || prev.is_system) &&
    !!(msg.sender_name && msg.sender_name !== msg.sender);
  const tightTop = !showName && prev && prev.sender === msg.sender && !prev.is_system;
  const tightBottom = next && next.sender === msg.sender && !next.is_system;

  // Resolve attachment URL once per render so we can fall back if the
  // server sent a relative path.
  const attachmentUri =
    msg.attachment ? absoluteFileUrl(msg.attachment) ?? msg.attachment : null;
  const isImage = msg.message_type === "image" && !!attachmentUri;
  const isAudio = msg.message_type === "audio" && !!attachmentUri;
  const isFile = msg.message_type === "file" && !!attachmentUri;

  return (
    <View
      style={[
        s.row,
        mine ? s.rowMine : s.rowOther,
        { marginTop: tightTop ? 2 : 8, marginBottom: tightBottom ? 2 : 4 }
      ]}
    >
      <View
        style={[
          s.bubble,
          mine ? s.bubbleMine : s.bubbleOther,
          isImage && s.bubbleImage,
          mine && tightBottom && { borderBottomRightRadius: 6 },
          !mine && tightBottom && { borderBottomLeftRadius: 6 }
        ]}
      >
        {showName ? (
          <Text style={s.bubbleSender}>{msg.sender_name}</Text>
        ) : null}

        {isImage ? (
          <View style={s.imageWrap}>
            <Image
              source={{ uri: attachmentUri as string }}
              style={s.imageThumb}
              resizeMode="cover"
            />
            {msg.body ? (
              <Text style={[mine ? s.bubbleTextMine : s.bubbleTextOther, { marginTop: 6 }]}>
                {msg.body}
              </Text>
            ) : null}
          </View>
        ) : isAudio ? (
          <View style={s.audioRow}>
            <Ionicons
              name="play-circle"
              size={28}
              color={mine ? colors.primaryText : colors.text}
            />
            <View style={{ flex: 1 }}>
              <Text style={mine ? s.bubbleTextMine : s.bubbleTextOther}>
                Voice message
                {(msg.attachment_meta as any)?.duration_seconds
                  ? ` · ${Math.round(((msg.attachment_meta as any).duration_seconds))}s`
                  : ""}
              </Text>
              {msg.body ? (
                <Text style={mine ? s.bubbleTimeMine : s.bubbleTimeOther}>{msg.body}</Text>
              ) : null}
            </View>
          </View>
        ) : isFile ? (
          <View style={s.audioRow}>
            <Ionicons
              name="document-attach"
              size={22}
              color={mine ? colors.primaryText : colors.text}
            />
            <Text style={mine ? s.bubbleTextMine : s.bubbleTextOther} numberOfLines={1}>
              {(msg.attachment_meta as any)?.filename || msg.body || "Attachment"}
            </Text>
          </View>
        ) : (
          <Text style={mine ? s.bubbleTextMine : s.bubbleTextOther}>{msg.body}</Text>
        )}

        <View style={s.bubbleFooter}>
          <Text style={mine ? s.bubbleTimeMine : s.bubbleTimeOther}>{fmtClock(msg.sent_at)}</Text>
          {mine ? <DeliveryTicks status={msg.delivery_status} /> : null}
        </View>
      </View>
    </View>
  );
}

/** Canned replies are role-specific — drivers and passengers use
 *  different turns of phrase.  Tap a chip → instant send (no edit
 *  step), keeping the chat snappy. */
const QUICK_REPLIES_PASSENGER = [
  "On my way 👍",
  "Reached pickup",
  "Running 5 min late",
  "Where are you?",
  "Thanks!",
  "👍"
];
const QUICK_REPLIES_DRIVER = [
  "I'm at the pickup spot",
  "5 min away",
  "Stuck in traffic",
  "Please share your location",
  "Reached destination",
  "Thanks!"
];

function QuickReplies({
  role,
  onPick
}: {
  role?: string;
  onPick: (text: string) => void;
}) {
  const items = role === "Driver" ? QUICK_REPLIES_DRIVER : QUICK_REPLIES_PASSENGER;
  return (
    <View style={s.quickRepliesWrap}>
      <View style={s.quickRepliesScroll}>
        {items.map((label) => (
          <TouchableOpacity
            key={label}
            style={s.quickReply}
            onPress={() => onPick(label)}
            activeOpacity={0.85}
            hitSlop={4}
          >
            <Text style={s.quickReplyText} numberOfLines={1}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card
  },
  title: { fontSize: 16, fontWeight: "800", color: colors.text, letterSpacing: -0.2 },
  subtitle: { fontSize: 11, color: colors.soft, marginTop: 2 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarText: { color: colors.primaryText, fontSize: 13, fontWeight: "800" },
  presenceDot: {
    position: "absolute",
    bottom: -1,
    right: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.success,
    borderWidth: 2,
    borderColor: colors.card
  },
  callBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success
  },
  reloadBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.border
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: spacing(6)
  },
  errText: { color: colors.text, fontSize: 14, textAlign: "center" },
  retryBtn: {
    marginTop: 6,
    backgroundColor: colors.text,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999
  },
  retryText: { color: colors.primaryText, fontWeight: "800", fontSize: 13 },

  listContent: {
    padding: spacing(3),
    paddingBottom: spacing(2)
  },
  row: { flexDirection: "row", marginVertical: 2 },
  rowMine: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "78%",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 18
  },
  bubbleMine: {
    backgroundColor: colors.text,
    borderBottomRightRadius: 4
  },
  bubbleOther: {
    backgroundColor: colors.bgAlt,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: colors.border
  },
  bubbleImage: {
    paddingVertical: 4,
    paddingHorizontal: 4
  },
  imageWrap: {
    overflow: "hidden",
    borderRadius: 14
  },
  imageThumb: {
    width: 220,
    height: 220,
    borderRadius: 14,
    backgroundColor: colors.borderStrong
  },
  audioRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 2
  },
  bubbleSender: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.soft,
    marginBottom: 2
  },
  bubbleTextMine: { color: colors.primaryText, fontSize: 15, lineHeight: 20 },
  bubbleTextOther: { color: colors.text, fontSize: 15, lineHeight: 20 },
  bubbleTimeMine: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 10,
    textAlign: "right"
  },
  bubbleTimeOther: {
    color: colors.soft,
    fontSize: 10,
    textAlign: "right"
  },
  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 4
  },
  systemWrap: { alignItems: "center", marginVertical: 6 },
  systemText: {
    color: colors.soft,
    fontSize: 12,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999
  },

  quickRepliesWrap: {
    paddingHorizontal: spacing(3),
    paddingTop: 6,
    paddingBottom: 4,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  quickRepliesScroll: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6
  },
  quickReply: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.bgAlt,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border
  },
  quickReplyText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.text
  },

  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: spacing(3),
    paddingTop: spacing(2),
    paddingBottom: spacing(2),
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    ...shadow.card
  },
  inputWrap: {
    flex: 1,
    backgroundColor: colors.bgAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 10 : 4,
    minHeight: 44,
    maxHeight: 140,
    justifyContent: "center"
  },
  input: {
    fontSize: 15,
    color: colors.text,
    lineHeight: 20,
    padding: 0
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  sendBtnDisabled: { backgroundColor: colors.mute }
});
