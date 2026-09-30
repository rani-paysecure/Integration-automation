# KYC test cases

Manual test cases for the PaySecure KYC flow. Each one names the automated spec that
covers it, so you can run the suite instead where that is quicker.

Environment: `https://test4.paymentsclub.net`
Automated suite: `tests/flows/kyc/` in this project — launcher → Run → **KYC verification**, or `npm run test:kyc`

## Before you start

• The merchant must have a KYC provider MID configured on the dashboard. Without it every create returns `403 kyc_not_enabled` and nothing else is testable.
• Every request needs two headers: `Authorization: Bearer <merchant key>` and `Brand-Id`.
• Send `"test": true` on every create so your records never mix with live ones.
• The customer must already exist. Create one with `POST /api/v1/customer` first.
• Expiry cases only work where `kyc.poll.enabled=true`. It is set on the `test` profile and nowhere else.

---

# Group 1 — Starting a verification

## KYC-01 — A new customer gets a verification link

_Spec: tests/flows/kyc/01-happy-path_

Preconditions: a customer that has never been verified.

Steps:

1. `POST /kyc/create` with `customer_id` and `country`.

Expected:
• `200`
• `status` is `AWAITING_USER`
• `verification_url` contains `/kyc/redirect/` and points at **our** domain, never the provider's
• `provider_reference_id` is populated
• `decision_reasons` is `null`
• `status_history` is exactly `CREATED` then `AWAITING_USER`, in that order

## KYC-02 — You do not send personal details

_Spec: tests/flows/kyc/01-happy-path_

Preconditions: a customer with name, email, date of birth and address stored.

Steps:

1. `POST /kyc/create` with only `customer_id`, `country` and `test`.

Expected:
• `200` and a working link. Name, email, DOB and address are read from the stored customer, not from the request. Sending them has no effect.

## KYC-03 — Unknown fields are ignored, not rejected

_Spec: tests/flows/kyc/04-errors_

Steps:

1. `POST /kyc/create` including `product`, `provider` and any invented field.

Expected:
• `200`. Retired fields must not start rejecting a merchant's requests. `product` is the real case — it used to exist and no longer does.

## KYC-04 — Either customer id works

_Spec: tests/flows/kyc/02-reuse_

Steps:

1. Create with `customer_id`.
2. Create with `merchant_cust_id` for the same person.

Expected:
• Both return the same `kyc_id`
• The record carries both ids back, whichever one you sent

---

# Group 2 — Retrying and reuse

## KYC-05 — A repeat create returns the same verification

_Spec: tests/flows/kyc/02-reuse_

Steps:

1. `POST /kyc/create`.
2. `POST /kyc/create` again, same customer, same body.

Expected:
• Identical `kyc_id`, `provider_reference_id` and `verification_url`
• No second applicant at the provider — check the Sumsub dashboard: one applicant for this customer

## KYC-06 — A double-click does not create two verifications

_Spec: tests/flows/kyc/02-reuse_

Steps:

1. Fire two creates for the same customer at the same moment.

Expected:
• Both return `200` with the same `kyc_id`
• `GET /api/v1/customer/{id}/kyc` shows exactly one record

## KYC-07 — Re-posting create cannot hold a record open forever

_Spec: tests/flows/kyc/03-guards (@slow)_

Steps:

1. Create with `kyc_expiry_in_minutes: 1`.
2. Keep re-posting create every 15 seconds for 3 minutes.

Expected:
• The record still expires. The deadline is anchored to `created_at`, not to the latest call.

---

# Group 3 — Validation and errors

Every failure uses the same envelope: `{"status": "fail", "code": ..., "message": ...}`

## KYC-08 — Guard order: country before customer

_Spec: tests/flows/kyc/04-errors_

Steps:

1. `POST /kyc/create` with an empty body `{}`.

Expected:
• `400` with code `country_required` — **not** `customer_required`. Country is validated first.

## KYC-09 — Missing customer id

_Spec: tests/flows/kyc/04-errors_

Steps:

1. `POST /kyc/create` with only `country`.

Expected:
• `400` `customer_required`, and the message names both `customer_id` and `merchant_cust_id`

## KYC-10 — Unknown customer

_Spec: tests/flows/kyc/04-errors_

Steps:

1. Create with a `merchant_cust_id` that does not exist.

Expected:
• `404` `customer_not_found`, and the message echoes the field you sent and its value

## KYC-11 — Authentication

_Spec: tests/flows/kyc/04-errors_

