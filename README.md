# Rideshare — BlaBlaCar-style carpooling on Frappe v15

A custom [Frappe Framework](https://frappeframework.com/) app that turns an
ERPNext 15 site into an intercity ride-sharing marketplace, modelled on
[BlaBlaCar](https://www.blablacar.in/).

> Status: **Phases 1 → 5 complete** — scaffolding, onboarding, ride
> publishing, public search, booking + payments + cancellation.  The full
> end-to-end marketplace is now usable on the public site at `/`.
>
> **Authentication is currently mobile-number only — no OTP, no password.**
> This is a fun-MVP demo configuration for fast feedback; replace with OTP
> via MSG91 before real launch (see `docs/USER_GUIDE.md`).

## What's here today

- 10 DocTypes wired across 3 modules:
  `City`, `Driver Profile`, `Vehicle`, `Vehicle Photo`,
  `Ride`, `Ride Waypoint`, `Booking`, `Cancellation Log`,
  `Payment Transaction`, `Rideshare Settings` (Single).
- 5 roles seeded via `after_install`: `Rider`, `Driver`,
  `Verified Driver`, `Rideshare Admin`, `Support Agent`.
- 24 major Indian cities seeded with lat/lng for autocomplete.
- Public website (BlaBlaCar-inspired theme):
  `/` (search hero), `/login`, `/signup`, `/rides` (results),
  `/rides/<name>` (detail + Leaflet map), `/me`, `/me/trips`,
  `/become-driver`, `/publish`, `/u/<username>`.
- Whitelisted API: `auth.*`, `onboarding.*`, `rides.*`, `search.*`,
  `bookings.*`, `payments.*` — all guarded by Frappe's role permissions.
- Payment gateway abstraction: `DemoGateway` (auto-success, default),
  `DummyGateway`, with a Razorpay slot ready to plug in.
- Utility libraries (full unit tests):
  - `utils/money.py` — paise <-> rupees + platform-fee split.
  - `utils/geo.py` — haversine, bbox, ETA estimate.
  - `utils/encryption.py` — PII encrypt/decrypt + masking.
  - `utils/notifications.py` — SMS provider abstraction.
  - `utils/payments.py` — gateway abstraction.
- Scheduler stubs in `hooks.py` (escrow release, pending-booking expiry).
- 33 passing tests including a full end-to-end marketplace flow.

## Install

```bash
bench get-app rideshare /path/to/this/app   # or symlink in `apps/`
bench --site <site> install-app rideshare
bench --site <site> migrate
```

## Run tests

```bash
bench --site <site> run-tests --app rideshare
```

## Module map

| Module                       | Folder                          | DocTypes (planned)                 |
|------------------------------|---------------------------------|------------------------------------|
| Rideshare Core               | `rideshare_core/`               | Driver Profile, Vehicle, Vehicle Photo, City |
| Rideshare Marketplace        | `rideshare_marketplace/`        | Ride, Ride Waypoint, Booking, Cancellation Log |
| Rideshare Payments           | `rideshare_payments/`           | Payment Transaction, Rideshare Settings (Single) |
| Rideshare Trust And Safety   | `rideshare_trust_and_safety/`   | Dispute, Message Thread, Message |
| Rideshare Reviews            | `rideshare_reviews/`            | Review |

## Conventions

- Money in **paise (int)** in DB; render via `rideshare.utils.money.format_paise`.
- PII via `Password` field type + `rideshare.utils.encryption`.
- Background work via `frappe.enqueue` (never block requests).
- Whitelisted methods only; `allow_guest` only on documented endpoints.
- Tests cover happy + ≥1 failure path.

## License

MIT — see `license.txt`.
