// Animated loader — used while the search API is in flight.
//
// Design intent: a single running car as an "animated logo" — wheels
// spinning, a smoke plume drifting from the rear wheel, the body bobbing
// like an idling engine, the whole car gliding horizontally back and
// forth on a transparent stage (no road, no scenery).  4-second loop so
// the user always sees one complete cycle before results render.
//
// Implementation notes:
//  * Pure React Native `Animated` API — runs on the native driver so it
//    stays smooth even when JS is busy with the API call.  No new native
//    dependencies, so this keeps shipping in the existing EAS build.
//  * "Smoke" is a staggered cohort of soft grey circles spawning at the
//    rear-wheel anchor, drifting up + back, scaling up and fading out.
//  * Wheels are two filled circles rotating 360° per "tire revolution".
//  * Car body is built from layered <View>s instead of an Ionicon so the
//    silhouette stays crisp at any size and the wheels can be positioned
//    precisely under it.

import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "@/theme";

type Props = {
  /** Optional caption under the car.  Defaults to "Finding your ride…". */
  label?: string;
};

const LOOP_MS = 4000;
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 180;
const CAR_BODY_WIDTH = 132;
const CAR_BODY_HEIGHT = 36;
const CAR_CABIN_WIDTH = 78;
const CAR_CABIN_HEIGHT = 26;
const WHEEL = 22;
const TIRE_REV_MS = 600;
const BOUNCE_MS = 240;
const SMOKE_COUNT = 9;
const SMOKE_LIFE_MS = 1500;

export function CarLoader({ label }: Props) {
  // Master clock for the horizontal glide.
  const t = useRef(new Animated.Value(0)).current;
  // Tire rotation — one continuous spin.
  const tire = useRef(new Animated.Value(0)).current;
  // Engine bounce — short up/down for "running" feel.
  const bounce = useRef(new Animated.Value(0)).current;
  // 9 staggered smoke puffs.
  const smokeRefs = useRef(
    Array.from({ length: SMOKE_COUNT }, () => new Animated.Value(0))
  );

  useEffect(() => {
    const puffs = smokeRefs.current;

    const glide = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: LOOP_MS,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true
        })
      ])
    );
    glide.start();

    const tireSpin = Animated.loop(
      Animated.timing(tire, {
        toValue: 1,
        duration: TIRE_REV_MS,
        easing: Easing.linear,
        useNativeDriver: true
      })
    );
    tireSpin.start();

    const bounceLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, {
          toValue: 1,
          duration: BOUNCE_MS / 2,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(bounce, {
          toValue: 0,
          duration: BOUNCE_MS / 2,
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
      glide.stop();
      tireSpin.stop();
      bounceLoop.stop();
      smokeLoops.forEach((l) => l.stop());
      t.setValue(0);
      tire.setValue(0);
      bounce.setValue(0);
      puffs.forEach((p) => p.setValue(0));
    };
  }, [t, tire, bounce]);

  // Horizontal travel: glide left → mid → right → mid → left across the
  // stage centre, with momentary pauses at the extremes (Easing.inOut).
  const TRAVEL = (STAGE_WIDTH - CAR_BODY_WIDTH) / 2 - 6;
  const carX = t.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [-TRAVEL, TRAVEL, -TRAVEL]
  });

  // Subtle tilt — nose down when accelerating right, nose up when going left.
  const carRotate = t.interpolate({
    inputRange: [0, 0.25, 0.5, 0.75, 1],
    outputRange: ["1deg", "-1.5deg", "1deg", "-1.5deg", "1deg"]
  });

  // Engine bob.
  const carY = bounce.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -1.5]
  });

  // Tire rotation.
  const wheelSpin = tire.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"]
  });

  return (
    <View style={s.shell}>
      <View style={s.stage}>
        {/* Smoke trail — rendered BEHIND the car (lower z by source order). */}
        {smokeRefs.current.map((puff, i) => {
          // Smoke origin sits behind the rear wheel and follows the car
          // horizontally (same translateX as the car), then puffs additionally
          // drift back / up / out as their lifetime elapses.
          const driftX = puff.interpolate({
            inputRange: [0, 1],
            outputRange: [0, -42]
          });
          const driftY = puff.interpolate({
            inputRange: [0, 1],
            outputRange: [0, -38]
          });
          const sc = puff.interpolate({
            inputRange: [0, 0.4, 1],
            outputRange: [0.3, 1, 1.9]
          });
          const op = puff.interpolate({
            inputRange: [0, 0.15, 0.6, 1],
            outputRange: [0, 0.5, 0.3, 0]
          });
          return (
            <Animated.View
              key={i}
              style={[
                s.smokeAnchor,
                {
                  // Smoke spawns from the same X as the car (so it trails it
                  // across the stage) and then drifts backward in puff-space.
                  transform: [{ translateX: carX }]
                }
              ]}
            >
              <Animated.View
                style={[
                  s.smoke,
                  {
                    opacity: op,
                    transform: [
                      { translateX: driftX },
                      { translateY: driftY },
                      { scale: sc }
                    ]
                  }
                ]}
              />
            </Animated.View>
          );
        })}

        {/* Car — body + cabin + wheels, all bobbing as a unit. */}
        <Animated.View
          style={[
            s.car,
            {
              transform: [
                { translateX: carX },
                { translateY: carY },
                { rotateZ: carRotate }
              ]
            }
          ]}
        >
          {/* Cabin (roof) */}
          <View style={s.cabin}>
            <View style={s.windowLeft} />
            <View style={s.windowRight} />
            <View style={s.pillar} />
          </View>
          {/* Headlight */}
          <View style={s.headlight} />
          {/* Tail-light */}
          <View style={s.taillight} />
          {/* Body (chassis) */}
          <View style={s.body} />
          {/* Wheels */}
          <Animated.View
            style={[
              s.wheel,
              s.wheelRear,
              { transform: [{ rotate: wheelSpin }] }
            ]}
          >
            <View style={s.hub} />
            <View style={s.spoke} />
            <View style={[s.spoke, { transform: [{ rotate: "60deg" }] }]} />
            <View style={[s.spoke, { transform: [{ rotate: "120deg" }] }]} />
          </Animated.View>
          <Animated.View
            style={[
              s.wheel,
              s.wheelFront,
              { transform: [{ rotate: wheelSpin }] }
            ]}
          >
            <View style={s.hub} />
            <View style={s.spoke} />
            <View style={[s.spoke, { transform: [{ rotate: "60deg" }] }]} />
            <View style={[s.spoke, { transform: [{ rotate: "120deg" }] }]} />
          </Animated.View>
        </Animated.View>
      </View>

      <Text style={s.label}>{label || "Finding your ride…"}</Text>
      <Text style={s.sub}>Matching drivers near your route</Text>
    </View>
  );
}

