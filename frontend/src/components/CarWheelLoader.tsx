// Branded loading spinner shaped like a car wheel.
//
// Replaces the boring grey ActivityIndicator for full-screen / page
// loaders.  The wheel:
//
//   * Renders static at center (no position changes, no horizontal
//     motion).
//   * Spins around its own axis with a realistic "tire spin" tween:
//     starts slow (~0.6 rev/s), accelerates to a steady high speed
//     (~3 rev/s), then decelerates and stops the instant the parent
//     flips `isLoading` to false — but never earlier than the
//     `minDurationMs` we promised (default 4s, per design brief).
//
// The "stays for at least 4 s" guarantee is handled internally so
// every screen using <CarWheelLoader isLoading={...} /> gets a
// consistent feel without having to plumb a hold-open timer through
// its own state.
//
// Visual = pure RN <View>s + StyleSheet; no SVG dep, no image asset.
// We compose two concentric tyres, 5 spokes positioned with rotate
// transforms, and a center hub.  Looks like a car wheel without a
// bundle hit.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  ViewStyle
} from "react-native";
import { colors } from "@/theme";

export type CarWheelLoaderProps = {
  /** While true the wheel spins.  Flipping to false starts the
   *  deceleration only after `minDurationMs` has elapsed. */
  isLoading?: boolean;
  /** Diameter in px.  Default 80 (good for full-screen states).
   *  Pass 28 for a button-sized spinner. */
  size?: number;
  /** Optional caption under the wheel ("Loading rides…"). */
  label?: string;
  /** Hex/RGBA tire color.  Defaults to theme text color. */
  color?: string;
  /** Minimum display time (ms) — the wheel won't stop before this
   *  even if the data arrives faster.  Default 4000 per design. */
  minDurationMs?: number;
  /** Container override for layout customisation. */
  style?: ViewStyle;
};

const SPOKE_COUNT = 5;

export function CarWheelLoader({
  isLoading = true,
  size = 80,
  label,
  color = colors.text,
  minDurationMs = 4000,
  style
}: CarWheelLoaderProps): React.ReactElement | null {
  // We animate three things:
  //   `spin`       — rotation Animated.Value (0..1, loops)
  //   `speedRef`   — current spin speed, used to vary the loop time
  //   `mounted`    — once the parent flips to !isLoading AND we've
  //                  satisfied minDurationMs we trigger the slow-stop
  //                  exit animation, then unmount.
  const spin = useRef(new Animated.Value(0)).current;
  const speedScale = useRef(new Animated.Value(0)).current; // 0=slow, 1=full
  const mountedAt = useRef<number>(Date.now());
  const [visible, setVisible] = useState<boolean>(true);

  // -----------------------------------------------------------------
  // Drive the loop animation.  We don't use Animated.loop with fixed
  // duration because we need the loop's *period* to follow speedScale
  // (i.e. fast spin = short period).  Instead we run a self-renewing
  // animation that reads the latest speed off speedScale on every
  // iteration.
  // -----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let listenerId: string | null = null;
    let currentSpeed = 0; // 0..1
    listenerId = speedScale.addListener(({ value }) => {
      currentSpeed = value;
    });

    function step() {
      if (cancelled) return;
      // period ∈ [1666ms (slow, ~0.6 rev/s), 333ms (fast, ~3 rev/s)]
      const SLOW = 1666;
      const FAST = 333;
      const period = SLOW + (FAST - SLOW) * currentSpeed;
      spin.setValue(0);
      Animated.timing(spin, {
        toValue: 1,
        duration: period,
        easing: Easing.linear,
        useNativeDriver: true
      }).start(({ finished }) => {
        if (finished) step();
      });
    }
    step();

    return () => {
      cancelled = true;
      if (listenerId) speedScale.removeListener(listenerId);
      spin.stopAnimation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------
  // Phase machine: ramp speedScale 0→1 (ramp-up), hold at 1, then
  // when isLoading flips to false AND min time elapsed: 1→0 (ramp-
  // down) then unmount.
  // -----------------------------------------------------------------
  useEffect(() => {
    // On mount: ramp speed up from 0 to 1 over 900ms.
    Animated.timing(speedScale, {
      toValue: 1,
      duration: 900,
      easing: Easing.bezier(0.2, 0.7, 0.3, 1),
      useNativeDriver: false
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isLoading) return;
    const elapsed = Date.now() - mountedAt.current;
    const wait = Math.max(0, minDurationMs - elapsed);
    const t = setTimeout(() => {
      // Slow down (1 → 0) then hide.
      Animated.timing(speedScale, {
        toValue: 0,
        duration: 700,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: false
      }).start(() => setVisible(false));
    }, wait);
    return () => clearTimeout(t);
  }, [isLoading, minDurationMs, speedScale]);

  if (!visible) return null;

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"]
  });

  return (
    <View style={[s.wrap, style]} pointerEvents="none">
      <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
        <Wheel size={size} color={color} />
      </Animated.View>
      {label ? <Text style={s.label}>{label}</Text> : null}
    </View>
  );
}

/** The static wheel art.  Rotation is applied by the parent Animated.View. */
function Wheel({ size, color }: { size: number; color: string }): React.ReactElement {
  // Geometry — every measurement scales off `size` so the same
  // component renders cleanly at 28px (inline) or 96px (full-screen).
  const tireBorder = Math.max(3, Math.round(size * 0.10));
  const rimSize = size - tireBorder * 2;
  const hubSize = Math.max(8, Math.round(size * 0.18));
  const spokeWidth = Math.max(2, Math.round(size * 0.06));
  const spokeLength = rimSize / 2 - hubSize / 2 - 2;

  // Theme: wheel uses --color as the rubber tire (dark) and a
  // mid-grey rim/spoke contrast so the spin is visible.
  const rimColor = "#E5E7EB";
  const spokeColor = "#9CA3AF";
  const hubColor = color;

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: tireBorder,
        borderColor: color,
        backgroundColor: rimColor,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      {/* Spokes — equally distributed around the hub using rotate. */}
      {Array.from({ length: SPOKE_COUNT }).map((_, i) => {
        const angle = (360 / SPOKE_COUNT) * i;
        return (
          <View
            key={i}
            style={{
              position: "absolute",
              width: spokeWidth,
              height: spokeLength,
              backgroundColor: spokeColor,
              borderRadius: spokeWidth / 2,
              transform: [
                { rotate: `${angle}deg` },
                { translateY: -(spokeLength / 2 + hubSize / 4) }
              ]
            }}
          />
        );
      })}
      {/* Hub */}
      <View
        style={{
          width: hubSize,
          height: hubSize,
          borderRadius: hubSize / 2,
          backgroundColor: hubColor
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    gap: 14
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.soft,
    letterSpacing: 0.2
  }
});

// ---------------------------------------------------------------------------
// Convenience: a full-screen centered loader.
// ---------------------------------------------------------------------------
export function CarWheelLoaderScreen({
  label,
  isLoading,
  minDurationMs
}: {
  label?: string;
  isLoading?: boolean;
  minDurationMs?: number;
}): React.ReactElement {
  return (
    <View style={screenStyles.shell}>
      <CarWheelLoader
        size={96}
        label={label}
        isLoading={isLoading}
        minDurationMs={minDurationMs}
      />
    </View>
  );
}

const screenStyles = StyleSheet.create({
  shell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: colors.bg
  }
});
