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
