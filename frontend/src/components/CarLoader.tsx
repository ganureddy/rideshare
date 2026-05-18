// Animated loader for the search flow.
//
// A single car drives in place while the road streams underneath it and a
// trail of smoke puffs rises from its exhaust.  Loops on a 4-second cycle.
// Built on the React Native `Animated` API only — no Reanimated, Skia, or
// Three.js — so it ships in the existing EAS Android preview build without
// touching the native module set.

import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing } from "@/theme";

type Props = {
  /** Optional caption under the car.  Defaults to "Finding your ride…". */
  label?: string;
};

const LOOP_MS = 4000;
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 180;
const CAR_SIZE = 88;

// 8 staggered smoke puffs keep the trail continuous over the 4 s loop.
const SMOKE_COUNT = 8;
const SMOKE_LIFE_MS = 1700;

export function CarLoader({ label }: Props) {
  // Master clock — drives the road dashes.  Always loops linearly.
  const t = useRef(new Animated.Value(0)).current;
  // One Animated.Value per smoke puff (0 → 1 across its lifetime).
  const smokeRefs = useRef(
    Array.from({ length: SMOKE_COUNT }, () => new Animated.Value(0))
  );
  // Tiny vertical bounce so the car reads as "running engine" instead of
  // a static decal.
  const bounce = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Capture the ref array locally so cleanup uses the same instance
    // even if the ref is reassigned later (hooks/exhaustive-deps lint).
    const puffs = smokeRefs.current;

    const roadLoop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: LOOP_MS,
        easing: Easing.linear,
        useNativeDriver: true
      })
    );
    roadLoop.start();

    const bounceLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, {
          toValue: 1,
          duration: 110,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(bounce, {
          toValue: 0,
          duration: 110,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true
        })
      ])
    );
    bounceLoop.start();

    const stagger = LOOP_MS / SMOKE_COUNT;
    const smokeLoops = puffs.map((puff, i) => {
      const seq = Animated.loop(
        Animated.sequence([
          Animated.delay(i * stagger),
          Animated.timing(puff, {
            toValue: 1,
            duration: SMOKE_LIFE_MS,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true
          }),
          // Reset to 0 instantly, then wait for the next slot before
          // re-spawning so the trail stays evenly spaced.
          Animated.timing(puff, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true
          }),
          Animated.delay(LOOP_MS - SMOKE_LIFE_MS - i * stagger)
        ])
      );
      seq.start();
      return seq;
    });

    return () => {
      roadLoop.stop();
      bounceLoop.stop();
      smokeLoops.forEach((l) => l.stop());
      t.setValue(0);
      bounce.setValue(0);
      puffs.forEach((p) => p.setValue(0));
    };
  }, [t, bounce]);

  // Road dashes scroll right-to-left to sell forward motion.  The dash
  // strip is twice as wide as the visible road so the wrap is invisible.
  const roadX = t.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -160]
  });

  // Subtle bob: car lifts about 2 px per engine cycle.
  const carY = bounce.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -2]
  });

  return (
    <View style={s.shell}>
      <View style={s.stage}>
        {/* Background layers — sky → distant hills → road */}
        <View style={s.sky} />
        <View style={s.hillBack} />
        <View style={s.hillFront} />

        <View style={s.road}>
          <Animated.View style={[s.dashes, { transform: [{ translateX: roadX }] }]}>
            {Array.from({ length: 14 }).map((_, i) => (
              <View key={i} style={s.dash} />
            ))}
          </Animated.View>
        </View>

        {/* Smoke trail — rendered BEFORE the car so puffs sit behind it. */}
        {smokeRefs.current.map((puff, i) => {
          // Puffs drift up and to the left (exhaust side), expand, and fade.
          const tx = puff.interpolate({
            inputRange: [0, 1],
            outputRange: [0, -110]
          });
          const ty = puff.interpolate({
            inputRange: [0, 1],
            outputRange: [0, -34]
          });
          const sc = puff.interpolate({
            inputRange: [0, 0.4, 1],
            outputRange: [0.35, 1, 1.7]
          });
          const op = puff.interpolate({
            inputRange: [0, 0.15, 0.6, 1],
            outputRange: [0, 0.55, 0.35, 0]
          });
          return (
            <Animated.View
              key={i}
              style={[
                s.smoke,
                {
                  opacity: op,
                  transform: [{ translateX: tx }, { translateY: ty }, { scale: sc }]
                }
              ]}
            />
          );
        })}

        {/* Car — centred, with engine bounce */}
        <Animated.View style={[s.car, { transform: [{ translateY: carY }] }]}>
          <Ionicons name="car-sport" size={CAR_SIZE} color={colors.text} />
        </Animated.View>
      </View>

      <Text style={s.label}>{label || "Finding your ride…"}</Text>
      <Text style={s.sub}>Matching drivers near your route</Text>
    </View>
  );
}

const ROAD_Y = 28;
const SMOKE_X = STAGE_WIDTH / 2 - CAR_SIZE / 2 - 6;
const SMOKE_Y = ROAD_Y + 28;

const s = StyleSheet.create({
  shell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    paddingHorizontal: spacing(6)
  },
  stage: {
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT,
    alignItems: "center",
    justifyContent: "flex-end",
    overflow: "hidden",
    borderRadius: radii.lg
  },
  sky: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: ROAD_Y + 6,
    backgroundColor: "#F2F6FA"
  },
  hillBack: {
    position: "absolute",
    bottom: ROAD_Y + 6,
    left: -40,
    right: 60,
    height: 60,
    borderRadius: 100,
    backgroundColor: "#DCE6EE"
  },
  hillFront: {
    position: "absolute",
    bottom: ROAD_Y + 4,
    left: 40,
    right: -60,
    height: 48,
    borderRadius: 80,
    backgroundColor: "#C8D5DF"
  },
  road: {
    position: "absolute",
    bottom: ROAD_Y - 8,
    left: 0,
    right: 0,
    height: 22,
    backgroundColor: "#1F2937",
    overflow: "hidden",
    justifyContent: "center"
  },
  dashes: {
    flexDirection: "row",
    gap: 12,
    paddingLeft: 4,
    width: STAGE_WIDTH * 2
  },
  dash: {
    width: 24,
    height: 3,
    borderRadius: 2,
    backgroundColor: "#F8FAFB",
    opacity: 0.85
  },
  smoke: {
    position: "absolute",
    left: SMOKE_X,
    bottom: SMOKE_Y,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#9CA3AF"
  },
  car: {
    position: "absolute",
    bottom: ROAD_Y + 6,
    alignSelf: "center"
  },
  label: {
    marginTop: spacing(5),
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.2
  },
  sub: {
    marginTop: 4,
    color: colors.soft,
    fontSize: 13
  }
});

export default CarLoader;
