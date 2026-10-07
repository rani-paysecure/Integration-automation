# PGS behaviour relevant to testing

Read from the PGS backend (`org.pgs`, local copy) on 2026-09-30 and checked against test4 where marked
**(test4 ✓)**. Paths are relative to `src/main/java/org/pgs/`. Used as context by the AI test-case
generator and the `generate-test-cases` skill – keep it short and factual.

## 1. Create purchase – `POST /api/v1/purchases`

Flow: `controller/APIController.createPurchase` → `service/PurchaseService.createPurchase` (line ~4140)
→ `checkMandatoryParameter` (line ~12348) → … → `commongateway/Main.createPayload` at payment time.

| Rule                                                              | Error (HTTP 400 unless noted)                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body is not valid JSON                                            | `invalid_json` – "Request Body Not Found/MalFormed"                                                                                                                 |
| `Host` header not an allowed API host                             | `invalid_host_header`                                                                                                                                               |
| Authorization header missing / wrong key                          | 401 `authentication_failed` ("Authorization header missing" / "Incorrect secret_key")                                                                               |
| Content type not JSON                                             | 415 `unsupported_media_type`                                                                                                                                        |
| Request IP not whitelisted (merchant setting)                     | 401 `IP_not_whitelisted`                                                                                                                                            |
| `Authorization: Bearer <key>##<METHOD>`                           | the part after `##` **overrides `paymentMethod`**                                                                                                                   |
| Payment method not allowed for the merchant                       | `payment_method_not_allowed`                                                                                                                                        |
| `brand_id` blank                                                  | `parameter_missing` – "brand_id is missing"                                                                                                                         |
| `success_redirect` / `failure_redirect` blank                     | `parameter_missing`                                                                                                                                                 |
| `purchase` missing                                                | `parameter_missing` – "purchase detail are missing"                                                                                                                 |
| `purchase.products[0].name` / `.price` missing                    | `transaction_error`                                                                                                                                                 |
| `purchase.expireInMin` not an integer > 0                         | `transaction_error` – but `"0"` is **accepted** (test4 ✓, bug)                                                                                                      |
| `client.country` blank or not a valid **upper-case** alpha-2 code | `transaction_error` ("at" rejected, test4 ✓)                                                                                                                        |
| `client.stateCode` blank                                          | auto-set to `NA` for EUR / GBP (test4 ✓); otherwise "Please pass Valid State Code"                                                                                  |
| `client.street_address`, `client.city`, `client.zip_code` blank   | `transaction_error` ("Please pass valid …") – only blank is checked, no format                                                                                      |
| `client.email` blank                                              | `parameter_missing` – "client.email is missing"                                                                                                                     |
| `client.email` format                                             | regex `^[_A-Za-z0-9-\+]+(\.[_A-Za-z0-9-]+)*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(\.[A-Za-z]{2,})$` → no `'`, `!`, one-letter TLD rejected (test4 ✓)                      |
| `client.date_of_birth`                                            | checked with `SimpleDateFormat("yyyy-mm-dd")` – **`mm` = minutes**: `1990-13-01`, `1990-02-30`, `1990-59-01` are **accepted**, `1990-60-01` rejected (test4 ✓, bug) |
| `client.full_name` / `client.phone`                               | only required for some payment methods / flows (commented-out blocks for others)                                                                                    |
| Currency blank / not allowed / no limits set                      | `transaction_error` ("Currency is required", "Currency X is Not Allowed", "Total Min/max amount is not set …")                                                      |
| Amount below / above merchant min / max                           | `transaction_error` ("must be equal or greater to minimum …" / "must not be greater to maximum …")                                                                  |
| `amountUnit: "minor"` with a decimal price                        | should be "Decimal Price is Not Allowed" – `1000.5` is **accepted and truncated to 10.00** (test4 ✓, bug)                                                           |
| `purchase.total`                                                  | **recomputed** as the sum of `products[].price` (`PurchaseDetails.updateTotal`) – `total: 1, price: 10` → 10; two products 10 + 5 → 15 (test4 ✓)                    |
| `status` sent in the request                                      | ignored (status stays CREATED)                                                                                                                                      |
| Duplicate `merchantRef`                                           | `transaction_error` – "Duplicate merchantRef Found!"                                                                                                                |
| Customer email blocked / customer or group limits breached        | `transaction_error`                                                                                                                                                 |

