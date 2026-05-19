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
  Linking
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, RouteProp, useFocusEffect } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { call } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import {
  subscribeToThread,
  subscribeToTyping,
  ChatMessageEvent,
  TypingEvent
} from "@/realtime/socket";
import { colors, radii, spacing, shadow } from "@/theme";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "ChatThread">;

type ServerMessage = {
  name: string;
  sender: string;
  sender_role?: "Driver" | "Passenger" | "Support" | "System" | string;
  sender_name?: string;
  body: string;
  sent_at?: string | null;
  is_system?: boolean | number;
};

type ThreadHead = {
  title: string;
  subtitle: string;
  phone?: string | null;
  myRole?: string;
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

  // -- Initial fetch + thread metadata ------------------------------------
  const loadAll = useCallback(async () => {
    setError(null);
    setLoading(true);
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

      setHead({ title, subtitle, phone, myRole: res.my_role });
      setItems(res.messages || []);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't open chat.");
    } finally {
      setLoading(false);
    }
  }, [params.threadId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Mark unread cleared when the screen gains focus.
  useFocusEffect(
    useCallback(() => {
      call("rideshare.api.chat.mark_read", { thread: params.threadId }).catch(() => {});
    }, [params.threadId])
  );

  // -- Realtime ------------------------------------------------------------
  useEffect(() => {
    let unsubMsg: (() => void) | null = null;
    let unsubTyping: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        unsubMsg = await subscribeToThread(params.threadId, (msg: ChatMessageEvent) => {
          if (cancelled) return;
          setItems((cur) => {
            // Optimistic message names start with "__pending_"; reconcile
            // when the real one arrives by body+sender.
            const filtered = cur.filter(
              (m) =>
                !(
                  m.name.startsWith("__pending_") &&
                  m.sender === msg.sender &&
                  m.body === msg.body
                )
            );
            if (filtered.some((m) => m.name === msg.name)) return filtered;
            return [...filtered, normaliseEvent(msg)];
          });
          // Clear server-side unread for the receiver in near real-time.
          call("rideshare.api.chat.mark_read", { thread: params.threadId }).catch(() => {});
        });
      } catch {/* socket optional */}
      try {
        unsubTyping = await subscribeToTyping(params.threadId, (evt: TypingEvent) => {
          if (cancelled) return;
          if (evt.sender === user) return;
          setTyping(!!evt.is_typing);
        });
      } catch {/* socket optional */}
    })();

    return () => {
      cancelled = true;
      if (unsubMsg) unsubMsg();
      if (unsubTyping) unsubTyping();
    };
  }, [params.threadId, user]);

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
      is_system: false
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
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>{head.title}</Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {typing ? `${head.title.split(" ")[0]} is typing…` : head.subtitle}
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
          mine && tightBottom && { borderBottomRightRadius: 6 },
          !mine && tightBottom && { borderBottomLeftRadius: 6 }
        ]}
      >
        {showName ? (
          <Text style={s.bubbleSender}>{msg.sender_name}</Text>
        ) : null}
        <Text style={mine ? s.bubbleTextMine : s.bubbleTextOther}>{msg.body}</Text>
        <Text style={mine ? s.bubbleTimeMine : s.bubbleTimeOther}>{fmtClock(msg.sent_at)}</Text>
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
    marginTop: 4,
    textAlign: "right"
  },
  bubbleTimeOther: {
    color: colors.soft,
    fontSize: 10,
    marginTop: 4,
    textAlign: "right"
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
