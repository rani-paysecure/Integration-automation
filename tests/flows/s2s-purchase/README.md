# S2S purchase flow (card payment methods only)

Server-to-server purchase: the merchant collects the card itself and sends it to PGS.

1. `POST /api/v1/purchases/` → `status: CREATED` + `purchaseId` (the `checkout_url` is **not** opened)
2. `POST /api/v1/p/{purchaseId}/?s2s=true` with card + browser data (merchant key)
   - merchant trxType ALL / 3D → 202 `{status: "pending", method: "GET", callback_url}`
   - merchant trxType 2D → PGS pays inside the call and answers the purchase (no callback, `"no_need"`);
     the merchant callback (webhook) carries SUCCESS / PENDING / FAILURE
3. `callback_url` opened in the customer's browser → 3DS challenge if the bank asks → merchant redirect
4. Final status, PSP request/response and merchant webhook – the same checks as the cashier flow

| Spec                           | Cases                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `01-s2s-card-payments.spec.ts` | S2S-001 Purchase API CREATED · S2S-002/003 run card with `remember_card` off / on · one case per test card (`@s2s-card-<id>`)            |
| `02-s2s-validation.spec.ts`    | S2S-010…029 auth, content type, unknown purchase, Luhn, missing card / browser fields, expiry, malformed JSON, second call, APM purchase |

Baseline request: launcher → **S2S data** (with request preview); `envData.s2s` in the tests.
Building blocks: `src/helpers/s2s-flow.ts` (flow), `tests/test-data/s2s/s2s-request.factory.ts` (body –
browser data from the Run-tab device), `CashierPage.openCallback` (3DS / redirect handling shared with
the cashier), `src/helpers/card-methods.ts` (card vs APM, from the dashboard's Payment Methods).
Run: `npm run test:s2s` or select the cases on the launcher's Run tab. PGS rules: `docs/pgs-behaviour.md` § 8.