### Payment-method fields – `extraParam`, `upiId`, `invoiceNo` … (confirmed on test4)

- `extraParam` is a free-form object (`Purchase.extraParam: Map<String,Object>`); other method-specific
  fields (`upiId`, `invoiceNo` …) are plain top-level fields. Keys differ per payment method – the
  dashboard's Payment Methods page lists them: `mandatoryParams` (customer / top-level fields),
  `extraMandatoryParams` (extraParam group 1) and `extraMandatoryParams2` (group 2). A per-country
  override (`PaymentMethodCountryExtraMandatoryParam`, by the customer's country) wins when present.
- Create (`POST /api/v1/purchases/`) **stores them as sent and does not validate them**: missing, empty,
  `null`, wrong format, numbers, 256 characters and unknown keys → 202 (the cashier / PSP asks or
  checks later). `extraParam` that is not an object (text, list) → 400 `invalid_json`
  "Request Body Not Found/MalFormed".
- Non-card methods without user input (`user_input_required` = 0): keys from **both** groups →
  400 `transaction_error` "Only one is allowed, Extra Mandatory Param group 1 or group 2"
  (`PurchaseService` → `MandatoryParameter.isValidExtraMandatoryConfigPurchase`; any key of each group
  counts, even with an empty value). With all required parameters present such a purchase skips the
  cashier and goes straight to payment.
- A payment method the merchant does not allow → 400 `payment_method_not_allowed` (cases for it are skipped).

## 2. Bank field regexes – `client/validation/ClientDetailsValidator.validate`

Run at payment time (`commongateway/Main.createPayload` and 17 other integrations: WorldPayDirect,
PayUPayIn, Payplay, Slyse, Fyst, A55 (4), A55RecurringMandate, Waverlite (2), Paramount Interac (2),
CommonPayout, RecurringCommonPayin, ApprovelyPayOut). **Banks on other integration classes ignore
their Field Regex rules.** Rules come from Mongo `bank_client_details_rule` (dashboard →
PaymentBankJsonData → Field Regex).

- Rule shapes: flat regex · `["IN","US","default"]` (per-country regex from
  `src/main/resources/country-validation-regex.json`, copied to `config/pgs/`) ·
  `{"enable":[…],"default":"^…$"}` (bank's own fallback).
- Match = Java `String.matches` (whole value). `null`, `"NA"`, no usable regex, malformed regex →
  **invalid**.
- Catalog phone rules first **repair** the number to `+<cc><digits>` (e.g. `9876543210` for IN →
  `+919876543210`, `+92…` → `+91…`); unrepairable → invalid.
- Invalid values are **replaced**, not rejected: from `bank_client_random_data` for the customer's
  country. `full_name` is rebuilt per part – first / last name from the customer, else the
  cardholder name, else the pool; the **middle name is copied without validation** (possible bug:
  an invalid middle part can still reach the PSP).
- If the pool has no row for the customer's country, invalid values go to the PSP **unchanged**
  (only a log warning).
- Unknown field names in a rule are ignored.
- Implemented for tests in `config/pgs/pgs-rules.js`.

## 3. Cashier → PGS device data – `POST /npv/<purchaseId>/`

Query parameters read by `Purchase.setUserInfo`: `sh`/`sw` (screen height/width), `ije` (Java),
`cd`/`pd` (colour/pixel depth), `rf`, `os`, `uo` (timezone offset), `fp` (fingerprint), `did`; plus
headers `accept`, `accept-language`, `user-agent`. Forwarded to PSPs that need 3DS browser data.

## 4. Payment amount

`Main.createPayload` sends `purchase.total` converted to the MID currency (`App.getConvertedAmount`).
The Paysafe sandbox declines 2.00 by design; 10.00 is approved.

## 5. PSP logs, webhooks and refunds – `commongateway/Main`, `PurchaseService.callWebhook`, `RefundService`

- `Main.createPayload`: transaction call → `bankTransaction.paymentInfo`, refund call → `cancelInfo`,
  other calls → `allOtherRequest`; responses → `response`. All masked with
  `ValueMasker.maskValues(keysToMask)` → `"***"`. Default keys: cvv, number, expiry_month,
  expiry_year, card_exp_month, card_exp_year, card_cvv, card_number (per PSP config can add more –
  Paysafe masks cardNum, cvv, cardExpiry, email, phone). Confirmed on test4 (Paysafe payfac):
  `card.holderName` stays in clear in request and responses.
- Merchant webhook (`/admin/getWebhookResponse?pid`): paid/partial_paid/over_paid → `success_callback`;
  error/expired → `failure_callback`; refunded/partial_refunded → only the dashboard webhook of type
  "payment refund". `callStatus` = `Successful` / `Fail-<http>` / `Error` / `Error-Processing`.
- PSP webhooks (`/admin/pspWebhookLog/data?search=`): status `consumed` / `Already_Consumed` /
  `zombied`; headers and body contain signatures – never logged by the framework.
- Refund `POST /api/v1/purchases/{pid}/refund {amount, reason, captureId?}` – `amount` and `reason`
  are mandatory ("amount is required", "reason for refund is required"). amount = total → full
  refund path; otherwise RefundService.partialRefundPurchase: amount ≤ 0 → "Refund amount must be
  greater than zero."; REFUNDED → "This Purchase was already fully refunded."; above refundable →
  `invalid_amount` "Refund amount exceeds refundable amount: x"; REFUND_IN_PROCESS → "Previous Refund
  Request already in Process"; not paid → "Only Purchases with `status == (paid) or (partial_paid)`
  can be refunded."; `refund_upto` passed → "Max Time for Refund was elapsed.". A RefundHistory entry
  is always added; success → 202 + entry, status history "<status> amt: x", webhook; PSP failure →
  400 "Refund can not be initiated .Please contact Administrator.", entry ERROR, "refund_failed amt: x".
- test4 Paysafe: refund right after payment → PSP 3406 "The settlement you are attempting to refund
  has not been batched yet" (cancelInfo = `{amount: 300, merchantRefNum: <refundId>}`).

- **Bug (confirmed on test4, RC-004):** a non-numeric refund amount (`{"amount":"abc","reason":"…"}`)
  answers **HTTP 500** `{"message":"something went wrong","code":"exception"}` instead of a 400
  validation error.
- Refunds on Paysafe can stay `refund_in_process` for a long time (PSP accepted, no confirmation yet);
  while one is pending every further refund answers 400 "Previous Refund Request already in Process".

## 6. KYC – `service/kyc/controller/KycController`, `KycOrchestrationService`

Endpoints (environment root, not `/api`): `POST /kyc/create`, `GET /kyc/{kycId}`,
`GET /kyc/redirect/{kycId}` (hosted page, no auth – the kycId is the capability),
`GET|POST /kyc/return/{kycId}`, `POST /kyc/webhook/{provider}` (unauthenticated, HMAC-SHA256 over the
raw body in `x-payload-digest`), legacy `GET /api/v1/customer/{id}/kyc` (202, ApiError, camelCase customer).

- Headers: `Authorization: Bearer <merchant key>` (no prefix / unknown key → 401 `authentication_failed`)
  and `Brand-Id` (missing / not owned → 403 `access_denied`). The legacy customer API reads `brandid`.
- Merchant without a KYC provider MID (Dashboard → Merchant → KYC configuration) → 403 `kyc_not_enabled`.
- Create body is snake_case, unknown fields are ignored. Guard order in `findOrCreate`: product
  (defaulted) → blank `country` → 400 `country_required` → neither `customer_id` nor `merchant_cust_id`
  → 400 `customer_required` ("Provide either 'customer_id' or 'merchant_cust_id'.") → routing → unknown
  customer → 404 `customer_not_found` (message echoes the field that was sent).
- Personal data comes from the stored customer (`POST /api/v1/customer`, 202; `fullName` required).
- An in-flight record (CREATED, AWAITING_USER, KYC_PENDING, KYC_IN_PROCESS, MANUAL_REVIEW) is reused –
  same kyc_id, provider_reference_id and link; `created_at` / the expiry deadline do not move.
  `test` is part of the record identity. KYC_REJECTED → 409 `already_decided`; terminal → `record_terminal`;
  RESUBMISSION_REQUIRED → a new kyc_id.
- `link_ttl_minutes` ≤ 0 → default `kyc.redirect.ttlMinutes` (30); capped at 1440. Default product `kyc.product.default` (IDV); record expiry default 1440 min. `kyc_expiry_in_minutes` anchors the
  poll deadline to `created_at`; expiry needs `kyc.poll.enabled=true` (test profile only).
- Opening the link: AWAITING_USER → KYC_PENDING, `verification_url_opened_at` stamped once (absent, not
  null, until then). Expired link → 302 to `failure_redirect`.
- Return: verdict re-fetched from the provider; query string ignored (a forged `status=KYC_APPROVED`
  still lands on `pending_redirect`). **Bug (still in code):** with no redirect configured,
  `returnFromProvider` builds `Map.of("kycId", …, "status", …, "status", …)` – duplicate key → 500
  instead of 200 (test KYC-25 is `test.fail()` until fixed).
- Merchant callbacks (`KycCallbackService.targetUrl`): KYC_APPROVED → success_callback; KYC_IN_PROCESS,
  MANUAL_REVIEW → pending_callback; everything else (incl. RESUBMISSION_REQUIRED) → failure_callback.
- Errors: every `/kyc/*` failure is `{status:"fail", code, message}` (KycExceptionHandler).
- Confirmed on test4 (Sumsub sandbox): a customer created **without `phoneNo`** → `POST /kyc/create`
  answers HTTP 200 with status `KYC_FAILED`, message "Input list cannot be null." (the provider config
  cannot build the applicant) – the customer API accepts the customer, so the failure only shows at KYC.

## 7. Bank / MID / merchant settings – `InitiateAction`, refund (`CANCEL_PAYMENT`)

Read: `GET /admin/getAllActivePaymentBanks` (bank; also holds credentials – read only whitelisted fields),
`GET /admin/v2/getAllPaymentBankMIDList?pp_id=` (MIDs), `GET /admin/getMerchant?m_id=` (page with the
merchant JSON). Write: `POST /admin/setPaymentBankMID` (the MID edit form; `updateMid` rewrites **every**
column, so all fields must be re-posted, and it always stores `is_test_data=false`),
`POST /admin/updateCheckWhiteList {mid, flag, type:"conversionallowed"}` (merchant switch).

- **Refund window:** bank `max_refund_days` > 0 → `refund_upto` = success time + N days − 1 h and
  `refundable_amount` = total; ≤ 0 → both 0. Confirmed on test4: paysafe_payfac (180 days) →
  refund_upto = paid + 15 548 400 s (± a few seconds).
- **2D only (`onlyTwoD`):** 1 → bank record `authStatus` "Direct2D", purchase `twoDPayment` YES
  (not returned by `/trans/getAllTrans`, and `authStatus` is not kept on the stored bank record). paysafe_payfac
  (commongateway) sends the same request either way, incl. `threeDs`; with 2D only = 1 Paysafe answered
  5068 "Payment handle provided is not permitted for Payments because of its state" in one of two runs. Merchant `trxType` 3D + MID 2D only → MID_IS_NOT_3D; a 2D
  request (S2S) on a MID with 2D only = 0 → MID_IS_NOT_2D.
- **Partial refund:** MID `partial_refund_allowed` ≠ 1 and amount < remaining → 400
  `payment_can_not_be_refunded` "PaymentBankMID does not allow partial refund with authkey = … , mid=…"
  – **the message contains the MID auth key**; the refund API answers only
  `{"message":"payment_can_not_be_refunded","code":"payment_can_not_be_refunded"}` (confirmed on test4).
- **Conversion:** MID `curr_convert_to` set and ≠ purchase currency: merchant `conversionAllowed` = 0 →
  MID skipped (CONVERSION_NOT_ALLOWED, `no_mid_found`, "This customer can not be processed !");
  = 1 → amount converted, `fx_Currency` / `fx_Amount` on the purchase, bank record currency = convert-to.
- **Allowed currency / card:** a MID (or bank) whose `allowed_curr` / `allowed_card` does not include the
  purchase currency / card scheme is skipped; with no other eligible MID the purchase fails.
- **Caching:** routing loads MIDs via `MISCDaoimpl.getAllLiveMid` / `getAllActiveMid`, cached in Redis for
  5 minutes (`cacheALM8:…`), not invalidated by `setPaymentBankMID`. A MID change reaches routing up to
  5 minutes late. Refunds (`getMIDBy_AUTHMID`) and the merchant profile are read from the database.

## 8. S2S card payment – `APIController.s2s` → `PurchaseService.s2s` (confirmed on test4)

> **Scope:** S2S is only for executing **card payments** through the API. It has no other purpose – no APMs, refunds or KYC.

`POST /api/v1/p/{purchaseId}/?s2s=true`, body `S2s`: cardholder_name, card_number, expires (MM/YY),
cvc, remember_card, remote_ip, user_agent, accept_header (the last three `@NotNull`), language,
java_enabled, javascript_enabled, color_depth, utc_offset, screen_width / screen_height.

- Order of checks: Bearer key (401 `authentication_failed` "Authorization header missing", also for a
  key without "Bearer ") → Content-Type json (415 `unsupported_media_type`) → purchase found (400
  "PurchaseId Not found.") → status CREATED / OVERDUE (else 400 "Only purchases that can be paid for can
  be initiated for payment.") → remote_ip ≠ caller IP → card checks → payment method allowed → expiry.
- Missing remote_ip / user_agent / accept_header → 400 `Invalid_Parameter` "<field> cannot be null";
  malformed JSON → 400 `invalid_json`. These, auth and the Luhn check ("Invalid card Number (Luhn
  algo)", also for letters) leave the purchase **CREATED**.
- Missing cvc / cardholder_name / expires / remember_card → 400 "Card Detail is missing"; expiry
  without "/" or in the past → 400 "Invalid Card Expiry(Valid Format:MM/YY) …"; a card the cashier
  rejects (4111…) → 400 "Invalid card details". These end the purchase as **ERROR**.
- **Bugs:** missing `card_number` → HTTP 500 "something went wrong" (exception) and the purchase is no
  longer payable; expiry month `13/31` is accepted (202) and the payment starts.
- The payment method is taken from the card's scheme: a card sent for an APM purchase (e.g.
  BANKTRANSFER) → 400 "Payment Method VISA is not Allowed!". No S2S for APMs.
- Success, merchant trxType ALL / 3D → 202 `{status:"pending", method:"GET",
callback_url:"<checkout host>/api/v1/payment/<purchaseId>/"}`, purchase PENDINGEXECUTE; opening the
  callback runs the payment (3DS page or merchant redirect). A second S2S call → 400 "Only purchases
  that can be paid for …".
- trxType 2D → PGS pays inside the call (`self.payment`), polls up to 20 s and answers 202 with the
  purchase (`trxType: 2D`, callback "no_need"); the merchant webhook carries the final status.
- `remember_card` on / true → the card is saved for the customer (`updateSavedCard`).
- **Not validated by S2S (accepted with 202, payment starts):** expiry `12/3` (one-digit year) and month
  `00`, CVC with 2 / 5 digits or letters, cardholder_name of 256 characters, remote_ip that is not an IP,
  remember_card values other than on / off, screen 0, unknown language, extra body fields. Rejected:
  expiry MM/YYYY ("Invalid Card Expiry"), empty cardholder_name ("Card Detail is missing", ERROR), spaces
  in the card number (Luhn, still CREATED).

## 9. Session flow – customer → session → hosted cashier

> **Scope:** the session flow executes payments for **cards and APMs**. Today only cards are automated; APM
> configuration will be added to the launcher's Session data tab later.

1. Create customer (`POST /v1/customer`, unique `merchantCustomerId`) – or reuse an existing `customerId`.
2. Create session (`POST /v1/createSession`) – the answer carries the URL of the hosted cashier
   (`sessionUrl` in today's response) and the `sessionId`.
3. That URL opens the **cashier**: it shows the order / payment details, the customer chooses the payment method
   (card or APM) and clicks **Pay** – then the respective PSP flow runs (3DS for cards, the APM's own pages for APMs).
4. The transaction is found in the back-office by `sessionId` → `purchaseId` → status, PSP request / response, webhooks.
