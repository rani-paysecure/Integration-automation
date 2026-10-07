---
name: generate-test-cases
description: Write and refine Paysecure PGS integration test cases (field, regex, psp, edge, kyc, refund, s2s, bank-config) as JSON rows of the Integration-automation launcher template. Use when a message starts with "TASK: generate-test-cases" or "TASK: refine-test-cases".
---

# Generate and refine test cases (Integration-automation launcher)

The launcher (the QA tool) sends you one category at a time. You answer with **JSON only**; the
launcher validates every row exactly like an Excel upload, shows a preview, and the tester decides
what is saved. You never see passwords, API keys or card numbers and must never invent real ones.

## 1. What the launcher sends

```
TASK: generate-test-cases | refine-test-cases
CATEGORY: <id> – <label>
COUNT: <min>–<max>                 (generate only)
FOCUS: <tester's focus, or "default">
COLUMNS: one line per column – key, header, required/optional, rules, allowed values
CONTEXT: live data – request fields, bank regexes, test-card IDs, PSP field names, MID settings,
         how PGS really behaves (from the backend code), existing cases (do NOT repeat them)
CURRENT CASES: JSON rows already in the preview      (refine, or a resumed conversation)
REJECTED: refs the tester unticked                   (refine)
INSTRUCTION: what the tester wants changed           (refine)
```

Facts in CONTEXT beat your general knowledge. If CONTEXT says PGS replaces an invalid value instead of
rejecting it, the case expects the replacement.

## 2. Answer format – JSON only, no prose, no code fences

Generate:

```json
{
  "cases": [
    { "ref": "C1", "<column key>": "<value>", "why": "one sentence: what this case proves" }
  ]
}
```

Refine (only what changes – the launcher keeps everything else as it is):

```json
{
  "add":    [{"ref": "C9", "...": "..."}],
  "update": [{"ref": "C3", "...all columns of the new version..."}],
  "remove": ["C5"],
  "note":   "one short sentence for the tester (optional)"
}
```

- Every value is a string; use `""` for an optional column you leave empty.
- `ref`: `C1`, `C2` … unique in the conversation. New cases continue after the highest ref you have
  used; never reuse a removed ref. `update` repeats all columns, not just the changed ones.
- `psp` only: several rows with the same `title` are one test case – give them the same `ref`;
  `update` / `remove` act on all rows of that ref.
- Do not re-add a case listed under REJECTED unless the instruction asks for it; treat it as a hint of
  what the tester does not want.
- `note` is only about the cases (what you changed or could not do) – never about tools, connectors
  or your environment.
- If the instruction cannot be done (e.g. a field that does not exist), return no changes and explain
  in `note`.

## 3. Rules for every category

- Use only the column keys from COLUMNS; values must follow the column rules and allowed values.
- Mix **positive** (accepted / succeeds / sent unchanged) and **negative** (rejected / replaced / fails).
- One idea per case; the title says what it proves. No two cases test the same thing; nothing from
  the existing cases.
- Test data only: `example.com` emails, invented names, 555 / obviously fake numbers, card **IDs** from
  CONTEXT. Never real people, real card numbers or real contact details.
- Aim for the top of COUNT when there is enough distinct ground; never pad with near-duplicates.
- Expectations follow PGS behaviour in CONTEXT; a confirmed defect ("bug") is worth one case that
  expects the correct behaviour.

## 4. Category notes (what good coverage looks like when FOCUS is "default")

- **field** – missing / empty / null, wrong types, length limits, formats (email, phone, dates, ISO
  codes), unicode, whitespace, injection strings. Payment-method parameters are dynamic: extraParam keys
  differ per method – valid, missing, empty, null, wrong type, several keys, keys the method does not
  need, extraParam not an object. Never assume a fixed key list.
- **regex** – for each field with a regex: values just inside and just outside the pattern (length
  boundaries, allowed vs forbidden characters, leading / trailing spaces, unicode letters, look-alikes,
  words the pattern blocks). Expected Result = Valid / Invalid by the regex (Java, whole value must
  match); the launcher re-checks against the live regex.
- **psp** – 2–5 checks per test case on one transaction: amount (major vs minor units), currency, order
  reference = purchase ID, customer / billing data, 3DS fields, status and IDs in the response. Use the
  placeholders from CONTEXT; field names only from the PSP field lists.
- **edge** – amount boundaries, currency / country mismatches, missing optional customer data, the
  different test cards (approved, declined, 3DS challenge). The Paysafe sandbox declines 2.00 and
  approves 10.00.
- **kyc** – auth variants, missing / blank country, missing / unknown customer ids, merchant_cust_id vs
  customer_id, TTL and expiry boundaries, incomplete customer records, unknown extra fields.
- **refund** – partial refunds in steps, the exact rest, more than the rest (rest+0.01), total twice,
  zero / negative / non-numeric amounts, amount or reason not sent, unpaid purchase, refund after a full
  refund. Expectations apply to the last step.
- **s2s** – S2S exists only to execute card payments through the API (no APMs, refunds or KYC): expiry formats (MM/YY, MMYY, past, month 00 / 13), missing / empty /
  wrong-type card fields, Luhn failures, browser data values, remember_card on / off / empty, extra
  fields, auth and content-type variants, a second call on the same purchase.
- **bank-config** – each MID setting on and off against its current value (2D only, partial refund,
  convert to {other} with merchant conversion on / off, allowed currencies with / without {purchase},
  allowed cards with / without {card}), a few combinations; mix "uses the MID" and "skips the MID".
  Prefer tokens ({purchase}, {other}, {card}) over literal codes.
