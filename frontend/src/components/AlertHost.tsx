// Modern, animated replacement for React Native's built-in Alert.alert.
//
// Why a custom component?
// =======================
// RN's `Alert.alert` is OS-native and consistently *ugly* on Android
// (gray box, no theming).  It also can't be triggered programmatically
// without an active component, so utility files (like upload.ts) end
// up importing the Alert module just to surface a permission prompt.
//
// This module exposes:
//
//   * `<AlertHost />` — a single component mounted once at the App
//     root that owns the modal state.  It listens to an in-memory
//     pub/sub channel and renders the next alert from a queue.
//
//   * `alert(title, message?, buttons?, options?)` — an imperative
//     function with the *exact same signature* as `Alert.alert`, so
//     existing call sites change only the import.  Calls are queued
//     so two simultaneous calls don't stomp each other; the next one
//     pops in when the current is dismissed.
//
//   * `useAlert()` — optional hook for screens that want a typed
//     callback.  Just sugar over the imperative `alert`.
//
// Visual notes:
//   * Spring-in entry (scale + fade); fade-out on dismiss.
//   * Backdrop tap dismisses with the "cancel" button's onPress
//     (matches Alert.alert semantics).
//   * Destructive buttons get a red CTA; default/cancel are neutral.
//   * Icon is auto-picked from the (kind) hint or can be passed
//     explicitly.

import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Platform
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, radii, spacing } from "@/theme";

export type AlertButtonStyle = "default" | "cancel" | "destructive";

export type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: AlertButtonStyle;
};

export type AlertOptions = {
  cancelable?: boolean;
  /** Visual hint that picks a header icon + accent. */
  kind?: "info" | "success" | "warn" | "error" | "confirm";
  /** Override the auto-picked Ionicons name. */
  icon?: keyof typeof Ionicons.glyphMap | null;
};

type QueuedAlert = {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
  options: AlertOptions;
};

let _seq = 1;
const _queue: QueuedAlert[] = [];
const _listeners = new Set<(next: QueuedAlert | null) => void>();
let _current: QueuedAlert | null = null;

function _publish() {
  for (const l of _listeners) l(_current);
}

function _pop() {
  if (_queue.length > 0) {
    _current = _queue.shift() ?? null;
  } else {
    _current = null;
  }
  _publish();
}

/**
 * Drop-in replacement for `Alert.alert(title, message?, buttons?, options?)`.
 *
 * Signature mirrors React Native's so refactoring is a search-replace
 * on the import line.  Buttons default to a single "OK" when omitted.
 */
export function alert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions
): void {
  const item: QueuedAlert = {
    id: _seq++,
    title,
    message,
    buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK", style: "default" }],
    options: options || {}
  };
  if (_current) {
    _queue.push(item);
  } else {
    _current = item;
    _publish();
  }
}

/** Hook variant — handy when a component already has the screen handle. */
export function useAlert() {
  return alert;
}

/**
 * Mount once at the root of the app (alongside SafeAreaProvider).
 * Renders zero UI when no alerts are pending.
 */