Run each and check the code:
• No `Authorization` header → `401` `authentication_failed`
• The key without the `Bearer ` prefix → `401` `authentication_failed`
• A made-up key → `401` `authentication_failed`
• Valid key, no `Brand-Id` → `403` `access_denied`
• Valid key, a brand the merchant does not own → `403` `access_denied`

## KYC-12 — Unknown verification id

_Spec: tests/flows/kyc/04-errors_

Steps:

1. `GET /kyc/KYC00000000000000000000000000000000`

Expected:
• `404` `record_not_found`

---

# Group 4 — Reading status

## KYC-13 — Status returns the same shape as create

_Spec: tests/flows/kyc/05-status-read_

Expected:
• Identical keys to the create response, including `status_history`
• `product` is present even though you never sent it

## KYC-14 — "Never opened" is distinguishable from "opened and abandoned"

_Spec: tests/flows/kyc/05-status-read, 07-hosted-page_

Steps:

1. Create. Read the record without opening the link.
2. Open the link. Read it again.

Expected:
• Before: `verification_url_opened_at` is **absent from the JSON entirely** — not `null`
• After: it is present, and the status has moved to `KYC_PENDING`

## KYC-15 — Another merchant cannot read your verification

_Spec: tests/flows/kyc/05-status-read (needs a second merchant key)_

Steps:

1. Create as merchant A.
2. `GET /kyc/{id}` as merchant B.

Expected:
• `404`, not `403`. A `403` would confirm the id exists.

## KYC-16 — Customer history

_Spec: tests/flows/kyc/06-customer-history_

Steps:

1. `GET /api/v1/customer/{id}/kyc`

Expected:
• **`202`, not `200`** — this endpoint is on the legacy controller
• Body is `{ "customer": {...}, "kyc": [...] }`
• The customer object is camelCase; the kyc array is snake_case
• A customer with no verifications returns `"kyc": []`, **not** a `404`

## KYC-17 — The status filter

_Spec: tests/flows/kyc/06-customer-history_

Steps:

1. `?status=kyc_approved` — lower case
2. `?status=KYC_APPROVED,KYC_REJECTED` — a list
3. `?status=NOT_A_STATUS`

Expected:
• Case-insensitive, comma-separated both work
• An unknown value is `400` `invalid_status`, and the message lists every allowed value — it is **not** an empty list. A typo must not read as "this person has no approved verifications".

## KYC-18 — Errors here look different

_Spec: tests/flows/kyc/06-customer-history_

Steps:

1. Call `/api/v1/customer/{id}/kyc` with no auth header.

Expected:
• `401` with `{"code": ..., "message": ...}` — **no `"status": "fail"` wrapper**. Different shape from `/kyc/*`. Frontend code branching on `body.status` will misread this.

---

# Group 5 — The hosted page

## KYC-19 — Opening the link

_Spec: tests/flows/kyc/07-hosted-page_

Steps:

1. Open `verification_url` in a browser, as a full page.

Expected:
• `200`, the provider's capture UI renders
• `Cache-Control: no-store`
• The record moves `AWAITING_USER` → `KYC_PENDING`
• It must be a top-level page, not an iframe — the camera is blocked in a cross-origin frame

## KYC-20 — The open stamp is set once

_Spec: tests/flows/kyc/07-hosted-page_

Steps:

1. Open the link. Note `verification_url_opened_at`.
2. Reload twice. Read the record again.

Expected:
• The timestamp is unchanged. It answers "when did they first arrive".

## KYC-21 — Mid-flow reload does not eject the subject

_Spec: tests/flows/kyc/07-hosted-page_

Steps:

1. Open the link, start the flow, then hit refresh or the back button.

Expected:
• The page still renders. `KYC_PENDING` keeps serving the capture UI — it must not bounce to the merchant's page and strand a half-finished verification.

## KYC-22 — A finished verification stops relaunching

_Spec: tests/flows/kyc/07-hosted-page (@slow), 10-poller-expiry_

Steps:

1. Take a record that has expired or reached a verdict.
2. Open its `verification_url`.

Expected:
• `302` to the merchant URL for that status, not the capture UI
• With no redirect URL configured at all: `409` `redirect_unavailable`

---

# Group 6 — Coming back

## KYC-23 — Where the subject lands

_Spec: tests/flows/kyc/08-return_

