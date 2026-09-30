---
name: generate-test-cases
description: Generate Paysecure integration QA test cases (field validation, bank regex validation, PSP request/response, custom & edge cases) as an upload-ready Excel file for the Integration-automation launcher. Use when a QA asks to create, suggest or expand test cases for a category, a bank's field regexes, a PSP or a test card.
---

# Generate test cases for the Integration-automation launcher

The project (`Integration-automation`) runs cashier-purchase tests from the launcher. New cases are
added on its **Test cases** tab by uploading a filled template. This skill writes that file.

## 1. Clarify (only if not given)

- **Category**: `field` (request field rules) · `regex` (a bank's field regexes) · `psp` (checks on
  the PSP request/response) · `edge` (end-to-end scenarios with a card and expected outcome) ·
  `kyc` (POST /kyc/create: customer, request changes, auth variant → HTTP, code, KYC status).
- **How many**: min and max number of cases (default 10–20; PSP counts test cases, not rows).
- **Environment**: `local` (default) or `uat` – both are test4.
- For `regex`: the **bank** name as in the dashboard (e.g. `paysafe_payfac`, `paywise`).
- Optional focus (e.g. "unicode names", "amount boundaries", "3DS cards").

## 2. Read the template and the context (from the project root)

```bash
npm run -s cases -- spec <category> --env local        # columns, allowed values, card IDs, examples
npm run -s cases -- context <category> --env local [--bank <bank>]   # fields, bank regexes, cards, existing cases
```

`context` includes the matching part of `docs/pgs-behaviour.md` – how the PGS backend really validates
(read from its code, with confirmed bugs). Prefer cases that probe those rules and bugs.

`context` for `regex` logs in to the dashboard with the tester's login from `profiles.local.json`
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
**Add selected cases**. Regex and PSP/edge cases make real test transactions when run.

The launcher also has **Generate with AI** on the same tab (needs `ANTHROPIC_API_KEY` in `.env`) for
the same result without leaving the launcher.
