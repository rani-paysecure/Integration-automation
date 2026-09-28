# Integration QA Automation

Playwright + TypeScript framework for testing Paysecure **integrations, APIs and end-to-end flows**
(session, cashier purchase, S2S purchase).

> **Environments:** only `uat` (test4) and `local` (a Paysecure stack on your machine). There is
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

1. **Configuration** – environment (top right: UAT / LOCAL), tester (brand ID + API key, or
   one-off credentials), currency, payment method (VISA, MASTERCARD, …) and bank / PSP.
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
`paymentMethod`, bank is compared with the bank/PSP of the PSP record after a transaction, brand
ID + API key come from the tester.

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
      "paymentMethod": "VISA",
      "environments": {
        "uat": { "brandId": "<uat brand id>", "apiKey": "<uat secret key>" },
        "local": { "brandId": "<local brand id>", "apiKey": "<local secret key>" }
      }
    }
  ]
}
```

Resolution order for each run:

| Value          | 1st                      | 2nd                               | 3rd    |
| -------------- | ------------------------ | --------------------------------- | ------ |
| API key        | profile (`TEST_PROFILE`) | `UAT_API_KEY` / `LOCAL_API_KEY`   | –      |
| Brand ID       | profile (`TEST_PROFILE`) | `UAT_BRAND_ID` / `LOCAL_BRAND_ID` | –      |
| Payment method | `PAYMENT_METHOD`         | profile `paymentMethod`           | `VISA` |

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
│   └── examples/                # template specs – reference only, not executed
├── tools/launcher/              # test launcher UI (server.js + index.html)
├── reports/                     # generated (git-ignored)
├── profiles.example.json        # template – real profiles.local.json is git-ignored
└── .env.example
```

Import aliases: `@config/*`, `@clients/*`, `@constants/*`, `@helpers/*`, `@schemas/*`,
`@app-types/*`, `@utils/*`, `@fixtures/*`, `@test-data/*`.

## Writing tests

```ts
import { HttpStatus } from '@constants/http';
import { paymentResponseSchema } from '@schemas/payment.schema';
import { expect, test } from '@fixtures/api.fixture';
import { buildPaymentRequest } from '@test-data/purchase/purchase-request.factory';

test('creates a payment', { tag: '@smoke' }, async ({ paymentApi, envData }) => {
  const request = buildPaymentRequest(envData, { amount: 2_500 });

  const response = await paymentApi.createPayment(request);

  expect(response).toHaveStatus(HttpStatus.CREATED);
  expect(response).toMatchSchema(paymentResponseSchema);
  expect(response.body.amount).toBe(request.amount);
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

**Dashboard login:** add _Dashboard username/password_ to your profile in the launcher (or
`UAT_DASHBOARD_USERNAME` / `UAT_DASHBOARD_PASSWORD`). The dashboard allows **one active session per
user** – a run logs in once (shared by all workers, removed after the run) and **ends that user's
browser session**. Use a dedicated automation dashboard user per QA to avoid being logged out.

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
