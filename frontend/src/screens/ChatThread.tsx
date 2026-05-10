import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Linking
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, RouteProp, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { call } from "@/api/client";
import { colors, radii, spacing } from "@/theme";
import { fmtTime } from "@/utils/dateUtils";
import { subscribeToThread, subscribeToTyping, ChatMessageEvent } from "@/realtime/socket";
import type { RootStackParamList } from "@/navigation/RootNavigator";

type Route = RouteProp<RootStackParamList, "ChatThread">;

type ThreadMeta = {
  name: string;
  thread_type: "Booking" | "Support";
  subject: string;
  status: "Open" | "Closed";
  driver?: string;
  passenger?: string;
  ride?: string;
  booking?: string;
};

type Counterparty = {
  label: string;
  mobile_no?: string | null;
};

type Message = {
  name: string;
  thread?: string;
  sender: string;
  sender_role: "Driver" | "Passenger" | "Support" | "System";
  sender_name?: string;
  sender_image?: string;
  body: string;
  sent_at: string | null;
  is_system: boolean | number;
  attachment?: string;
};

type GetThreadResp = {
  thread: ThreadMeta;
  messages: Message[];
  my_role: "Driver" | "Passenger" | "Support" | "Unknown";
};

export function ChatThreadScreen() {
  const { params } = useRoute<Route>();
  const nav = useNavigation();

  const [thread, setThread] = useState<ThreadMeta | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [myRole, setMyRole] = useState<string>("Unknown");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [otherTyping, setOtherTyping] = useState(false);
  const [counterparty, setCounterparty] = useState<Counterparty | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  const typingExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef<number>(0);
  const stopTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load + mark as read
  const reload = useCallback(async () => {
    try {
      const res = await call<GetThreadResp>("rideshare.api.chat.get_thread", {
        thread: params.threadId,
        limit: 100
      });
      setThread(res.thread);
      setMessages(res.messages || []);
      setMyRole(res.my_role);

      // Resolve counterparty name + phone (gated on the booking).  If the
      // backend doesn't have the field yet (Support thread, etc.), we just
      // surface the role-based label.
      try {
        if (res.thread.thread_type === "Booking" && res.thread.ride) {
          const summary = await call<{
            contacts?: {
              driver?: { name?: string; mobile_no?: string | null };
              passengers?: { user: string; name: string; mobile_no?: string | null }[];
            };
          }>("rideshare.api.mobile.ride_summary", { ride: res.thread.ride });
          const contacts = summary?.contacts;
          if (res.my_role === "Driver") {
            const p = contacts?.passengers?.find((x) => x.user === res.thread.passenger);
            setCounterparty({
              label: p?.name || "Passenger",
              mobile_no: p?.mobile_no ?? null
            });
          } else {
            setCounterparty({
              label: contacts?.driver?.name || "Driver",
              mobile_no: contacts?.driver?.mobile_no ?? null
            });
          }
        } else {
          setCounterparty(null);
        }
      } catch {
        setCounterparty(null);
      }

      // Best-effort mark as read.
      call("rideshare.api.chat.mark_read", { thread: params.threadId }).catch(() => {});
    } catch (e: any) {
      Alert.alert("Couldn't load chat", e?.message ?? "Try again.");
      nav.goBack();
    } finally {
      setLoading(false);
    }
  }, [params.threadId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Subscribe to realtime
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let unsubTyping: (() => void) | null = null;
    (async () => {
      try {
        unsub = await subscribeToThread(params.threadId, (msg: ChatMessageEvent) => {
          setMessages((prev) => {
            if (prev.some((p) => p.name === msg.name)) return prev;
            return [...prev, msg as Message];
          });
          // The other side just sent something — they obviously stopped typing.
          setOtherTyping(false);
          // Anything received while open is implicitly read.
          call("rideshare.api.chat.mark_read", { thread: params.threadId }).catch(() => {});
        });
      } catch {
        /* socket unavailable — REST polling fallback every 6s */
      }
      try {
        unsubTyping = await subscribeToTyping(params.threadId, (evt) => {
          // Ignore our own echoes (the backend already targets the other
          // user, but extra safety doesn't hurt).
          if (evt.sender_role === myRole) return;
          if (evt.is_typing) {
            setOtherTyping(true);
            if (typingExpiryRef.current) clearTimeout(typingExpiryRef.current);
            typingExpiryRef.current = setTimeout(() => setOtherTyping(false), 4000);
          } else {
            setOtherTyping(false);
            if (typingExpiryRef.current) clearTimeout(typingExpiryRef.current);
          }
        });
      } catch {
        /* typing is best-effort */
      }
    })();
    return () => {
      if (unsub) unsub();
      if (unsubTyping) unsubTyping();
      if (typingExpiryRef.current) clearTimeout(typingExpiryRef.current);
    };
  }, [params.threadId, myRole]);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: true })
      );
    }
  }, [messages.length]);

  function onBodyChange(next: string) {
    setBody(next);
    if (!thread || thread.status === "Closed") return;
    const trimmed = next.trim();
    if (!trimmed) {
      stopTypingNow();
      return;
    }
    // Throttle to one event every ~2.5s.
    const now = Date.now();
    if (now - lastTypingSentRef.current > 2500) {
      lastTypingSentRef.current = now;
      call("rideshare.api.chat.set_typing", {
        thread: params.threadId,
        is_typing: 1
      }).catch(() => {});
    }
    if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
    stopTypingTimerRef.current = setTimeout(stopTypingNow, 3500);
  }

  function stopTypingNow() {
    if (stopTypingTimerRef.current) {
      clearTimeout(stopTypingTimerRef.current);
      stopTypingTimerRef.current = null;
    }
    if (lastTypingSentRef.current === 0) return;
    lastTypingSentRef.current = 0;
    call("rideshare.api.chat.set_typing", {
      thread: params.threadId,
      is_typing: 0
    }).catch(() => {});
  }

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    stopTypingNow();
    setSending(true);
    setBody("");
    // Optimistic append
    const tempName = `__pending_${Date.now()}`;
    const optimistic: Message = {
      name: tempName,
      sender: "me",
      sender_role: (myRole as Message["sender_role"]) || "Passenger",
      body: text,
      sent_at: new Date().toISOString(),
      is_system: false
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await call<Message>("rideshare.api.chat.send_message", {
        thread: params.threadId,
        body: text
      });
      // Replace the optimistic row with the server-stamped one (avoids dupes
      // when the realtime echo arrives).
      setMessages((prev) =>
        prev.map((m) => (m.name === tempName ? { ...res, sender_name: m.sender_name } : m))
      );
    } catch (e: any) {
      // Roll back optimistic message on failure.
      setMessages((prev) => prev.filter((m) => m.name !== tempName));
      Alert.alert("Couldn't send", e?.message ?? "Try again.");
      setBody(text);
    } finally {
      setSending(false);
    }
  }

  if (loading || !thread) {
    return (
      <SafeAreaView style={s.shell}>
        <View style={[s.shell, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color={colors.text} />
        </View>
      </SafeAreaView>
    );
  }

  const isSupport = thread.thread_type === "Support";
  const counterpartyLabel = counterparty?.label
    || (isSupport
      ? myRole === "Support"
        ? "User"
        : "Rideshare Support"
      : myRole === "Driver"
        ? "Passenger"
        : "Driver");

  const closed = thread.status === "Closed";
  const phone = counterparty?.mobile_no || null;

  function callCounterparty() {
    if (!phone) return;
    Linking.openURL(`tel:${phone}`).catch(() =>
      Alert.alert("Couldn't open dialler", phone)
    );
  }

  return (
    <SafeAreaView style={s.shell} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={[s.avatar, isSupport && { backgroundColor: colors.warn }]}>
          {isSupport ? (
            <Ionicons name="help-buoy" size={18} color={colors.primaryText} />
          ) : (
            <Text style={s.avatarText}>{counterpartyLabel[0]}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>{counterpartyLabel}</Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {phone ? phone : thread.subject || "—"}
          </Text>
        </View>
        {phone ? (
          <TouchableOpacity style={s.callBtn} onPress={callCounterparty} activeOpacity={0.8}>
            <Ionicons name="call" size={18} color={colors.primaryText} />
          </TouchableOpacity>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.name}
          contentContainerStyle={{ padding: spacing(4), gap: 8, paddingBottom: 12 }}
          renderItem={({ item }) => <Bubble m={item} myRole={myRole} />}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />

        {otherTyping ? (
          <TypingFloater label={counterpartyLabel} />
        ) : null}

        {closed ? (
          <View style={s.closedBar}>
            <Ionicons name="lock-closed" size={14} color={colors.soft} />
            <Text style={s.closedText}>This conversation is closed.</Text>
          </View>
        ) : (
          <View style={s.inputBar}>
            <TextInput
              style={s.input}
              value={body}
              onChangeText={onBodyChange}
              onBlur={stopTypingNow}
              placeholder="Type a message…"
              placeholderTextColor={colors.mute}
              multiline
              maxLength={2000}
            />
            <TouchableOpacity
              style={[s.sendBtn, (!body.trim() || sending) && s.sendBtnOff]}
              onPress={send}
              disabled={!body.trim() || sending}
              activeOpacity={0.85}
            >
              {sending ? (
                <ActivityIndicator color={colors.primaryText} size="small" />
              ) : (
                <Ionicons name="arrow-up" size={20} color={colors.primaryText} />
              )}
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TypingFloater({ label }: { label: string }) {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    function bounce(v: Animated.Value, delay: number) {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 300, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
          Animated.timing(v, { toValue: 0, duration: 300, useNativeDriver: true, easing: Easing.in(Easing.quad) })
        ])
      );
    }
    const anims = [bounce(dot1, 0), bounce(dot2, 120), bounce(dot3, 240)];
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [dot1, dot2, dot3]);

  function dotStyle(v: Animated.Value) {
    return {
      transform: [
        {
          translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -4] })
        }
      ],
      opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] })
    };
  }

  return (
    <View style={s.typingWrap} pointerEvents="none">
      <View style={s.typingPill}>
        <Text style={s.typingLabel} numberOfLines={1}>{label} is typing</Text>
        <View style={s.typingDots}>
          <Animated.View style={[s.typingDot, dotStyle(dot1)]} />
          <Animated.View style={[s.typingDot, dotStyle(dot2)]} />
          <Animated.View style={[s.typingDot, dotStyle(dot3)]} />
        </View>
      </View>
    </View>
  );
}

