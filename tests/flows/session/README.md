# Session flow

The customer pays on a hosted session page (same card form as the cashier). Two ways to get the customer:

| Option       | Steps                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **new**      | `POST` create customer (`merchantCustomerId` unique every run) → `customerId` → `POST` create session |
| **existing** | `POST` create session straight away for a `customerId` created earlier (no create customer)           |

Then, for both: `sessionUrl` opened in the customer's browser → card → PAY → 3DS challenge if the bank asks →
merchant redirect → back-office Transactions: search by **session ID**, the row carries the `purchaseId` →
final status, PSP request/response and merchant webhooks (same checks as the cashier flow).

| Spec                               | Cases                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `01-session-card-payments.spec.ts` | SES-001 new customer + session · SES-002 existing customer + session · one case per test card (`@session-card-<id>`) |

Choose new / existing (and the customer ID) on the launcher's **Session data** tab; `SESSION_CUSTOMER_ID` in the shell
or CI forces "existing". The card cases follow that choice; SES-001 always creates a customer, SES-002 always reuses one.

Dynamic data: any string in the customer / session bodies may contain `{{unique}}`, `{{uuid}}`, `{{timestamp}}`,
`{{date}}`, `{{random}}` (and `{{customerId}}` in the session body) – filled in on every run. Redirects and callbacks
default to the Purchase data tab. Endpoint paths: `src/constants/endpoints.ts` (`customers`, `sessions`).
Building blocks: `src/clients/session-api-client.ts`, `src/helpers/session-flow.ts`,
`tests/test-data/session/session-request.factory.ts`. Run: `npm run test:session` or the launcher's Run tab.
