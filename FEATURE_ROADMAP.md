# Rideshare Feature Roadmap

The 21 features I proposed across Tier 2 + Tier 3 + Tier 4. **5 are
shipped this round** (this doc); the remaining **16** are scoped here
with effort estimates so we can ship them one at a time without
re-introducing the crash class we just fought through.

## Just shipped (this round)

| Feature | Where it lives now | What it does |
| --- | --- | --- |
| **2.1 Reviews & ratings** | `Ride Review` doctype + `rideshare.api.reviews` + `RatingPromptModal.tsx` | Pending-review banner on Trips → 5-star modal with quick tags + comment → driver/rider rating updates live |
| **2.5 Quick replies in chat** | `QuickReplies` in `ChatThread.tsx` | Role-specific canned-message chips above composer; one-tap send |
| **2.6 CO₂ saved counter** | `rideshare.api.co2` + green Profile card | Hourly scheduler aggregates per-user kg saved; "trees equivalent" framing on Profile |
| **4.7 Vehicle photos in search** | `search.py` returns `vehicle_photo`; `SearchResults.tsx` renders it | Each search card shows the actual car (from existing photos) + driver portrait overlay |
| **4.1 One-tap re-book** | "Book this route again" link on Past bookings card | Pre-fills SearchResults with the same origin/dest/seats |

## Already paid for by this round (cheap incremental wins)

The schema we added unlocks several follow-ups for ~half a day each:

- **Display reviews on RideDetail** — `list_reviews(driver_id, limit=5)` already works. Add a "What riders say" section under the Publisher card. ~3 hours.
- **Show driver rating on chat header** — read `driver_avg_rating` from the existing thread's driver field. ~1 hour.
- **Per-trip CO₂ in confirmation alert** — call `co2.saved_for_ride(distance, seats)` on the success Alert. ~30 min.

## Tier 2 — remaining (1-2 weeks each)

### 2.2 Wallet + cashbacks + refunds — **2 weeks**
- **Doctypes**: `Wallet` (one per user, balance), `Wallet Transaction` (credit/debit, type, source booking).
- **API**: `wallet.balance()`, `wallet.transactions()`, hooks into `bookings._refund_booking` to credit wallet instead of bank when sub-100% refund.
- **Mobile**: balance pill on Profile, "Use wallet" toggle on Razorpay checkout (subtract from order amount).
- Naturally pairs with the **Referrals** below — they share the wallet ledger.

### 2.3 Voice messages in chat — **2-3 days**
- Schema is already there (`message_type=audio`, `attachment_meta.duration_seconds`).
- Bubble already renders the play row.
- **Missing**: `expo-av` recorder UI in the composer, audio playback. Drop-in code is in `CHAT_ARCHITECTURE.md` § 7.
- Risk note: `expo-av` is a new native module — verify the build is stable for a week before adding.

### 2.4 Hindi UI (+ regional languages) — **1 week initial**
- One `i18n.ts` util (no dependency) — wraps every user-facing string.
- Ship `en.json`, `hi.json` first.
- Auto-detect locale via `expo-localization` (already a peer dep of expo-* libs); manual override on Profile.
- Add `ta.json`, `te.json`, `mr.json`, `bn.json` over the next month with translator help.

## Tier 3 — long-term moats (3-6 weeks each)

### 3.1 Office / community partnerships — **3-4 weeks**
- New `Organisation` doctype with verified email-domain whitelist.
- Office-only ride channel inside the app (filter on `Ride.organisation`).
- B2B onboarding flow: admin creates an Organisation, invites employees, employees verify via email link.
- Single biggest sticky-user moat for daily commute. **Recommend after 2.2 (Wallet) ships** because corporate accounts often want pooled billing.

### 3.2 Recurring monthly subscription pass — **3 weeks**
- New `Subscription` + `Subscription Pass Usage` doctypes.
- Razorpay Subscriptions API (already supported by your gateway abstraction — uses the same key/secret).
- Settlement engine: drivers paid per-km from a pooled fund, riders see one monthly invoice.
- Enables the daily-commute LTV uplift. **Pair with 2.2 (Wallet) and 1.3 (Recurring rides) — all three together unlock the commute story.**

### 3.3 In-app VoIP calls — **2-3 weeks**
- `react-native-webrtc` is bare-RN only — would force a dev-client build. Use a service like Sinch or Twilio Voice instead, or skip until Expo SDK adds native WebRTC support.
- Cost-sensitive? Skip this. Phone-number masking (already shipping post-Confirmed) covers 80% of the value.

