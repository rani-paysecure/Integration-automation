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

`npm run launcher` starts a small local web UI at <http://127.0.0.1:4173> (opens automatically).

1. **Environment** – UAT or LOCAL.
2. **Tester profile** – each QA's brand ID + API key. Add / edit / delete profiles in the UI;
   "Custom" runs once with a brand ID + key that is not saved.
3. **Payment method** – VISA, MASTERCARD, or any other scheme code.
4. **Suite** – e.g. _Cashier purchase › 1. API field validation_; optional filter by case id/title
   (e.g. `FT-01`, `phone`).
5. **Run** – live log, then open the HTML report or download the results CSV.

Security: binds to `127.0.0.1` only, rejects foreign `Host` headers, needs a per-session token for
every change, never sends API keys back to the browser (only the last 4 characters), and masks keys
in the streamed log.

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
3. ⏳ Cashier payment (browser) + PSP request/response validation via the back-office API
4. ⏳ Excel report per run: purchase ID → transaction ID, status, PSP checks, verdict