const REAR_WHEEL_X = 18;            // px from car-left edge
const SMOKE_ORIGIN_Y = -CAR_BODY_HEIGHT / 2 - 4;

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
    justifyContent: "center"
  },

  // Smoke trail
  smokeAnchor: {
    position: "absolute",
    // Pin to the rear wheel of the car at rest (same Y as car).
    left: STAGE_WIDTH / 2 - CAR_BODY_WIDTH / 2 + REAR_WHEEL_X,
    top: STAGE_HEIGHT / 2 + SMOKE_ORIGIN_Y
  },
  smoke: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#A8B0B7"
  },

  // Car group — anchored at stage centre, transforms drive movement.
  car: {
    position: "absolute",
    width: CAR_BODY_WIDTH,
    height: CAR_BODY_HEIGHT + 14,
    alignItems: "center",
    justifyContent: "flex-end"
  },
  // Cabin (roof) sits on top.
  cabin: {
    position: "absolute",
    top: -CAR_CABIN_HEIGHT + 6,
    left: (CAR_BODY_WIDTH - CAR_CABIN_WIDTH) / 2,
    width: CAR_CABIN_WIDTH,
    height: CAR_CABIN_HEIGHT,
    backgroundColor: colors.text,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    overflow: "hidden"
  },
  windowLeft: {
    position: "absolute",
    top: 5,
    left: 6,
    width: (CAR_CABIN_WIDTH - 18) / 2,
    height: CAR_CABIN_HEIGHT - 12,
    borderRadius: 4,
    backgroundColor: "#9AC1F3"
  },
  windowRight: {
    position: "absolute",
    top: 5,
    right: 6,
    width: (CAR_CABIN_WIDTH - 18) / 2,
    height: CAR_CABIN_HEIGHT - 12,
    borderRadius: 4,
    backgroundColor: "#9AC1F3"
  },
  pillar: {
    position: "absolute",
    top: 4,
    left: CAR_CABIN_WIDTH / 2 - 1.5,
    width: 3,
    height: CAR_CABIN_HEIGHT - 8,
    backgroundColor: colors.text
  },
  // Chassis.
  body: {
    width: CAR_BODY_WIDTH,
    height: CAR_BODY_HEIGHT,
    backgroundColor: colors.text,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 12,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8
  },
  headlight: {
    position: "absolute",
    right: 6,
    top: CAR_BODY_HEIGHT - 22,
    width: 8,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FFD66B"
  },
  taillight: {
    position: "absolute",
    left: 6,
    top: CAR_BODY_HEIGHT - 22,
    width: 6,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#D32F2F"
  },
  // Wheels.
  wheel: {
    position: "absolute",
    bottom: -WHEEL / 2 + 2,
    width: WHEEL,
    height: WHEEL,
    borderRadius: WHEEL / 2,
    backgroundColor: "#1F2937",
    borderWidth: 3,
    borderColor: "#3F4956",
    alignItems: "center",
    justifyContent: "center"
  },
  wheelFront: { right: 14 },
  wheelRear: { left: REAR_WHEEL_X - WHEEL / 2 },
  hub: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#C8D0DA"
  },
  spoke: {
    position: "absolute",
    width: WHEEL - 8,
    height: 2,
    borderRadius: 1,
    backgroundColor: "#8A95A4"
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