### 3.4 Driver analytics + tax reports — **2 weeks**
- Analytics screen: weekly earnings chart, fuel cost tracker (driver inputs), GST-ready trip log.
- One PDF export per quarter using existing Frappe print formats — a few hundred lines of Jinja.
- Major retention driver for the supply side; gig workers list rides on whichever platform makes their tax filing easiest.

### 3.5 ML-driven price suggestion + ETA — **3-4 weeks (compounds)**
- Replace `rideshare.api.rides.suggest_price` median heuristic with a small per-route regression model.
- Train nightly on completed Booking + Ride data; serve via a `Price Model` doctype with versioned weights.
- ETA model layered on OSRM; blend in your own trip-completion telemetry.
- **Best deferred** until you have ~10k completed rides — anything less, the heuristic is competitive.

### 3.6 Verified driver tier (KYC) — **3-4 weeks**
- DigiLocker integration for driving-licence verification (govt API, free for non-profits, paid otherwise).
- Optional background check via BetterPlace / ScreeningStar.
- New `Verification` doctype, "Verified" badge on driver display, premium pricing for verified rides.
- Big trust win for women + first-time riders. **Recommend after 2.4 (Hindi UI)** because most KYC providers' SDKs surface Hindi/English mixed text and you'll want translation infrastructure ready.

## Tier 4 — quick wins (1-3 days each)

These don't drive acquisition by themselves but compound retention. Pick & ship in any order.

### 4.2 Pickup countdown — **1 day**
"Driver arrives in 4 min" pulsing pill on the home screen when the driver is within 1 km. Reuses existing `tracking.get_last_location` + `summary.driver_display`.

### 4.3 Calendar integration — **1 day**
"Add to calendar" link on every Confirmed booking. `expo-calendar` is already an Expo-managed native module — same risk model as expo-av; defer until stable.

### 4.4 Music sync via passengers — **2-3 days**
Spotify Web Playback SDK in the WebView; passengers vote on next track. Driver's app plays the winning track. A "wow" feature with low retention impact — defer.

### 4.5 Toll fee splitting — **1 day**
Driver enters toll cost mid-trip → auto-split among confirmed riders → wallet debit. Depends on **2.2 Wallet** shipping first.

### 4.6 Multi-language chat translation — **2 days**
Tap-and-hold a message → translate via Google Translate API (paid; free tier 500k chars/month). Useful for Hindi ↔ English crossover.

### 4.8 Pickup chat shortcut — **1 day**
When driver is < 500 m away, swap "Track ride" CTA for "I'm here — start the ride" with a sound cue. Reuses `tracking.get_last_location` distance calc.

### 4.9 Achievements / streaks — **2 days**
`Achievement` doctype with badges (10 trips, 100 km, 5★ streak); ₹50 wallet credit on milestones. Depends on **2.2 Wallet**.

## Recommended order to ship the next 4 weeks

| Week | Ship | Cumulative effect |
| --- | --- | --- |
| 1 | **2.2 Wallet** | Refunds become instant; foundation for referrals + tolls + achievements. |
| 2 | **Display reviews on RideDetail** + **driver rating in chat header** + **per-trip CO₂ alert** | All quick wins from this round's schema. ~1 day each, big perceived polish. |
| 3 | **2.3 Voice messages** (only if EAS build is stable for 7+ days) | Conversion lever for non-English-first users. |
| 4 | **2.4 Hindi UI** | Doubles your TAM in India. |

Then in **months 2-3**: Tier 3 picks based on which segment you want to grow:
- Daily commuters → 3.1 (Office partnerships) + 3.2 (Subscription pass) + 1.3 (Recurring rides — already in Tier 1 backlog).
- Trust-sensitive segment (women, parents) → 3.6 (Verified drivers) + 1.4 (SOS — already in Tier 1 backlog).
- Driver supply → 3.4 (Driver analytics).

## Why I'm pacing it this way

Three things have to be true for new features to drive retention rather than churn:

1. **The build doesn't crash.** Every native module is a coin flip on Android release builds. We already learned this the hard way. Voice + calendar + WebRTC all carry that risk; gate them behind a "build stable for 7 days" rule.
2. **The previous feature actually got used.** Shipping 21 things at once means you don't know which one moved the needle. Ship 1-2 per week and watch the metrics for each one.
3. **Backend schema doesn't lock us in.** Every Tier 2 doctype this round (`Ride Review`) was built with the explicit assumption that we'd hang more aggregates off it later (rider rating, badges, achievements). Same for the Wallet doctype I'm proposing for week 1.

Tell me which item to ship next; I'll run it the same way I ran Razorpay + reviews + CO₂ this round: clean code, scoped change, real docs.