function Bubble({ m, myRole }: { m: Message; myRole: string }) {
  const isSystem = m.is_system === true || m.is_system === 1;

  if (isSystem) {
    return (
      <View style={s.systemWrap}>
        <Text style={s.systemText}>{m.body}</Text>
      </View>
    );
  }

  const mine = m.sender_role === myRole || m.sender === "me";

  return (
    <View style={[s.bubbleRow, mine ? s.right : s.left]}>
      <View style={[s.bubble, mine ? s.bubbleMe : s.bubbleThem]}>
        {!mine && m.sender_name ? (
          <Text style={s.bubbleSender}>{m.sender_name}</Text>
        ) : null}
        <Text style={[s.bubbleText, mine && { color: colors.primaryText }]}>
          {m.body}
        </Text>
        <Text style={[s.bubbleTime, mine && { color: "rgba(255,255,255,0.7)" }]}>
          {m.sent_at ? fmtTime(m.sent_at) : ""}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
    gap: 10
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center"
  },
  avatarText: { color: colors.primaryText, fontWeight: "800", fontSize: 14 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: 12, color: colors.soft, marginTop: 2 },

  bubbleRow: { flexDirection: "row", marginVertical: 1 },
  left: { justifyContent: "flex-start" },
  right: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18
  },
  bubbleMe: { backgroundColor: colors.text, borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: colors.bgAlt, borderBottomLeftRadius: 4 },
  bubbleSender: { fontSize: 11, color: colors.soft, fontWeight: "700", marginBottom: 2 },
  bubbleText: { fontSize: 15, color: colors.text, lineHeight: 21 },
  bubbleTime: { fontSize: 10, color: colors.soft, marginTop: 4, alignSelf: "flex-end" },

  systemWrap: { alignItems: "center", marginVertical: 6, paddingHorizontal: 20 },
  systemText: {
    fontSize: 12,
    color: colors.soft,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: "hidden",
    textAlign: "center"
  },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    gap: 8
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 22,
    backgroundColor: colors.bgAlt,
    color: colors.text,
    fontSize: 15
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center"
  },
  sendBtnOff: { backgroundColor: colors.mute },

  closedBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    backgroundColor: colors.bgAlt,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  closedText: { color: colors.soft, fontSize: 13 },

  callBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.success,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4
  },

  typingWrap: {
    paddingHorizontal: spacing(4),
    marginBottom: 4,
    alignItems: "flex-start"
  },
  typingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.bgAlt,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: "80%"
  },
  typingLabel: { color: colors.soft, fontSize: 12, fontWeight: "600" },
  typingDots: { flexDirection: "row", alignItems: "center", gap: 3, height: 10 },
  typingDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.text
  }
});
