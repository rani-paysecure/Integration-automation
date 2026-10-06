# Integration QA Automation

Playwright + TypeScript framework for testing Paysecure **integrations, APIs and end-to-end flows**
(session, cashier purchase, S2S purchase).

> **Environments:** only `uat` and `local` – both point to test4 (`https://test4.paymentsclub.net`) by default. There is
> intentionally no production configuration, and the framework refuses to run against anything that
> looks like one (see [Safety guards](#safety-guards)).

---

## Quick start

```bash
# 1. Install (Node 20+; see .nvmrc)
npm ci
npx playwright install chromium       # only needed for cashier (browser) stages

# 2. Configure
cp .env.example .env                  # Windows: copy .env.example .env
#    → URLs are pre-filled for UAT; add LOCAL URLs if you test locally

# 3. Add your tester profile (brand ID + API key) – either in the launcher UI
#    or by copying profiles.example.json to profiles.local.json

# 4. Run
npm run launcher                      # UI: pick env, profile, payment method, suite → Run
# or from the command line:
npx cross-env TEST_PROFILE=rani PAYMENT_METHOD=VISA npm run test:cashier:fields
```

## Test launcher (UI)

`npm run launcher` starts a local web UI at <http://127.0.0.1:4173> (opens automatically).

**Run tab – select, click Run test, read the result:**

1. **Configuration** – environment (top right: UAT / LOCAL), tester (brand ID + API key), then
   **Currency → Payment method** exactly as configured for the tester's merchant in the dashboard's
   **Limits/Charges** page; the **MID** that combination routes to is read from the same
   configuration and shown next to it ("Routes to"), and checked after a transaction. Values are
   the internal ones (`VISA`, `MASTER`, …). Set the tester's merchant once in the Testers tab.
   Without dashboard access the dropdowns offer the template currency and VISA / MASTER, and
   routing is not checked.
2. **Test cases** – searchable list of every case (e.g. search `zip` → FT-058…FT-063), card
   transaction scenarios, the PSP check for existing purchase IDs and the framework self-tests.
   Tick exactly what to run.
3. **Transaction** – optionally let every _accepted_ field case continue into a **real
   transaction** with a chosen test card: cashier → PAY → PSP → back-office. "Transactions (test
   cards)" cases always pay.
4. **▶ Run test** – runs the matching Playwright tests with that configuration.
5. **Report** – configuration (API key masked), totals, and per test: expected vs actual,
   pass/fail, purchase ID and PSP transaction ID; click a row for request, response,
   validation/error details, PSP checks (incl. _routed to selected bank_), request sent to the PSP
   and the PSP response. Earlier runs stay in the history dropdown (`reports/ui/history/`).

How selections are applied: currency overrides the purchase template, payment method is sent as
`paymentMethod`, the MID from Limits/Charges is compared with the PSP record after a transaction
("Routed to configured MID"), brand ID + API key come from the tester. Loading the routing logs the
tester's dashboard user in (one session per user – it ends their browser session).

Other tabs:

| Tab               | What you set                                                                                                          | Stored in             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Run**           | environment, tester, payment method, suite, filter, purchase IDs, test cards, show browser, workers, retries          | – (per run)           |
| **Testers**       | name, brand ID, API key, dashboard username/password, default payment method – per environment                        | `profiles.local.json` |
| **Environments**  | dashboard/cashier URL and API URL for UAT and LOCAL, default environment                                              | `settings.local.json` |
| **Purchase data** | baseline request: customer, currency, products, total, platform, `send_receipt`, `skip_capture`, redirects, callbacks | `settings.local.json` |
| **Test cards**    | card scenarios (number, expiry, CVV, holder, expected cashier result + status), on/off                                | `settings.local.json` |
| **Advanced**      | API key header/prefix, OAuth token path, payment-method list, log level, body logging, trace mode                     | `settings.local.json` |

Both `*.local.json` files are git-ignored and stay on the tester's computer. Team defaults live in
**`config/defaults.json`** (committed); a "customised" badge + **Reset** shows/undoes local changes.

Precedence: **shell / CI variables → launcher (`settings.local.json`) → `.env` → `config/defaults.json`**.

Security: binds to `127.0.0.1` only, rejects foreign `Host` headers, needs a per-session token for
every change, validates every value (e.g. production hosts are rejected), never sends API keys or
passwords back to the browser, and masks them in the streamed log.

## Tester profiles (3 QAs, own brand ID + API key)

Profiles live in **`profiles.local.json`** – git-ignored, written with file mode `600`, never
committed. Template: `profiles.example.json`.

```json
{
  "profiles": [
    {
      "id": "rani",
      "name": "Rani",
      "environments": {
        "uat": { "brandId": "<uat brand id>", "apiKey": "<uat secret key>" },
        "local": { "brandId": "<local brand id>", "apiKey": "<local secret key>" }
      }
    }
  ]
}
```

Resolution order for each run:

| Value          | 1st                                               | 2nd                               | 3rd    |
| -------------- | ------------------------------------------------- | --------------------------------- | ------ |
| API key        | profile (`TEST_PROFILE`)                          | `UAT_API_KEY` / `LOCAL_API_KEY`   | –      |
| Brand ID       | profile (`TEST_PROFILE`)                          | `UAT_BRAND_ID` / `LOCAL_BRAND_ID` | –      |
| Payment method | selected in Run (from the MID) / `PAYMENT_METHOD` | –                                 | `VISA` |

Every result row (CSV + HTML report annotations) records environment, tester, payment method and
brand ID, so runs from different QAs are never mixed up.

## npm scripts

| Script                               | What it does                                            |
| ------------------------------------ | ------------------------------------------------------- |
| `npm run launcher`                   | Test launcher UI                                        |
| `npm test`                           | All projects against `TEST_ENV` (default `uat`)         |
| `npm run test:uat` / `test:local`    | All tests against UAT / LOCAL                           |
| `npm run test:cashier`               | Cashier purchase flow (all stages)                      |
| `npm run test:cashier:fields`        | Cashier stage 1 – API field validation                  |
| `npm run test:s2s` / `test:session`  | S2S purchase / session flows (not implemented yet)      |
| `npm run test:framework`             | Offline self-tests of config, profiles, masking, client |
| `npm run test:headed` / `test:debug` | Headed browser / Playwright Inspector                   |
| `npm run test:report`                | Open the last HTML report                               |
| `npm run validate`                   | Typecheck + ESLint + Prettier check                     |

Scripts accept Playwright flags, e.g. `npm run test:uat -- --project=cashier-purchase --grep FT-01`.

## Environment configuration

| Concern                                  | Source                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Base URL / API URL                       | `UAT_BASE_URL`, `UAT_API_BASE_URL` / `LOCAL_BASE_URL`, `LOCAL_API_BASE_URL` |
| Credentials                              | tester profile → `UAT_*` / `LOCAL_*` fallback                               |
| Timeouts, retries, workers, headers      | `config/uat/uat.config.ts`, `config/local/local.config.ts`                  |
| Test data (redirects, callbacks, limits) | `tests/test-data/environments/{uat,local}.data.ts`                          |

Values come from (highest first): shell / CI variables → `.env.<env>` → `.env`.

## Project structure

```text
├── config/
│   ├── local/ uat/              # per-environment settings (non-secret)
│   ├── profiles.ts              # tester profiles (profiles.local.json)
│   ├── env-loader.ts            # .env loading helpers
│   ├── global-setup.ts          # run banner (env, profile, payment method)
│   └── test-config.ts           # resolves + validates config for TEST_ENV
├── src/
│   ├── clients/                 # BaseApiClient, AuthProvider, PurchaseApiClient, …
│   ├── constants/               # endpoints, HTTP status/headers, sensitive keys
│   ├── helpers/                 # expect matchers, assertions, field-testing engine
│   ├── reporters/               # field-test CSV reporter
│   ├── schemas/                 # Zod response schemas
│   ├── types/  utils/
├── tests/
│   ├── flows/
│   │   ├── cashier-purchase/    # 01-api-field-validation (02-regex, 03-psp planned)
│   │   ├── s2s-purchase/
│   │   └── session/
│   ├── framework/               # offline self-tests
│   ├── fixtures/                # config, profile/merchant, auth, clients
│   ├── test-data/
│   │   ├── environments/        # UAT / LOCAL data
│   │   ├── purchase/            # baseline purchase request (shared)
│   │   └── cashier-purchase/    # field-test cases (from field_test_cases 1.xlsx)
├── tools/launcher/              # test launcher UI (server.js + index.html)
├── ai-skills/paysecure-qa/      # skill pack for the Paysecure AI gateway (Generate with AI)
├── reports/                     # generated (git-ignored)
├── profiles.example.json        # template – real profiles.local.json is git-ignored
└── .env.example
```

Import aliases: `@config/*`, `@clients/*`, `@constants/*`, `@helpers/*`, `@schemas/*`,
`@app-types/*`, `@utils/*`, `@fixtures/*`, `@test-data/*`.

## Writing tests

```ts
import { HttpStatus } from '@constants/http';
import { purchaseCreatedSchema } from '@schemas/purchase.schema';
import { expect, test } from '@fixtures/api.fixture';
import { buildPurchaseRequest } from '@test-data/purchase/purchase-request.factory';

test('creates a purchase', { tag: '@smoke' }, async ({ purchaseApi, envData, merchant }) => {
  const request = buildPurchaseRequest(envData, merchant);

  const response = await purchaseApi.createPurchase(request);

  expect(response).toHaveStatus([HttpStatus.OK, HttpStatus.CREATED]);
  expect(response).toMatchSchema(purchaseCreatedSchema);
});
```

**Conventions**

- Tests never build raw HTTP calls – add a method to a client in `src/clients/` instead.
- Endpoint paths live only in `src/constants/endpoints.ts`.
- Payloads come from factories / data files in `tests/test-data/`, not inline JSON.
- Use tags: `@smoke`, `@regression`, `@negative`, `@boundary`, `@security`, `@integration`.
- Tests that create irreversible data must skip when
  `testConfig.settings.allowDestructiveTests` is `false` (default in UAT).
- For asynchronous processing use `expect.poll(...)` rather than fixed waits.

### Adding a new API client

1. Create `src/clients/<domain>-api-client.ts` extending `BaseApiClient`.
2. Add its endpoints to `src/constants/endpoints.ts` and schemas to `src/schemas/`.
3. Register a fixture in `tests/fixtures/api.fixture.ts`.
4. Add test data under `tests/test-data/<domain>/`.

### Assertions

Playwright's `expect` is extended (not replaced) with API matchers:

| Matcher                             | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `toHaveStatus(201 \| [200, 202])`   | HTTP status, failure message shows masked body |
| `toMatchSchema(zodSchema)`          | Response schema / data types                   |
| `toHaveHeader(name, value?\|regex)` | Response headers                               |
| `toRespondWithin(ms)`               | Response time budget                           |

Helpers in `src/helpers/api-assertions.ts`: `expectRequiredFields(body, paths)` (soft, reports all
missing fields) and `expectApiError(response, { status, code, message, field })`.
Everything else (business rules) uses standard Playwright assertions.

## Cashier purchase – stage 1: API field testing

`tests/flows/cashier-purchase/01-api-field-validation.spec.ts` runs every row of the
**Field Test Cases** sheet (`field_test_cases 1.xlsx`) against `POST /v1/purchases/`
with a VISA card baseline request.

```bash
npm run test:cashier:fields                  # UAT (default)
npm run test:local -- --grep @field-validation # LOCAL
npm run test:cashier:fields -- --grep FT-01  # filter by case id / title
```

- **Cases:** `tests/test-data/cashier-purchase/api-field-cases.ts` (one entry per sheet row, id `FT-xxx`).
  Each case mutates one field of the baseline in `purchase-request.factory.ts`.
- **Expectation types:** `accepted` (2xx), `rejected` (4xx validation error – 401/403 fail as auth
  problems), `observe` (sheet says "if mandatory"/"according to specification" – any non-5xx passes
  and the actual behaviour is recorded), `sanitized` (injection: 4xx or 2xx without echoing the
  payload). **Any 5xx fails.**
- **Results sheet:** `reports/field-tests/field-test-results.csv` (opens in Excel) with expected vs
  actual HTTP status, error code, API message and verdict (PASS / FAIL / OBSERVED / SKIPPED).
- `cashier.full_name` rows are sent as `client.full_name`; cashier-page validation (popup, Pay
  blocked, cardholder name) belongs to a future browser suite.
- Auth: `Authorization: Bearer <API key of the selected profile>` (`API_KEY_HEADER=Authorization`, `API_KEY_PREFIX=Bearer`).

## Payment-method fields (`extraParam`, `upiId`, `invoiceNo` …)

Some payment methods need their own request fields. Nothing is hardcoded per method:

- **Purchase data → Payment-method fields (optional):** rows of _payment method · field · type · value_.
  Field = `extraParam.<any key>` (iban, accountNumber, sortCode, name …) or a top-level name (`upiId`,
  `invoiceNo`). Payment method _All_ = every purchase; a name (e.g. `UPI`) = only when the run or a
  case uses that method (matched case-insensitively). _Paste JSON…_ takes
  `{"upiId": "pending@testbank", "extraParam": {"iban": "AE07…"}}` for a method. Stored in the
  template as `extraParam` (all methods) and `methodFields` (per method).
- **Field validation cases (FV-xxx):** Parameter `extraParam.<key>`, `extraParam` (whole object) or a
  top-level name; Test Data `Field not sent`, `""`, `null`, `123 (no quotes)`, `{"k":"v"}`, `["x"]`,
  `256 characters`; Context `paymentMethod=UPI; extraParam.accountNumber="123"` runs the case with
  that method and sets the other keys, so only one key changes. Accepted values must come back
  stored as sent.
- **From the dashboard:** Test cases → Field validation → _From the dashboard – payment-method
  parameters_ reads a method's required fields and extraParam groups (Payment Methods page) and
  suggests valid / missing / empty / null / wrong type / 256 chars / both groups / not-required-key /
  wrong extraParam type cases for every key. A method the tester's merchant does not allow is skipped.
- The starter set FV-001…018 covers `extraParam` (iban, accountNumber, sortCode, name), `upiId` and
  `invoiceNo` – all confirmed on test4 (PGS stores these fields as sent; only a non-object
  `extraParam` is rejected). PGS rules: `docs/pgs-behaviour.md` § 1.
- `platform`, `send_receipt` and `skip_capture` are no longer sent (removed from the template).

## Uploading test cases by category (launcher → Test cases)

Each category has its own template (**Download template**: a "Test Cases" sheet with examples and
dropdowns, plus a short "Guide" sheet). Fill it in, upload it, check the preview, then click **Add
selected cases**. Cases that already exist or have problems are flagged and can't be ticked. IDs are
never reused, even after a delete.

| Category               | IDs      | Stored in (`tests/test-data/uploaded-cases/`) | What runs                                                                                                                                                                                                               |
| ---------------------- | -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field validation       | `FV-xxx` | `field-validation.json`                       | One request field changed; API response must match the expectation (next to the built-in `FT-xxx`).                                                                                                                     |
| Regex validation       | `RX-xxx` | `regex-validation.json`                       | Real transaction per value; the bank's field regex (dashboard) decides: matching value must reach the PSP unchanged, non-matching must not.                                                                             |
| PSP request / response | `PR-xxx` | `psp-validation.json`                         | Real transaction; fields of the PSP request/response (dashboard log) checked: equals / not equals / contains / matches / present / absent.                                                                              |
| Custom & edge cases    | `EC-xxx` | `edge-cases.json`                             | Real transaction with optional request changes; cashier result, final status and error message compared.                                                                                                                |
| KYC validation         | `KV-xxx` | `kyc-validation.json`                         | `POST /kyc/create` with a customer, request changes and an auth variant; HTTP, code and KYC status compared.                                                                                                            |
| Refund cases           | `RC-xxx` | `refund-cases.json`                           | Refund steps (`30%; rest`, `rest+1`, `-1`, `"abc"`, `not sent` …) on a new payment, an unpaid purchase or the settled purchase of the Run tab; last answer + final status compared.                                     |
| Bank & MID config      | `BC-xxx` | `bank-config.json`                            | Flip the routed MID / merchant settings (2D only, partial refund, convert to, allowed currencies / cards, merchant conversion) → pay or refund → routing, status, code, PSP currency; restored after. Run on their own. |

- **Regex rules come from the dashboard:** PaymentBankJsonData → Field Regex, per bank
  (`GET /admin/getFieldValidationRules?bank_name=…`). On test4 a value that breaks the rule is not
  rejected – it is replaced before the PSP call (e.g. `full_name` → cardholder name, `city` → a
  default). In the launcher choose **Regex validation → From the dashboard**: the bank is suggested
  from the Limits/Charges routing of the Run tab, **Load rules** lists the field regexes and proposes
  valid / invalid / boundary values for each field. The live regex is re-read at run time. Rules that
  are a country list (e.g. `phone`) are recorded as OBSERVED.
- **PSP fields** are found at any depth by name (`currencyCode`) or path (`billingDetails.zip`).
  Expected values can use `{purchaseId}` `{amount}` `{amountMinor}` (cents) `{currency}` `{email}`
  `{country}` `{city}` `{zip}` `{phone}` `{fullName}`. Rows with the same Test Case are one transaction.
- **Card:** regex, PSP and edge cases always pay – with the card in the sheet, or else the **Card for payments** chosen on the Run
  tab; without either they are skipped.
- **Field / regex values:** `Field not sent` removes the field, `""` sends an empty string,
  `256 characters` generates a long value, `110001 with country=IN` also sets the country.
- **Refund cases:** every step waits until the previous refund is processed; expectations apply to the
  last step. A refund the PSP refuses although PGS accepted it (sandbox, not settled yet) is OBSERVED.
  _Settled purchase (Run tab)_ uses the purchase ID entered as **Settled purchase to refund**.
- **Bank & MID config cases:** settings use tokens so they work for any run – `{purchase}` / `{card}` =
  the purchase currency / card scheme, `{other}` = a different one. Refund actions pay first with the
  current settings, then change them and refund. The MID under test is **Routes to** on the Run tab (or
  the MID a probe payment goes to). Same safety as BM-xxx: journalled, restored, 5-minute cache wait.
- **AI for refunds / bank & MID:** _Generate with AI_ reads the routed MID's live settings, its bank and
  the merchant switch from the dashboard (whitelisted fields only) and the PGS rules in
  `docs/pgs-behaviour.md` §5 / §7, so new dashboard settings show up in the proposed cases. Built-in
  RF / BM cases are listed as "existing" so they are not repeated.
- Commit the JSON files so the whole team gets the cases. They are validated when tests load.

## 3DS challenge (bank OTP page)

Between PAY and the merchant redirect the bank may show a challenge page (OTP / password, usually
inside an iframe). Each test card has a **3DS challenge** setting (Test cards tab):

| Setting                     | What happens                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Nothing – frictionless card | No input; a challenge that appears ends the payment as "Stayed on another page".                                        |
| Enter the OTP automatically | Finds the code field in any frame, types the OTP and presses Submit. Empty OTP = read "(OTP: 1234)" from the test page. |
| Wait for me to enter it     | With **Show browser while paying**, waits up to 5 minutes for the tester to complete it.                                |

The report shows what happened (e.g. "0merchantacsstag.cardinalcommerce.com: OTP read from the page
entered, SUBMIT pressed"). Team default cards (Paysafe sandbox,
[test cards](https://developer.paysafe.com/en/api-docs/3ds/test-and-go-live/test-cards/)):

| Card               | 3DS              | Result on test4          |
| ------------------ | ---------------- | ------------------------ |
| `4000000000002503` | challenge → Y    | success redirect · PAID  |
| `4000000000002370` | challenge → N    | failure redirect · ERROR |
| `4000000000002719` | frictionless → A | success redirect · PAID  |
| `4530910000012345` | frictionless → U | failure redirect · ERROR |

Note: the Paysafe sandbox declines some amounts on purpose (a 2.00 purchase is declined "by the
issuing bank"), so the team default purchase amount is 10.00.

## Devices (desktop / tablet / phone)

**Device** on the Run tab opens the cashier as Desktop Chrome, iPad, Galaxy Tab S4, iPhone 14 or
Pixel 7 (screen, viewport, pixel ratio, user agent and touch of that device; engine stays Chromium).
The cashier reads these values itself and sends them to PGS on PAY (`/npv/…?sw=&sh=&cd=&pd=&uo=&ije=`),
which forwards them to PSPs that need 3DS browser data. Every payment records the device and the
values sent to PGS, and checks that the screen size sent equals the device screen.
Paysafe collects browser data on its own hosted 3DS page, so its request only carries
`threeDs.deviceChannel` and `customerIp`. Limitation: `navigator.platform` is not emulated.

## Execution report (launcher → Report)

Each run is shown grouped by category (Field validation, Regex validation, PSP request / response,
Custom & edge cases, Card transactions). Every test is a card with a PASSED (green) / FAILED (red)
badge, a **Positive** (success expected) or **Negative** (rejection / failure expected) tag, Expected vs
Actual side by side, and the Purchase / PSP transaction IDs. Filters: result, category, positive /
negative, free text.

**Download report (Excel)** gives one workbook to share, for the latest or any earlier run:

- **Summary** – overall result, totals and pass rate, run details, results per category, all failed
  tests with Expected vs Actual, and a short legend.
- **Results** – every test (category, case, type, colour-coded result, expected, actual, IDs,
  duration, error), with filters and a frozen header.

Payments: **Card for payments** on the Run tab is used by regex / PSP / edge cases (unless the sheet
names a card). Field-validation cases only pay when **Also pay for accepted field-validation cases**
is ticked.

## PGS backend knowledge

`docs/pgs-behaviour.md` summarises how the PGS backend validates purchases and applies bank field
regexes (read from its code, with results confirmed on test4 – including bugs such as date of birth
`1990-13-01` being accepted). The AI generator and the `generate-test-cases` skill use it as
context. `config/pgs/pgs-rules.js` is a port of PGS's `ClientDetailsValidator` (per-country phone
rules, phone repair, "NA" handling) used by the regex tests; refresh its country catalog with
`npm run cases -- sync-pgs <path to PGS repo>`.

## AI-generated test cases

**Launcher → Test cases → Generate with AI**, through the **Paysecure AI gateway** (WebSocket). No
Claude / Anthropic API key is stored in this project.

1. **Generate** – choose the category (for regex also the bank in _From the dashboard_), min / max and
   an optional focus. The launcher opens a gateway session and sends the template columns plus live
   context: request fields, the bank's field regexes, MID settings, test-card IDs, PSP field names
   seen in earlier runs, PGS behaviour and the existing cases. The answer is validated like an upload;
   for regex the bank's own regex decides Valid / Invalid.
2. **Refine** – type what should change ("add 3 cases for unicode names", "remove C4", "make C2 use the
   3DS card") and press Refine. The same conversation answers only the changes (add / update / remove
   by ref C1, C2 …); unticked cases are sent as rejected so they are not suggested again. Repeat as
   often as needed, then **Add selected cases**.
3. The conversation ends when you add or cancel, switch category, click _End conversation_, or after
   `AI_SESSION_IDLE_S` (default 300 s) unused – this frees the gateway seat. A later Refine on the same
   preview opens a new gateway session seeded with the current cases, so nothing is lost.

**Skills.** The rules live in the skill pack `ai-skills/paysecure-qa/` (source of truth, versioned
with the launcher). Deploy it to the gateway (`bundles/skills/paysecure-qa`, see its README): the
launcher then opens an _agent_ session with that pack (file, shell and web tools disabled) and calls
`paysecure-qa__generate-test-cases`. While the pack is not deployed – or with `AI_GATEWAY_SKILLS=inline`
– the launcher opens a cheaper _chat_ session and sends the same SKILL.md as the system prompt. New
skills for other tasks go into the same pack.

Settings in `.env` (launcher only, test runs never get them): `AI_GATEWAY_URL`
(`ws://<host>:8081/v1/agent`; an `http://` URL of the host also works), `AI_GATEWAY_TOKEN`, optional
`AI_GATEWAY_SKILLS`, `AI_GATEWAY_SKILL_PACK`, `AI_GATEWAY_MODEL`, `AI_SESSION_IDLE_S`. No passwords,
API keys or card numbers are sent in prompts. Needs Node.js 22+ (built-in WebSocket).

The helper CLI still builds and checks upload files without AI:

```bash
npm run cases -- spec <category>                     # columns, allowed values, card IDs
npm run cases -- context <category> [--bank <bank>]  # fields, bank regexes, cards, existing cases
npm run cases -- write <category> rows.json out.xlsx # rows → filled template
npm run cases -- check <category> out.xlsx           # validate like the launcher upload
```

## Moving the launcher to a server later

The launcher is a local tool today (binds to 127.0.0.1, no login). Two shell variables already keep
the per-machine files outside the code folder, so a later server or Docker setup can put them on a
persistent volume without code changes:

- `LAUNCHER_DATA_DIR` – folder for `profiles.local.json` and `settings.local.json` (default: project root).
- `UPLOADED_CASES_DIR` – folder of the saved test cases (default: `tests/test-data/uploaded-cases`).

Both are read by the launcher and by the test runs it starts. A shared deployment would still need
sign-in, a run queue and a way to commit added cases – not built yet.

## Cashier purchase – pay on the cashier (end to end)

`tests/flows/cashier-purchase/03-cashier-payment.spec.ts` runs the real customer journey:
**create purchase → open `checkout_url` → type test card → PAY → (3DS / PSP pages) → merchant
redirect → final status → PSP request/response in the back-office**, and adds a row to the
purchase ID → PSP transaction ID report.

```bash
npx playwright install chromium            # once
npx cross-env TEST_PROFILE=rani npx playwright test --grep @cashier-payment
npx cross-env TEST_PROFILE=rani npx playwright test --grep @cashier-payment --headed   # watch it
```

Card scenarios (`tests/test-data/cashier-purchase/cashier-cards.ts`):

| Scenario              | Card                          | Expected                                                          |
| --------------------- | ----------------------------- | ----------------------------------------------------------------- |
| Approved              | `UAT_CARD_APPROVED` in `.env` | success redirect, `PAID`                                          |
| Declined              | `UAT_CARD_DECLINED` in `.env` | failure redirect, `ERROR`                                         |
| Risk rule (UAT)       | `4530 9100 0001 2345`         | via Paysafe 3DS → failure redirect, `ERROR` ("threeDResult is U") |
| Cashier rejects (UAT) | `4111 1111 1111 1111`         | PAY rejected "Invalid card details", stays `CREATED`              |

The cashier page object (`src/pages/cashier-page.ts`) uses the form's element IDs. In the launcher
pick **Cashier purchase › pay on cashier**; tick _Show browser_ to watch.

## Cashier purchase – stage 3: PSP request/response validation

`tests/flows/cashier-purchase/03-psp-validation.spec.ts` reads, for each purchase ID, the
back-office transaction (`POST /trans/getAllTrans`) and the bank / PSP record
(`GET /trans/getBankTrans`) – the same data as _Transactions → click purchase ID_ in the dashboard.

```bash
# launcher: suite "Cashier purchase › 3. PSP request/response", paste purchase IDs
npx cross-env TEST_PROFILE=rani PSP_PURCHASE_IDS=id1,id2 npx playwright test --grep @psp-validation
```

Checks per paid/failed purchase: PSP record exists · order reference = purchase ID · amount and
currency sent to the PSP (FX amount/currency when converted) · request and response recorded ·
PAID ⇒ PSP transaction ID present and last attempt successful · ERROR ⇒ last attempt not
successful. Unpaid purchases are reported as **NOT ATTEMPTED**.

Output: `reports/psp-validation/psp-validation-results.csv` – **purchase ID → PSP transaction ID**,
bank, MID, amounts, PSP status, gateway code/message, failed checks, verdict (+ `history/`). The
masked PSP request/response are attached to each test in the HTML report.

### Automatic PSP compliance checks (every paid / failed transaction)

Added to the PSP checks of every transaction (card payments, regex/PSP/edge cases, field cases
that pay, and the by-ID check). Code: `src/helpers/psp-compliance.ts`.

| Check                                                                      | Source                                                                       | Passes when                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card number / CVV / card expiry / e-mail / phone masked in PSP logs        | `paymentInfo`, `cancelInfo`, `allOtherRequest`, `response`, `response3ds`, … | value stored as `***` everywhere (PGS `maskJsonObject`); the test card's full number appears nowhere. Only the **path** is reported, never the value. Merchant e-mail/phone and a clear cardholder name are listed as notes. |
| paymentInfo filled                                                         | `paymentInfo`                                                                | the transaction request was stored (Main.createPayload, transaction call)                                                                                                                                                    |
| Mapping: amount / currency / purchase ID                                   | `paymentInfo`                                                                | amount = purchase total (major or minor units), currency, purchase ID sent                                                                                                                                                   |
| Mapping: first/last name, e-mail, phone, street, city, zip, state, country | purchase `client` → `paymentInfo`                                            | the PSP received the purchase value (fields the PSP does not take → note; masked → counts as mapped)                                                                                                                         |
| Merchant webhook sent (Webhook out)                                        | `/admin/getWebhookResponse`                                                  | a webhook with the final status exists; URL = `success_callback` (paid) / `failure_callback` (error). A non-2xx answer of the merchant URL (e.g. `Fail-405` from google.com) is a note.                                      |
| PSP webhook received and consumed (Webhook in)                             | `/admin/pspWebhookLog/data`                                                  | any webhook the PSP sent has status `consumed` / `Already_Consumed` (none → note)                                                                                                                                            |

Uploaded PSP sheets also accept the check **masked** (e.g. `card.cvv` → masked).

## Cashier purchase – stage 5: refunds (`@RF-…`, real refunds)

`tests/flows/cashier-purchase/06-refunds.spec.ts` – only refunds purchases it paid itself with the
run's card, or the **Settled purchase to refund** entered in the launcher (`REFUND_PURCHASE_ID`).

| Case                                                                                | Expected                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-001 paid purchase (new payment or the given one)                                 | PAID                                                                                                                                                                                                              |
| RF-002 partial refund 30 % (`POST /api/v1/purchases/{pid}/refund {amount, reason}`) | HTTP 202 → `partial_refunded`; refund in history (Reports → refunds), total refunded / refundable amount, status history `partial_refunded amt: x`, refund request **in `cancelInfo` (masked)**, merchant webhook |
| RF-003 more than refundable                                                         | 400 `invalid_amount`                                                                                                                                                                                              |
| RF-004 amount 0                                                                     | 400 "Refund amount must be greater than zero."                                                                                                                                                                    |
| RF-005 remaining amount                                                             | HTTP 202 → `refunded` (same checks as RF-002)                                                                                                                                                                     |
| RF-006 refund after full refund                                                     | 400 "already fully refunded"                                                                                                                                                                                      |
| RF-007/008/009 unpaid purchase / no reason / no amount                              | 400 (no payment needed)                                                                                                                                                                                           |

**Sandbox note:** Paysafe refuses refunds until the payment is settled (error 3406 "…has not been
batched yet"; PGS answers "Refund can not be initiated"). The case is then **OBSERVED** and the
failure recording is verified instead (refund entry `ERROR`, `refund_failed amt: x`, status
unchanged, `cancelInfo` filled and masked). For a successful refund, enter a purchase paid a day
or more earlier as **Settled purchase to refund**.

**Dashboard login:** add _Dashboard username/password_ to your profile in the launcher (or
`UAT_DASHBOARD_USERNAME` / `UAT_DASHBOARD_PASSWORD`). The dashboard allows **one active session per
user** – a run logs in once (shared by all workers, removed after the run) and **ends that user's
browser session**. Use a dedicated automation dashboard user per QA to avoid being logged out.

## Cashier purchase – stage 6: bank & MID configuration (`@BM-…`, flip → test → restore)

`tests/flows/cashier-purchase/07-bank-mid-config.spec.ts` checks that the routed bank / MID
settings change how PGS processes a payment. BM-001 pays with the run's card and reads the bank / MID
it was routed to (checked against the run's bank / MID when given). Cases that need another value
**change it through the dashboard's own MID form / merchant switch, make a real payment or refund,
and restore the original value** in `finally`.

| Case   | Setting (temporarily set)                                | Expected                                                                                                    |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| BM-001 | –                                                        | PAID; bank, MID and merchant settings recorded                                                              |
| BM-002 | bank `max_refund_days` (read only)                       | `refund_upto` = paid + days × 24 h − 1 h (0 when days ≤ 0)                                                  |
| BM-003 | MID 2D only = 0                                          | routed to the MID; PSP request carries 3DS data                                                             |
| BM-004 | MID 2D only = 1                                          | still routed to the MID (merchant trxType ALL; 3D → MID skipped); PSP refusal of the 2D payment is OBSERVED |
| BM-005 | MID partial refund allowed = 0                           | 400 code `payment_can_not_be_refunded` (the API returns only the code)                                      |
| BM-006 | MID partial refund allowed = 1                           | partial refund not refused by the MID check (PSP may still refuse)                                          |
| BM-007 | MID convert to = other currency, merchant conversion ON  | `fx_Currency` and PSP currency = convert-to currency                                                        |
| BM-008 | MID convert to = other currency, merchant conversion OFF | MID skipped (CONVERSION_NOT_ALLOWED)                                                                        |
| BM-009 | MID allowed currencies = another currency only           | MID skipped                                                                                                 |
| BM-010 | MID allowed cards = the other scheme only                | MID skipped                                                                                                 |
| BM-011 | –                                                        | MID and merchant settings equal the BM-001 snapshot                                                         |

- **Shared config:** these settings are shared on test4. The launcher runs BM cases **on their own
  with one worker** and needs the tester's dashboard login (SUPERADMIN).
- **Safety:** every change is written to `reports/bank-config-journal.json` before it is made and
  removed after the restore; the next BM run restores anything a killed run left changed. A MID
  write re-posts every field of the MID unchanged, reads the MID back and, if anything other than
  the flipped field changed, posts the original back and fails. MIDs flagged as test data are never
  changed (the form would clear that flag). No auth key / password is logged; PGS refund errors
  that contain the auth key are masked.
- **PGS MID cache (5 min):** payment routing reads the live MIDs from Redis (`cacheALM8`, 5 minutes) and a
  MID edit does not clear it. After each routing change (2D only, convert to, allowed currencies / cards)
  the next payment waits until that cache has expired (`BANK_CONFIG_MID_CACHE_SECONDS`, default 315), so
  a full BM run takes ~30–40 minutes. For up to 5 minutes after the run, PGS may still route with the last
  flipped value. Refunds and the merchant conversion switch are read from the database (no wait).
- Other currency for BM-007…009: USD (EUR for USD purchases), or `BANK_CONFIG_CONVERT_TO`.
- `BANK_CONFIG_PURCHASE_ID`: start from an already paid purchase of the merchant (BM-001 makes no new payment).
- **paysafe_payfac finding:** its request template sends `threeDs` even on a 2D-only MID; PGS skips the 3DS step
  (Direct 2D) and Paysafe can then refuse the payment with 5068 "payment handle … not permitted … because of its state".

## S2S purchase (`tests/flows/s2s-purchase`, project `s2s-purchase`)

Card payment methods only (VISA, MASTER, AMEX … – APMs have no S2S on PGS and their runs skip these
cases). Flow: Purchase API (**CREATED** + purchaseId, checkout not opened) → **S2S API**
`POST /api/v1/p/{purchaseId}/?s2s=true` with card + browser data → **202 pending + callback_url** →
callback opened in the browser → 3DS (if asked) → merchant redirect → final status, PSP checks and
merchant webhook. A 2D merchant is paid inside the S2S call (no callback) and only the webhook follows.

- **S2S-001…003:** CREATED purchase; run card with `remember_card` **off** / **on** (on = PGS saves
  the card for the customer).
- **Test cards (`@s2s-card-<id>`):** every card of the Test cards tab through S2S, same expectations as
  the cashier – except a card the cashier rejects in the browser: S2S rejects it server-side and
  the purchase ends as ERROR.
- **S2S-010…029 validation** (no payment): auth, content type, unknown purchase, Luhn, missing card /
  browser fields, expiry, malformed JSON, second call on the same purchase, APM purchase. Card-detail and
  expiry errors end the purchase (ERROR); auth / Luhn / browser-field errors leave it payable.
  Two confirmed PGS defects are marked as known failures: missing `card_number` → HTTP 500, expiry
  month `13` accepted.
- **S2S data tab** (launcher): the baseline S2S request per environment – remote_ip, remember_card,
  browser data (from the Run tab device or custom values), extra fields – with a live **request
  preview** (endpoint, headers, body; card masked). Saved in `settings.local.json` like Purchase data.
  `S2S_REMOTE_IP` (shell / CI) overrides remote_ip. PGS rejects a remote_ip equal to the caller's IP.
- **S2S cases (`S2-xxx`, Test cases tab):** upload the template or _Generate with AI_. One row =
  purchase (new / unknown id / second call) + authentication variant + request changes on top of the S2S
  data (`expires="12/3"; cvc not sent; screen_width=0; deviceId="QA-1"`) → expected HTTP / code /
  message, purchase status, and the browser outcome when the call is accepted (the case then follows the
  callback and 3DS like a customer). Stored in `tests/test-data/uploaded-cases/s2s-cases.json`.
- **How a QA tests S2S:** Run tab → choose the tester, a **card** payment method and the card for
  payments → select _S2S purchase_ cases (built-in S2S-xxx, test cards, uploaded S2-xxx) → Run. The report
  shows the S2S answer, callback URL, 3DS / redirect, final status, PSP request/response and webhook per case.
- **Starter set S2-001…007** (confirmed on test4): spaces in the card number → Luhn (still payable);
  empty holder → ERROR; MM/YYYY → rejected; extra field and unusual browser data still pay. S2-006 (CVC
  letters) and S2-007 (month 00) are **red on purpose** – PGS accepts them (202) instead of rejecting.

## KYC verification (`tests/flows/kyc`, project `kyc`)

The former `paysecure-e2e` KYC suite, merged in as its own category. Launcher → Run → groups
**KYC verification › …**; report category **KYC verification**. Manual test cases with the same
IDs: [`docs/kyc-test-cases.md`](docs/kyc-test-cases.md); PGS rules: `docs/pgs-behaviour.md` § 6.

```bash
npm run test:kyc                      # API + hosted page (skips @slow and @sumsub)
npm run test:kyc:all                  # + expiry poller (minutes) and the Sumsub WebSDK walk
```

| Group                        | Cases                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| 1 Create – happy path        | KYC-01, 02, 02a                                                                          |
| 2 Reuse & idempotency        | KYC-04, 04a, 05, 05a, 05b, 06, 07a                                                       |
| 3 Guards on existing records | KYC-07, 22a (`@slow`); 35a–d `fixme` (need an approved / rejected / resubmission record) |
| 4 Validation & auth          | KYC-03, 08, 08a, 09, 10, 10a, 11a–e, 12, 12a                                             |
| 5 Status read                | KYC-13, 13a–c, 14a; KYC-15 cross-merchant (needs a second merchant)                      |
| 6 Customer KYC history       | KYC-16, 16a–c, 17, 17a, 18                                                               |
| 7 Hosted verification page   | KYC-19, 19a, 19b, 21; KYC-22 (`@slow`)                                                   |
| 8 Return from provider       | KYC-23, 23a, 23b, 24; **KYC-25 known PGS defect** (`test.fail()` – red until fixed)      |
| 9 Provider webhook           | KYC-26, 26a, 27a, 27b, 28 (need the webhook secret); KYC-26b unsigned                    |
| 10 Expiry (poller) `@slow`   | KYC-29, 30, 22b – need `kyc.poll.enabled=true` on the server                             |
| 11 Merchant callbacks        | KYC-31a, 31b, 33, 33a; 31, 32, 32a `fixme` (need a sink + verdicts)                      |
| 12 Sumsub WebSDK `@sumsub`   | KYC-34 – drives the provider's UI up to liveness                                         |
| 20 Uploaded KYC validation   | KV-xxx from the Test cases tab (below)                                                   |

**KYC on/off per tester:** KYC is merchant configuration, so each tester has a switch on the
Testers tab – _KYC enabled for this merchant_ – with **Check dashboard** reading Merchant Details →
Kyc Configuration (Bank MID) of the tester's merchant. Off = the KYC groups on the Run tab are greyed
out ("KYC off for this tester") and a run with KYC cases is refused. One-off credentials may run them.

**Merchant:** the tester profile's merchant must have a KYC provider MID (Dashboard → Merchant → KYC
configuration) – otherwise every case fails fast with `kyc_not_enabled`. For another merchant set
`LOCAL_KYC_API_KEY` / `LOCAL_KYC_BRAND_ID` (+ `LOCAL_KYC_MERCHANT_ID`) in `.env` – see `.env.example`.
The webhook secret and provider name are read from that merchant's KYC configuration in the
dashboard (or `LOCAL_KYC_WEBHOOK_SECRET` / `KYC_PROVIDER`); without them the signed webhook cases skip.
Every create is sent with `test: true`; customers are created with complete dummy data (`E2E…` ids).

**KYC validation category (Test cases tab, `KV-xxx`):** one row = one `POST /kyc/create`.
Columns: Test Case · Customer (New customer / New customer (merchant_cust_id) / Unknown customer_id /
Unknown merchant_cust_id / No customer id) · Request Changes (`country=GB; link_ttl_minutes=5;
metadata.order=A1; country not sent; customer.fullName="Ann Lee"; customer.phoneNo not sent`) ·
Authentication (Valid / No Authorization header / Key without Bearer / Unknown key / No Brand-Id /
Brand not owned) · Expected HTTP · Expected Code · Expected KYC Status · Expected Message Contains.
Upload a filled template or use **Generate with AI** like the other categories.

## Logging & sensitive data

- Every request is logged as `METHOD url → status (ms)`; set `LOG_LEVEL=debug` for full
  (masked) headers and bodies. `LOG_HTTP_BODIES=false` drops bodies entirely.
- Everything logged or attached passes through `maskSensitiveData`: passwords, secrets, tokens,
  API keys, `Authorization`/cookies, CVV, expiry, PIN are replaced with `***`; card/account numbers
  and phones keep the last 4 digits; e-mails keep the first letter and domain. Card numbers and
  bearer tokens in free text are also masked. Extend the lists in
  `src/constants/sensitive-fields.ts`.
- `console` is banned by ESLint outside the logger.

## Reporting

| Output                      | Location                                              |
| --------------------------- | ----------------------------------------------------- |
| HTML report                 | `reports/html` (`npm run test:report`)                |
| JUnit XML (CI)              | `reports/junit/results.xml`                           |
| JSON                        | `reports/json/results.json`                           |
| Masked request/response log | `http-exchanges.json` attachment on every failed test |
| Traces / screenshots        | `test-results/` (on failure)                          |

Each test is annotated with its environment in the HTML report, and every API call is shown as a
step (`POST https://…/v1/payments`).

> **Traces contain unmasked request data.** They are kept locally on failure but **disabled in
> CI** by default. Force a mode with `PW_TRACE=on|off|retain-on-failure|on-first-retry`. Never
> share trace files outside the team.

## Safety guards

- `TEST_ENV` accepts only `local` or `uat`; anything else (e.g. `prod`, `qa`) fails immediately.
- Configured URLs must be http(s) and must not contain a host label such as `prod`, `production`,
  `prd` or `live` (e.g. `api.prod.example.com` is rejected; `product-api.test…` is fine).
- UAT disables destructive tests and runs with fewer workers by default.

## CI/CD

`.github/workflows/integration-tests.yml`:

- **Every PR / push to main:** `npm run validate` + offline framework tests.
- **Manual run (`workflow_dispatch`, UAT):** URLs from GitHub Environment **variables**, brand ID
  and API key from the `uat` GitHub Environment (variables `UAT_BRAND_ID`, `API_KEY_HEADER`,
  `API_KEY_PREFIX`; secret `UAT_API_KEY`). LOCAL cannot run in CI.

## Roadmap – cashier purchase

1. ✅ Paysecure API field validation
2. ⏳ Regex validation (dashboard-configured regex, applied by the API and enforced on the cashier page)
3. ✅ PSP request/response validation via the back-office (given purchase IDs) · ⏳ automated cashier payment
4. ⏳ Excel report per run: purchase ID → transaction ID, status, PSP checks, verdict
