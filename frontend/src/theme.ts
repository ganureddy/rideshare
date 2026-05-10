// Design tokens — Uber-inspired black & white palette.
// Keep this file authoritative: all screens import from here.
export const colors = {
  // Brand
  black: "#000000",
  white: "#FFFFFF",

  // Text
  text: "#0A0A0A",
  textInverse: "#FFFFFF",
  soft: "#6B7176",
  mute: "#9CA3AF",

  // Surfaces
  bg: "#FFFFFF",
  bgAlt: "#F6F6F6",
  card: "#FFFFFF",

  // Lines
  border: "#E5E7EB",
  borderStrong: "#D1D5DB",

  // Status
  success: "#1F8A4C",
  danger: "#D32F2F",
  warn: "#C77800",

  // Primary CTA = solid black (Uber)
  primary: "#000000",
  primaryPressed: "#1A1A1A",
  primaryText: "#FFFFFF",

  // Map / accents
  driverPin: "#0A0A0A",
  pickupPin: "#1F8A4C",
  dropoffPin: "#D32F2F",

  // Backwards-compat aliases (kept so legacy references compile while we
  // migrate the codebase; new code should use the names above).
  blue: "#000000",
  blueDark: "#1A1A1A"
};

export const radii = { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 };
export const spacing = (n: number) => n * 4;
export const fonts = { regular: "System", bold: "System" };

export const shadow = {
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 2
  },
  floating: {
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 4
  }
};
