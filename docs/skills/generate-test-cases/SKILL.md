---
name: generate-test-cases
description: Generate Paysecure integration QA test cases (field validation, bank regex validation, PSP request/response, custom & edge cases, KYC, refunds, bank & MID configuration) as an upload-ready Excel file for the Integration-automation launcher. Use when a QA asks to create, suggest or expand test cases for a category, a bank's field regexes, a PSP or a test card.
---

# Generate test cases for the Integration-automation launcher

The project (`Integration-automation`) runs cashier-purchase tests from the launcher. New cases are
added on its **Test cases** tab by uploading a filled template. This skill writes that file.

## 1. Clarify (only if not given)

- **Category**: `field` (request field rules) · `regex` (a bank's field regexes) · `psp` (checks on
  the PSP request/response) · `edge` (end-to-end scenarios with a card and expected outcome) ·
  `kyc` (POST /kyc/create: customer, request changes, auth variant → HTTP, code, KYC status) ·
  `refund` (refund steps on a purchase → HTTP, code, final status) · `s2s` (S2S card payment:
  request changes / auth → HTTP, code, status, browser outcome) · `bank-config` (flip the routed
  MID / merchant settings → pay or refund → routing, status, code, PSP currency).
- **How many**: min and max number of cases (default 10–20; PSP counts test cases, not rows).
- **Environment**: `local` (default) or `uat` – both are test4.
- For `regex`: the **bank** name as in the dashboard (e.g. `paysafe_payfac`, `paywise`).
- For `bank-config`: the **MID** the merchant routes to (Run tab → Routes to, e.g. `paysafe_payfac_mid`).
- Optional focus (e.g. "unicode names", "amount boundaries", "3DS cards").

## 2. Read the template and the context (from the project root)

```bash
npm run -s cases -- spec <category> --env local        # columns, allowed values, card IDs, examples
npm run -s cases -- context <category> --env local [--bank <bank>] [--mid <MID>]   # fields, regexes, live MID settings, cards, existing cases
```

`context` includes the matching part of `docs/pgs-behaviour.md` – how the PGS backend really validates
(read from its code, with confirmed bugs). Prefer cases that probe those rules and bugs.

`context` for `regex` and `bank-config` logs in to the dashboard with the tester's login from `profiles.local.json`
(this computer only). Never print, copy or ask for passwords, API keys or card numbers.

## 3. Write the cases

Rules for every category:

- Fill exactly the template columns (`key` names from `spec`); leave optional columns empty when not needed.
- Mix **positive** (should succeed / be sent unchanged) and **negative** (should be rejected / replaced / fail) cases.
- Do not repeat anything listed under "Existing cases".
- Test data only: `example.com` emails, invented names, 555 / test numbers, card IDs from `spec` – never real people or real card numbers.
- One idea per case; the Test Case name says what it proves.

Per category:

