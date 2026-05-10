# Rideshare — React Native (Expo) app

A mobile client for the `rideshare` Frappe app. Lets users:

- Log in with a phone number (no password — see the security note below).
- Search rides by start/end location, with Google Places autocomplete.
- Publish a ride with price suggestions and a map preview.
- Book a seat and follow the driver live on a map during the trip.

The backend is the same Frappe app under `apps/rideshare/`. This frontend
talks to it exclusively over `/api/method/...` endpoints — no DB access,
no shared code.

---

## Architecture

```
┌──────────────────────────┐         ┌───────────────────────────┐
│   React Native (Expo)    │ HTTPS   │    Frappe v15 (rideshare) │
│   - axios → /api/method  │────────▶│    DocTypes + whitelisted  │
│   - socket.io-client     │  WSS    │    methods + realtime ws   │
│   - SecureStore (token)  │────────▶│    /socket.io/             │
└──────────────────────────┘         └───────────────────────────┘
                                              │
                                              ▼
                                       MariaDB + Redis
```

**Auth.** The phone number screen calls `rideshare.api.auth.login_with_phone`
which mints an `(api_key, api_secret)` pair and returns it in the JSON.
Every subsequent call sends `Authorization: token <key>:<secret>`.
The pair is persisted in iOS Keychain / Android Keystore via `expo-secure-store`.

**Maps.** All Google Places calls (`autocomplete`, `place_details`,
`reverse_geocode`) are proxied through the Frappe backend at
`rideshare.api.places.*` so the API key stays on the server. Set the key
in **Rideshare Settings → Maps → Google Maps API Key** in Frappe Desk.

**Realtime.** When a driver opens the Tracking screen, expo-location
streams positions every 3 s; the screen pushes them every 5 s to
`rideshare.api.tracking.push_location`. The server stores the latest fix
on the `Ride` row and broadcasts via `frappe.publish_realtime` to room
`ride:<name>`. Passenger devices subscribe via Socket.IO and fall back to
a 5 s REST poll if the socket disconnects.

**Segment matching** is already built into the backend search: a ride
A → Z with waypoints (B, C, … M, … Y) shows up for an A → M passenger
search. See `rideshare/api/search.py`.

---

## Local development

### 1. Backend prereqs

From the bench root:

```bash
bench --site dev.in install-app rideshare       # if not installed yet
bench --site dev.in migrate                      # picks up the new tracking fields on Ride
bench --site dev.in clear-cache
bench start                                      # starts gunicorn + redis + socketio + worker
```

In **Rideshare Settings**, set:
- `Maps Provider` → `Google`
- `Google Maps API Key` → your server-side key (no Android/iOS app
  restrictions, since requests originate from the server)

### 2. Frontend

```bash
cd apps/rideshare/frontend
cp .env.example .env
# edit .env:
#   RIDESHARE_API_BASE=http://<your-LAN-IP>:8000
#   RIDESHARE_WS_URL=http://<your-LAN-IP>:9000
#   ANDROID_GOOGLE_MAPS_API_KEY=...   (a *device* key, restricted to your Android app's SHA-1)
#   IOS_GOOGLE_MAPS_API_KEY=...       (a *device* key, restricted to the iOS bundle id)

npm install
npx expo start                # Expo Dev Server
npx expo run:android          # builds a dev client and runs on an attached device/emulator
npx expo run:ios              # macOS only
```

> ⚠ `react-native-maps` cannot run in Expo Go (managed) — use a Dev Client
> (`expo run:android`) or an EAS build.

### Android emulator vs. device

- Emulator: the Frappe server on your laptop is reachable as
  `http://10.0.2.2:8000`. The default in `src/env.ts` falls back to this.
- Physical device on the same LAN: use your laptop's LAN IP, e.g.
  `http://192.168.1.20:8000`. The Frappe site must allow the host —
  add it under `bench --site dev.in set-config host_name` and to
  `common_site_config.json`.

---

## API surface used by the app

| Method | Endpoint | Notes |
|---|---|---|
| Login | `rideshare.api.auth.login_with_phone` | returns `api_key`, `api_secret` |
| Profile | `rideshare.api.auth.whoami` | header-auth call |
| Logout | `rideshare.api.auth.revoke_tokens` | rotates the secret |
| Places | `rideshare.api.places.autocomplete` | proxies Google |
| Place details | `rideshare.api.places.place_details` | resolves to lat/lng |
| Search rides | `rideshare.api.search.search_rides` | segment-aware A→Z covers A→M |
| Suggest price | `rideshare.api.rides.suggest_price` | km × per-km bands |
| Publish ride | `rideshare.api.rides.publish_ride` | JSON payload |
| Ride summary | `rideshare.api.mobile.ride_summary` | bundles waypoints + driver |
| Book seat | `rideshare.api.bookings.create_booking` | returns gateway order |
| Push location | `rideshare.api.tracking.push_location` | driver only |
| Get last location | `rideshare.api.tracking.get_last_location` | poll fallback |
| Start / complete trip | `rideshare.api.tracking.start_trip` / `complete_trip` | driver only |

Realtime events on room `ride:<name>`: `rideshare:location`, `rideshare:status`.

---

## Deployment

### A. Backend (Frappe) on a server

You almost certainly have this; the only Rideshare-specific bits are:

