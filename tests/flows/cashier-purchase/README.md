# Cashier purchase flow

Hosted-checkout purchase: `POST /v1/purchases/` → customer pays on `checkout_url`.

| Stage                                   | Spec                              | Status                                             |
| --------------------------------------- | --------------------------------- | -------------------------------------------------- |
| 1. Paysecure API field validation       | `01-api-field-validation.spec.ts` | Implemented (cases from `field_test_cases 1.xlsx`) |
| 2. Regex validation                     | `02-regex-validation.spec.ts`     | Planned                                            |
| 3. PSP request/response validation      | `03-psp-validation.spec.ts`       | Planned                                            |
| 4. Report: purchase ID → transaction ID | reporter                          | Planned                                            |

Run: `npm run test:cashier` (all stages) or `npm run test:cashier:fields` (stage 1).