export function AlertHost(): React.ReactElement | null {
  const [current, setCurrent] = useState<QueuedAlert | null>(_current);
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.94)).current;

  useEffect(() => {
    const fn = (next: QueuedAlert | null) => setCurrent(next);
    _listeners.add(fn);
    return () => {
      _listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!current) {
      // Hide animation handled by Modal's fade; reset values for next.
      opacity.setValue(0);
      scale.setValue(0.94);
      return;
    }
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.spring(scale, {
        toValue: 1,
        damping: 16,
        stiffness: 240,
        mass: 0.7,
        useNativeDriver: true
      })
    ]).start();
  }, [current, opacity, scale]);

  if (!current) return null;

  const { title, message, buttons, options } = current;
  const cancelBtn = buttons.find((b) => b.style === "cancel");
  const isCancelable = options.cancelable !== false;

  function dismiss(btn?: AlertButton) {
    Animated.timing(opacity, {
      toValue: 0,
      duration: 110,
      useNativeDriver: true
    }).start(() => {
      try { btn?.onPress?.(); } catch {/* user code */}
      _pop();
    });
  }

  function onBackdropPress() {
    if (!isCancelable) return;
    dismiss(cancelBtn);
  }

  const kind = options.kind || (cancelBtn && buttons.length > 1 ? "confirm" : "info");
  const accent = ACCENT[kind] || ACCENT.info;
  const iconName: keyof typeof Ionicons.glyphMap | null =
    options.icon === null ? null : options.icon || (DEFAULT_ICON[kind] as any);

  // Single-button shortcut (OK only) — render as a wide single CTA.
  const singleButton = buttons.length === 1;
  // Two-button — horizontal cancel + action.
  // Three+ — vertical stack.
  const stackVertical = buttons.length > 2;

  return (
    <Modal
      transparent
      visible={!!current}
      animationType="fade"
      statusBarTranslucent
      hardwareAccelerated
      onRequestClose={onBackdropPress}
    >
      <Pressable style={s.backdrop} onPress={onBackdropPress}>
        <Animated.View
          style={[s.card, { opacity, transform: [{ scale }] }]}
          // Stop touches on the card from bubbling to the backdrop.
          onStartShouldSetResponder={() => true}
        >
          {iconName ? (
            <View style={[s.iconWrap, { backgroundColor: accent.bg }]}>
              <Ionicons name={iconName} size={26} color={accent.fg} />
            </View>
          ) : null}
          <Text style={s.title}>{title}</Text>
          {message ? <Text style={s.message}>{message}</Text> : null}

          <View style={[s.actions, stackVertical ? s.actionsVertical : s.actionsHorizontal]}>
            {buttons.map((b, i) => {
              const isDest = b.style === "destructive";
              const isCancel = b.style === "cancel";
              const isLast = i === buttons.length - 1;
              const primary = !isCancel && (isLast || singleButton);
              return (
                <TouchableOpacity
                  key={`${b.text}-${i}`}
                  style={[
                    s.btn,
                    stackVertical
                      ? s.btnFullWidth
                      : singleButton
                      ? s.btnFullWidth
                      : s.btnFlex,
                    isCancel
                      ? s.btnCancel
                      : isDest
                      ? s.btnDestructive
                      : primary
                      ? s.btnPrimary
                      : s.btnNeutral
                  ]}
                  onPress={() => dismiss(b)}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      s.btnText,
                      isCancel
                        ? s.btnCancelText
                        : isDest
                        ? s.btnDestructiveText
                        : primary
                        ? s.btnPrimaryText
                        : s.btnNeutralText
                    ]}
                    numberOfLines={1}
                  >
                    {b.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const ACCENT: Record<string, { bg: string; fg: string }> = {
  info:     { bg: "#E8F0FE", fg: colors.brand },
  success:  { bg: "#E8F6EE", fg: colors.success },
  warn:     { bg: "#FFF3E0", fg: colors.warn },
  error:    { bg: "#FDECEA", fg: colors.danger },
  confirm:  { bg: "#F1F5F9", fg: colors.text }
};

const DEFAULT_ICON: Record<string, string> = {
  info: "information-circle",
  success: "checkmark-circle",
  warn: "warning",
  error: "alert-circle",
  confirm: "help-circle"
};

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing(5)
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: spacing(5),
    alignItems: "center",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowOffset: { width: 0, height: 12 },
        shadowRadius: 28
      },
      android: { elevation: 12 }
    })
  },
  iconWrap: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing(3)
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.text,
    textAlign: "center",
    letterSpacing: -0.3
  },
  message: {
    marginTop: 8,
    fontSize: 14,
    color: colors.soft,
    textAlign: "center",
    lineHeight: 20
  },

  actions: {
    width: "100%",
    marginTop: spacing(5),
    gap: 10
  },
  actionsHorizontal: {
    flexDirection: "row"
  },
  actionsVertical: {
    flexDirection: "column"
  },
  btn: {
    paddingVertical: 14,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center"
  },
  btnFullWidth: { width: "100%" },
  btnFlex: { flex: 1 },
  btnText: {
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: -0.2
  },

  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryText: { color: colors.primaryText },

  btnNeutral: { backgroundColor: colors.bgAlt, borderWidth: 1, borderColor: colors.border },
  btnNeutralText: { color: colors.text },

  btnDestructive: { backgroundColor: colors.danger },
  btnDestructiveText: { color: "#FFFFFF" },

  btnCancel: { backgroundColor: colors.bgAlt, borderWidth: 1, borderColor: colors.border },
  btnCancelText: { color: colors.soft, fontWeight: "700" }
});