- **field** – `parameter` is a request field (e.g. `client.email`, `purchase.products.price`);
  `data` uses the sheet conventions: `Field not sent`, `""` (empty), `null`, `256 characters`,
  `110001 with country=IN`; `expected` in plain words ("Validation error", "Accepted", "Validation
  error if mandatory"). Set `expectation` (accepted / rejected / observe / sanitized) when it is not obvious.
- **regex** – `bank` = the bank, `parameter` = a field that has a regex in the context; pick values just
  inside and just outside each pattern (length limits, allowed vs forbidden characters, leading/trailing
  spaces, unicode, words the pattern blocks). Wrap a value in double quotes when leading/trailing spaces
  matter (`"Maria Lopez "`). For per-country rules (e.g. `phone: ["IN","US","default"]`) set `country`
  (e.g. `IN`) and use that country's numbers – PGS repairs them to `+<code><digits>` first. Put `Valid` /
  `Invalid` in `result` (Java syntax, whole value must match, `NA` is always invalid); the launcher
  re-checks against the live rule with the PGS logic anyway. Invalid values are replaced by PGS, not
  rejected, and a field the PSP never receives (Paysafe gets no customer phone) is only recorded.
- **psp** – several rows with the same `title` form one transaction (2–5 checks each). `field` is a PSP
  field name or path from the context (e.g. `merchantRefNum`, `billingDetails.zip`); `check` is one of
  equals / not equals / contains / matches / present / absent / masked (card data, e-mail, phone must be stored as ***); use placeholders in `value`
  (`{purchaseId}`, `{amountMinor}`, `{currency}` …). Paysafe sends amounts in minor units.
- **edge** – `card` = a card ID from `spec` (or empty for the run's card), `changes` like
  `purchase.total=0.5; client.country=IN`, and at least one of `cashier` / `status` / `error`.
  The Paysafe sandbox declines a 2.00 purchase by design and approves 10.00.

- **kyc** – `customer` = New customer / New customer (merchant_cust_id) / Unknown customer_id /
  Unknown merchant_cust_id / No customer id; `changes` like `country=GB; link_ttl_minutes=5;
country not sent; customer.fullName="Ann Lee"; customer.phoneNo not sent` (never `test`);
  `auth` = Valid / No Authorization header / Key without Bearer / Unknown key / No Brand-Id /
  Brand not owned; `http` required (200, 400, 401, 403, 404, 409); `code` for failures
  (country_required, customer_required, customer_not_found, authentication_failed, access_denied);
  `status` on success (AWAITING_USER). Rules: docs/pgs-behaviour.md § 6.

- **refund** – `purchase` = New payment / Unpaid purchase / Settled purchase (Run tab); `refunds` =
  amounts in order separated by `;`: `30%`, `2.50`, `rest`, `rest+0.01`, `total`, `0`, `-1`, `"abc"`,
  `not sent`; `reason` empty (default) / `not sent` / `""` / text. Expectations (`http`, `code`,
  `message`, `status` = final purchase status) apply to the LAST step. Known answers: 400
  `invalid_amount` "exceeds refundable amount", "greater than zero", "reason for refund is required",
  "amount is required", "already fully refunded". Write the business expectation (202) even though the
  sandbox PSP may refuse unsettled refunds – the run reports that as OBSERVED. Rules: § 5.
- **bank-config** – `settings` = `name=value; …` with `2D only=1/0`, `Partial refund=1/0`,
  `Convert to=<cur>/{other}/none`, `Allowed currencies=<list>`, `Allowed cards=<list>`,
  `Merchant conversion=1/0`; prefer tokens: `{purchase}` / `{card}` = the purchase currency / card
  scheme, `{other}` = a different one. `action` = Pay / Partial refund / Full refund (refunds pay first
  with the current settings; only Partial refund matters there). Expect `routing` (Uses the MID /
  Skips the MID), `status`, `code` (refund: payment_can_not_be_refunded), `error`
  ("can not be processed"), `currency` (PSP currency, e.g. `{other}`). Base every case on the live
  settings from `context` and flip them; one idea per case. Rules: § 7. Each routing change costs a
  5-minute wait at run time (PGS MID cache) – keep the set focused.

- **s2s** – `purchase` = New purchase / Unknown purchaseId / Second call (payment already started);
  `auth` = Valid / No Authorization header / Key without Bearer / Content-Type text/plain; `changes` =
  S2S body changes on top of the S2S data tab: `expires="12/3"; cvc not sent; screen_width=0;
remember_card=on; deviceId="QA-1"` ("…" text, numbers, true/false, null, JSON, N characters); `http`
  required; for 202 give `status` (final: PAID / ERROR) and `outcome` (Success / Failure / Pending redirect);
  for rejections `code`, `message` and `status` after the call (CREATED payable / ERROR ended). Card
  payment methods only. Rules: § 8 (many malformed values are accepted by PGS – write the correct
  expectation, a red case is a finding).

Save the rows as a JSON array of objects keyed by the column `key`s, e.g. `generated-regex.json`.

## 4. Build and check the file

```bash
npm run -s cases -- write <category> generated-<category>.json generated-<category>-cases.xlsx --env local
npm run -s cases -- check <category> generated-<category>-cases.xlsx --env local
```

`check` validates exactly like the launcher upload (`OK`, `DUP` = already exists, `FIX` = must be
corrected). Fix every `FIX` row and re-run until it reports 0 to fix. Delete the JSON afterwards.

## 5. Hand over

Tell the QA the file name, how many cases (positive / negative), and to upload it on
**launcher → Test cases → <category> → Upload the filled sheet**, review the preview and click
**Add selected cases**. Regex, PSP, edge, refund and bank & MID cases make real test transactions
when run; bank & MID cases change shared test4 settings (restored after) and run on their own.

The launcher also has **Generate with AI** on the same tab (needs `ANTHROPIC_API_KEY` in `.env`) for
the same result without leaving the launcher.
