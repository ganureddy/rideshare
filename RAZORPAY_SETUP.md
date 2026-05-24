# Razorpay setup — step-by-step

End-to-end production setup for the in-app Razorpay payment flow that
ships in this repo. Takes ~15 minutes start-to-finish.

## Prerequisites

- Razorpay account (sign up at [https://dashboard.razorpay.com](https://dashboard.razorpay.com)).
- Your business has been activated in Razorpay (KYC complete) — required for live payments. Test mode works without KYC.
- This repo's chat + bookings stack already deployed.

The implementation is **Razorpay Standard Checkout in a WebView**. We deliberately do **not** use `react-native-razorpay` because it's a bare-RN library that breaks Expo managed builds. The WebView approach uses Razorpay's own hosted checkout page and works cleanly on every Android phone.

## Architecture in one paragraph

When the rider taps **Book a seat**, the mobile app calls `create_booking` (already wired) which creates a Razorpay Order via the official Python SDK. The app then opens a full-screen WebView at `/rideshare/m/checkout?booking=<id>` — this URL renders Razorpay's hosted UPI/Cards/Netbanking checkout. On success Razorpay calls a JS handler that posts the verified `payment_id + signature` back to the React Native host via `window.ReactNativeWebView.postMessage`. The app then calls `confirm_payment` which **server-side** verifies the HMAC signature and marks the booking confirmed. A separate **webhook** endpoint catches edge cases where the user closes the WebView before the success callback fires.

```
RideDetail (RN)        Frappe (rideshare app)         Razorpay
─────────────────      ──────────────────────         ─────────
"Book"  ─────────────► create_booking ─────────────►  POST /orders
                                          ◄────────── { id: order_xxx }
        ◄──────────── { booking, order_id }
WebView /m/checkout ─► Jinja renders ──────────────►  checkout.razorpay.com
                       Razorpay JS SDK                (hosted UPI/cards)
                                          ◄────────── { payment_id, signature }
                       Razorpay JS handler
        ◄──────────── postMessage(success)
confirm_payment ─────► verify_signature ──────────►   (HMAC SHA256)
                       update Booking
        ◄──────────── { Confirmed }

(in parallel)
                       /api/method/.../razorpay_webhook
                                          ◄────────── server-to-server
                                                      payment.captured
                       reconcile booking state
```

## Step 1 — get your Razorpay keys (2 minutes)

1. Sign in to [https://dashboard.razorpay.com](https://dashboard.razorpay.com).
2. Top-right toggle: choose **Test Mode** (do all setup here first, switch to Live after end-to-end smoke tests).
3. Left sidebar → **Settings** → **API Keys**.
4. Click **Generate Test Key**.
5. Copy both:
  - `Key Id` — looks like `rzp_test_AbCdEf12345678`
  - `Key Secret` — long random string. **Shown once** — copy now or you'll have to regenerate.

Live mode (after KYC): the same screen has **Generate Live Key**. Keys start with `rzp_live_…`.

## Step 2 — paste the keys into Frappe (2 minutes)

1. Open Frappe Desk: `https://<your-site>/app/rideshare-settings`.
2. Section **Payments**:
  - **Default Gateway** → change from `demo` to `**razorpay`**.
  - **Razorpay Key ID** → paste `rzp_test_…`.
  - **Razorpay Key Secret** → paste the secret. Frappe will encrypt it on save.
3. Save. (Don't worry about the webhook secret yet — Step 4.)

```bash
# OR via CLI if you prefer not to use the desk:
bench --site <site> set-config -p razorpay_key_id rzp_test_xxx
# Secrets must go via the doctype, not site_config.json — they need
# the Frappe password encryption layer.  Use the desk for the
# secret + webhook secret.
```

## Step 3 — verify the gateway loads (1 minute)

```bash
bench --site <site> console
```

```python
>>> from rideshare.utils.payments import get_gateway
>>> gw = get_gateway()
>>> gw.name
'razorpay'
>>> gw.key_id
'rzp_test_AbCdEf12345678'
>>> # Order creation smoke-test
>>> order = gw.create_order(amount_paise=10000, currency="INR", receipt="BK-TEST")
>>> order.order_id
'order_OqXyZAbCdEfGh'
```

If `gw.name` is still `demo`, you forgot to change `Default Gateway` in step 2.

If `create_order` raises, check the dashboard's **Settings → API Keys** page — the keys must be the same mode as the gateway endpoint (test ↔ test, live ↔ live).

## Step 4 — set up the webhook (5 minutes)

The webhook is the safety net: if the user kills the app mid-checkout, Razorpay's server still pings ours and we reconcile the booking automatically.

1. Razorpay dashboard → **Settings** → **Webhooks** → **Add New Webhook**.
2. **Webhook URL**:
  ```
   https://<your-site>/api/method/rideshare.api.payments.razorpay_webhook
  ```
   (Replace `<your-site>` with `ember.bigdcollections.com` or whatever your production hostname is.)
3. **Webhook Secret**: generate a long random string locally — e.g.
  ```bash
   openssl rand -hex 32
  ```
   Paste it into Razorpay's input field.
4. **Active Events** — tick:
  - ✅ `payment.captured`
  - ✅ `payment.failed`
  - ✅ `refund.processed`
  - ✅ `refund.failed` (optional but useful for ops)
5. Click **Create Webhook**.
6. Open Frappe Desk → **Rideshare Settings** → **Razorpay Webhook Secret** → paste the same string from step 3. Save.

The webhook handler (`rideshare/api/payments.py::razorpay_webhook`) verifies the signature against this secret on every incoming POST. **Different secrets between Razorpay and Frappe = every webhook silently rejected.**

## Step 5 — test mode end-to-end (3 minutes)

1. Build a fresh APK:
  ```bash
   cd /home/frappe/frappe-bench/apps/rideshare/frontend
   eas build --platform android --profile preview
  ```
2. Install on your phone, log in.
3. Open a Published ride, tap **Book a seat**.
4. The Razorpay WebView opens.
5. Pick **UPI** → enter `success@razorpay` (Razorpay's test UPI handle that always succeeds).
  Other test handles:
  - `success@razorpay` → instant success
  - `failure@razorpay` → instant failure
  - For card: use card `4111 1111 1111 1111` with any future expiry + any CVV
6. Confirm. The WebView closes, you see "Booked!" and the booking status flips to **Pending** (or **Confirmed** if `instant_booking` is on for the ride).
7. Cross-check Frappe Desk: `Payment Transaction` list → there's a `Captured` row matching `gateway_payment_id`.
8. Cross-check the webhook: Razorpay dashboard → **Webhooks** → click your webhook → **Recent Deliveries**. You should see one `payment.captured` event with HTTP 200 response.

## Step 6 — go live (when KYC is done)

1. Razorpay dashboard → top-right toggle: switch to **Live Mode**.
2. Generate **Live Keys** the same way (Step 1).
3. Replace the keys in **Rideshare Settings** with the live ones.
4. Add a Live webhook (Step 4) at the same URL with a NEW webhook secret. Paste that secret into Rideshare Settings.
5. Smoke test with **a real ₹1 ride** — Razorpay's KYC sandbox lets you test live keys with real payments before pushing to your full price range.

## Reconciliation & ops

- **Refunds**: cancel a booking → backend already calls `gw.refund(...)` for non-zero refund percentages. Refund shows up as a separate `Payment Transaction` row with `status=Refunded`.
- **Settlements**: Razorpay holds money for 1 day (test) / T+2 (live default), then sweeps to your bank. Configure auto-settlements in **Settings → Banking → Settlements**.
- **Webhook retries**: Razorpay retries failed webhooks 8 times over 24 hours. If your server is down briefly you don't lose events — but check the dashboard's **Recent Deliveries** for any red rows.
- **Audit**: every booking has a `Payment Transaction` trail (Created → Captured → Refunded). Use the Desk list view filtered by `gateway` and `status` to spot anomalies.

## Pricing

- **Standard rate**: 2% on UPI / debit card / wallets, 2% on credit cards. India domestic.
- **Settlement**: Free.
- **Refunds**: Free.
- **No setup fees** as long as you stay under ~₹50 lakh/month — beyond that, Razorpay reaches out for an enterprise plan.

For carpooling at ₹500/seat, that's ~₹10/booking → about 8% of platform fee margin if your platform fee is 12%. Worth it for the conversion lift; native UPI = highest checkout completion in India.

## Troubleshooting


| symptom                                                            | fix                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebView shows blank screen                                         | `Default Gateway` is still `demo`. Change to `razorpay` in Rideshare Settings.                                                                                                                                                                                    |
| WebView shows "Razorpay isn't loaded"                              | `checkout.razorpay.com` blocked by user's network (corporate / institutional WiFi). Fall back to a different network.                                                                                                                                             |
| `create_order` raises `Authentication failed`                      | Test keys used while gateway is `live` (or vice versa). Match modes.                                                                                                                                                                                              |
| Webhook never fires                                                | Check Razorpay dashboard → Webhooks → Recent Deliveries. If empty, the URL is wrong; if 4xx, the secret doesn't match between Razorpay and Settings.                                                                                                              |
| `confirm_payment` 4xx with "Payment signature verification failed" | The mobile app forwarded a stale or corrupted signature. The webhook handler will reconcile on the server side — wait 30 s and refresh.                                                                                                                           |
| User paid, app shows "Payment confirmation failed"                 | Network blip between WebView postback and `confirm_payment`. The webhook handler will reconcile within ~10 s; the booking moves to Confirmed automatically. The user's app picks it up on the next pull-to-refresh or via the realtime `rideshare:booking` event. |


## What to do next

You now have one payment lever. The other Tier 1 features (referrals, recurring rides, SOS, pickup hubs) build on the same patterns — say which one you want to ship next and I'll do it the same way: clean code, scoped change, real docs.

Recommended next step: **referrals**. Tiny scope, biggest acquisition lift, works on top of the wallet table I'd add for cashbacks anyway.