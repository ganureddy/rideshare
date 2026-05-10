// Helpers for converting between JS Date and the strings Frappe expects.
//
// Frappe's `Datetime` field is stored as `YYYY-MM-DD HH:mm:ss` in the
// site's local timezone.  We always emit local-time strings (no UTC
// conversion) — this matches `frappe.utils.get_datetime` semantics.

export function toApiDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function toApiDateTime(d: Date): string {
  const date = toApiDate(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${date} ${hh}:${mi}:${ss}`;
}

/** Combine a date-bearing Date and a time-bearing Date into one. */
export function combineDateAndTime(date: Date, time: Date): Date {
  const out = new Date(date);
  out.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return out;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d.replace(" ", "T")) : d;
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

export function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d.replace(" ", "T")) : d;
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d.replace(" ", "T")) : d;
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Returns a Date pinned at the next round hour, used as a default for
 *  the Publish screen's departure time. */
export function defaultDeparture(): Date {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}