```bash
# On the production bench:
bench get-app rideshare <git-url>
bench --site <site> install-app rideshare
bench --site <site> migrate
bench setup nginx && sudo service nginx reload
bench setup supervisor && sudo supervisorctl reread && sudo supervisorctl update
```

The Socket.IO bridge runs on port 9000 by default. In nginx, proxy
`/socket.io/` to `http://localhost:9000` with WebSocket upgrade headers
— this is the standard Frappe production setup. If your nginx config
came from `bench setup nginx`, it's already correct.

Verify:

```bash
curl https://your-host/api/method/rideshare.api.auth.whoami   # 401 OK
curl https://your-host/rideshare/login                        # 200 OK (login page)
```

### B. Mobile app — Google Play Store via EAS

We use EAS Build (Expo Application Services) because it handles native
Google Maps + background location config plugins automatically. Steps:

```bash
# 0. One-time
npm i -g eas-cli
eas login
cd apps/rideshare/frontend
eas init                         # creates the EAS project; updates app.json `extra.eas.projectId`

# 1. Store secrets (production keys; never commit)
eas secret:create --scope project --name RIDESHARE_API_BASE --value https://api.rideshare.example
eas secret:create --scope project --name RIDESHARE_WS_URL  --value https://api.rideshare.example
eas secret:create --scope project --name ANDROID_GOOGLE_MAPS_API_KEY --value AIzaSy_DEVICE_KEY
eas secret:create --scope project --name IOS_GOOGLE_MAPS_API_KEY     --value AIzaSy_DEVICE_KEY

# 2. Internal preview APK (sideload to test devices)
eas build --platform android --profile preview

# 3. Production AAB (Play Store upload format)
eas build --platform android --profile production
```

EAS prints a download link for the resulting `.aab`. Then in **Google
Play Console**:

1. Create an app (one-time): Console → Create app, fill name/category.
2. Set up your store listing (icons, screenshots, short/long description,
   privacy policy URL, content rating questionnaire). Required before
   you can promote past Internal testing.
3. **Internal testing → Create new release → Upload AAB**. Add testers by
   email; share the opt-in link. This bypasses Play review.
4. When happy, **Production → Create new release**. Upload the same AAB
   (or a new build), fill release notes, submit for review. First review
   typically takes 1–7 days; Google has been faster lately.

#### Automated submission (optional)

```bash
# Save a Play service-account JSON (Console → Setup → API access) as:
apps/rideshare/frontend/play-service-account.json   # gitignored

eas submit --platform android --profile production
```

This ships the latest production build to the Internal track as a draft,
which you can promote in Play Console.

#### Things that bite first-timers

- **App signing:** Let Google manage the signing key (default in Play
  Console). EAS holds the upload key. Do not lose it; recovery is slow.
- **Maps API key restrictions:** the *Android* device key must be SHA-1
  + package-name restricted. EAS shows you the SHA-1 after the first
  production build (`eas credentials`). Add it to the key in Google Cloud
  Console → APIs & Services → Credentials.
- **Background location:** Play requires a justification + a recorded
  screencast. Submit a 30-second video showing the live-tracking screen
  during an active trip. App reviewers look for *visible UI* that
  explains why the app needs background location.
- **Privacy policy URL:** mandatory. Host one at
  `https://your-host/rideshare/privacy` or similar.
- **Data safety form:** declare phone number collection, location
  collection (precise + background), and that data is encrypted in
  transit. Hand-fill it on first submit.

---

## Security notes

The MVP authenticates by **phone number alone** — anyone who knows the
number can sign in. Before launch, gate `login_with_phone` behind an OTP
verified via MSG91. The `rideshare.utils.notifications` provider
abstraction is already in place; just add a `request_otp` and
`verify_otp` pair in `api/auth.py` and short-circuit
`login_with_phone` until verified.

Other production hardening:

- Pin the API base URL to HTTPS only (`fetch` will refuse cleartext on
  Android 9+ unless you add a network security config — don't).
- Add `react-native-rsa-pinning` or Expo's `expo-network` cert pinning if
  you must defend against on-device MITM.
- Set `User.api_secret`'s rotation cadence (e.g., revoke on every login
  from a new device).
- Move the Google Maps server-side key to a restricted GCP project,
  separate from the Android/iOS device keys. Set per-day quota caps.

---

## Project layout

```
apps/rideshare/frontend/
├── App.tsx
├── app.config.js          # dynamic Expo config (reads .env)
├── app.json               # Expo manifest
├── eas.json               # EAS build/submit profiles
├── index.ts               # registers root component
├── package.json
├── tsconfig.json
└── src/
    ├── env.ts
    ├── theme.ts
    ├── api/client.ts             # axios + Frappe error normalisation
    ├── auth/
    │   ├── AuthContext.tsx
    │   └── store.ts              # SecureStore-backed credentials
    ├── components/
    │   └── PlacesAutocomplete.tsx
    ├── navigation/
    │   └── RootNavigator.tsx
    ├── realtime/
    │   └── socket.ts
    └── screens/
        ├── Login.tsx
        ├── Search.tsx
        ├── SearchResults.tsx
        ├── RideDetail.tsx
        ├── Publish.tsx
        ├── Tracking.tsx
        ├── Trips.tsx
        └── Profile.tsx
```