Send them through `/kyc/return/{kyc_id}` and check the `Location`:
• `KYC_APPROVED` → `success_redirect`, falling back to `pending_redirect`
• `KYC_REJECTED`, `KYC_FAILED`, `KYC_EXPIRED` → `failure_redirect`, falling back to `pending_redirect`
• Anything still open, **and `RESUBMISSION_REQUIRED`** → `pending_redirect`, falling back to `success_redirect`

## KYC-24 — The query string decides nothing

_Spec: tests/flows/kyc/08-return_

Steps:

1. Call `/kyc/return/{kyc_id}?status=KYC_APPROVED&reviewAnswer=GREEN`

Expected:
• Still redirects to pending. The verdict is re-fetched from the provider; the URL is only used for correlation. A subject cannot approve themselves by editing it.

## KYC-25 — Return with no redirect configured — KNOWN DEFECT

_Spec: tests/flows/kyc/08-return, marked as an expected failure_

Steps:

1. Create with no `success_redirect`, `pending_redirect` or `failure_redirect`.
2. Call `/kyc/return/{kyc_id}`.

Expected (correct behaviour): `200` with `{kycId, status}` — the verification is fine, there is just nowhere to send the browser.
Actual today: **`500 internal_error`.** `Map.of` is built with a duplicated `"status"` key and throws. Raised with the backend; do not file again.

---

# Group 7 — Webhooks

## KYC-26 — A forged webhook changes nothing

_Spec: tests/flows/kyc/09-webhook_

Steps:

1. Take a real verification's `provider_reference_id`.
2. POST an `applicantReviewed` / GREEN event to `/kyc/webhook/{provider}` with a wrong `x-payload-digest`.

Expected:
• `401` `signature_mismatch`
• The record's status and `decision_reasons` are **unchanged**. This is the important half.

## KYC-27 — An event that matches nothing

_Spec: tests/flows/kyc/09-webhook_

• No `applicantId` and no `kycId` → `400` `correlation_failed`
• An `applicantId` we do not hold → `404` `record_not_found`. It must not be silently accepted.

## KYC-28 — A re-fired webhook is applied once

_Spec: tests/flows/kyc/09-webhook_

Steps:

1. Send a correctly signed event. Note `status_history`.
2. Send the identical event again within 30 minutes.

Expected:
• Both return `200`
• `status_history` does not grow on the second

---

# Group 8 — Expiry

Needs `kyc.poll.enabled=true` on the target.

## KYC-29 — A link nobody opened

_Spec: tests/flows/kyc/10-poller-expiry (@slow)_

Steps:

1. Create with `kyc_expiry_in_minutes: 1`. Do not open the link.
2. Wait up to 3 minutes, re-reading the status.

Expected:
• `KYC_EXPIRED`, with a message saying the link was never opened
• `verification_url_opened_at` still absent

## KYC-30 — Opened and abandoned

_Spec: tests/flows/kyc/10-poller-expiry (@slow)_

Steps:

1. Create with `kyc_expiry_in_minutes: 1`. Open the link, then walk away.
2. Wait.

Expected:
• `KYC_EXPIRED`, with a **different** message — about no verdict being reached
• The open stamp survives, so you can tell abandonment from an undelivered link

---

# Group 9 — Callbacks

These go to the merchant's server, not the browser.

## KYC-31 — Routing

_Spec: tests/flows/kyc/11-callbacks (partly automated)_

• `KYC_APPROVED` → `success_callback`
• `KYC_IN_PROCESS`, `MANUAL_REVIEW` → `pending_callback`
• Everything else, **including `RESUBMISSION_REQUIRED`** → `failure_callback`

Note the asymmetry: `RESUBMISSION_REQUIRED` sends the **browser** to the pending redirect but the **callback** to the failure URL. Most likely thing for an integrator to get wrong.

## KYC-32 — The payload

_Spec: tests/flows/kyc/11-callbacks_

Expected keys, all **camelCase** unlike the REST responses: `kycId`, `customerId`, `merchantCustId`, `product`, `country`, `status`, `decisionReasons`, `message`, `test`, `createdAt`, `updatedAt`, `attempt`.

## KYC-33 — No callback URL is silence, not an error

_Spec: tests/flows/kyc/11-callbacks_

Steps:

1. Create with no callback URLs and let it reach a verdict.

Expected:
• Nothing is sent, nothing is queued, and the verification is unaffected.

---

# Group 10 — Provider flow

## KYC-34 — Full journey through the Sumsub SDK

_Spec: tests/flows/kyc/12-sumsub-sdk — automated as far as liveness_

The flow, as verified against the live sandbox:

