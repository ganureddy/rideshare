// Branded loader — single car wheel spinning in place.
//
// Used wherever a full-screen "loading…" state is needed: ride
// search, ride detail, bookings list, tracking, chat threads.
//
// Design intent (per product brief):
//   * One wheel, static in the centre — never moves horizontally.
//   * Spin starts slow, accelerates to a steady fast spin, then
//     decelerates and stops the moment results arrive.
//   * Minimum 4-second display time so a slow network feels
//     deliberate rather than buggy, and the brand moment lands.
//
// Implementation lives in CarWheelLoader.tsx; this file re-exports
// it under the legacy name so the existing import sites
// (`@/components/CarLoader`) keep working.

import React from "react";
import { CarWheelLoaderScreen } from "@/components/CarWheelLoader";

export type CarLoaderProps = {
  /** Optional caption under the wheel.  Defaults to "Finding your ride…". */
  label?: string;
  /** Parent's loading state.  Defaults to true; the wheel decelerates
   *  to a stop when this flips false (but never before the 4s
   *  minimum has elapsed). */
  isLoading?: boolean;
};

export function CarLoader({
  label = "Finding your ride…",
  isLoading = true
}: CarLoaderProps): React.ReactElement {
  return <CarWheelLoaderScreen label={label} isLoading={isLoading} />;
}

export default CarLoader;