1. "Verification for approvely.com" → **Continue**
2. "Consent to start verification" → **Agree and continue**
3. "Let's get you verified" → **turn OFF "Get verified faster with Sumsub ID"** → **Start verification**
4. "Select type and issuing country" → issuing country is prefilled → pick **Passport** → **Continue**
5. "Upload your document" → upload → SDK advances to **"Get your camera ready"**
6. Liveness check → **needs a real person and a real camera**

Expected:
• The record is `KYC_PENDING` from the moment the link is opened
• `provider_reference_id` is unchanged throughout
• The issuing country is prefilled from the country on the record
• After liveness, the record leaves `KYC_PENDING` without anyone calling create again

Record the customer id this produces — KYC-35 and the callback cases need a customer already in a verdict state.

## KYC-34a — The Sumsub ID email gate ⚠️ PRODUCT DECISION

_Spec: tests/flows/kyc/12-sumsub-sdk turns it off; nothing tests it on_

"Get verified faster with Sumsub ID" is a switch on step 3 and it is **ON by default**.

Leave it on and the subject goes to **"Verify your email to use Sumsub ID"** and must
enter a six-digit code emailed to them — _before_ document capture starts. The email
itself is correctly prefilled from the stored customer, so this is not a missing-data
problem; it is an extra verification step Sumsub adds on top of ours.

Steps:

1. Open the link, Continue, Agree and continue.
2. Leave the Sumsub ID switch alone.
3. **Expected today:** an email-code screen with a 60-second resend timer.

Worth a decision: every real subject hits this unless Sumsub ID is disabled on the
verification level in Cockpit.

## KYC-35 — Guards on a decided verification

_Not automated — needs KYC-34 run to each verdict first_

• `KYC_IN_PROCESS` or `MANUAL_REVIEW`: create returns the record as-is, with no provider call
• `KYC_APPROVED`: create re-asks the provider and returns whatever they say now
• `KYC_REJECTED`: `409` `already_decided` — retry is blocked, reopening is an operator decision
• `RESUBMISSION_REQUIRED`: create opens a **new** verification with a new `kyc_id`

---

# Known gaps

Not covered by anything above, so nobody reads a green run as complete:

• **The 30-second inquiry throttle** — invisible from outside; the response is identical whether or not the provider was re-asked. Check the logs.
• **`customer_ambiguous`** — needs the same `merchant_cust_id` under two brands.
• **Newest-first ordering on customer history** — needs two records for one customer, which needs one settled first.
• **`KYC_CANCELLED`** — unreachable. No endpoint, no operator path, nothing in the code sets it.
• **Callback retry backoff** — 5 attempts at 5-minute intervals is a 25-minute test.

---

# Traceability — case id to automated test

Every automated test is named `KYC-nn · given … when … then …`, so a red test in CI
names its own case. A letter suffix is an extra assertion the parent case implies
but does not spell out (`KYC-11a`…`KYC-11e` are the five authentication checks
listed under KYC-11).

Run one case by its id:

```
docker compose run --rm tests npx playwright test -g "KYC-08"
docker compose run --rm tests npx playwright test -g "KYC-1[0-9]"
```

• **KYC-01, 02, 02a** — 01-happy-path
• **KYC-03, 08, 08a, 09, 10, 10a, 11a–11e, 12, 12a** — 04-errors
• **KYC-04, 04a, 05, 05a, 05b, 06, 07a** — 02-reuse
• **KYC-07, 22a, 35a–35d** — 03-guards
• **KYC-13, 13a–13c, 14a, 15** — 05-status-read
• **KYC-16, 16a–16c, 17, 17a, 18** — 06-customer-history
• **KYC-19, 19a, 19b, 21, 22** — 07-hosted-page
• **KYC-23, 23a, 23b, 24, 25** — 08-return
• **KYC-26, 26a, 26b, 27a, 27b, 28** — 09-webhook
• **KYC-29, 30, 22b** — 10-poller-expiry
• **KYC-31, 31a, 31b, 32, 32a, 33, 33a** — 11-callbacks
• **KYC-34** — 12-sumsub-sdk

**Not separately automated:** KYC-20 (the open stamp being set once) is asserted
inside KYC-19 rather than as its own test — the two share a fixture, and splitting
them would mean opening the link twice for one assertion. KYC-27 and KYC-31/32 are
split into the lettered cases above. KYC-35 exists only as the four `fixme` cases
35a–35d, which need a verdict from a real provider run.
