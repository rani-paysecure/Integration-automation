import type { BackofficeClient } from './backoffice-client';

/**
 * Bank / MID / merchant settings that change how PGS routes and processes a
 * payment (InitiateAction):
 *   bank   max_refund_days          → refund_upto = success time + N days − 1 h (0 = not refundable)
 *   MID    allowed_curr / allowed_card → otherwise "This customer can not be processed !"
 *   MID    curr_convert_to          → amount converted before the PSP call (FX)
 *   merch. conversionAllowed = 0    → a MID that converts is skipped (CONVERSION_NOT_ALLOWED)
 *   MID    onlyTwoD = 1             → payment sent as 2D (no 3DS); merchant trxType 3D → MID_IS_NOT_2D
 *   MID    partial_refund_allowed   → 0 = partial refunds refused ("does not allow partial refund")
 *
 * Reads never return credentials (whitelisted fields only). Writes go through the
 * dashboard's own MID form (all fields re-posted unchanged except the one flipped)
 * and are verified by reading the MID back.
 */
export interface BankSettings {
  readonly id: number;
  readonly name: string;
  readonly maxRefundDays: number;
  readonly allowedCurr: readonly string[];
  readonly allowedCard: readonly string[];
}

export interface MidSettings {
  readonly id: number;
  readonly bankId: number;
  readonly mid: string;
  readonly currConvertTo: string;
  readonly onlyTwoD: number;
  readonly is3ds: number;
  readonly partialRefundAllowed: number;
  readonly allowedCurr: string;
  readonly allowedCard: string;
  readonly allowedCountry: string;
  readonly isTestData: boolean;
}

export interface MerchantSettings {
  readonly conversionAllowed: number;
  /** 2D / 3D / ALL */
  readonly trxType: string;
}

/** MID fields the tests may change (names as in PaymentBankMid / the dashboard form). */
export interface MidChange {
  readonly onlyTwoD?: 0 | 1;
  readonly partial_refund_allowed?: 0 | 1;
  readonly curr_convert_to?: string;
  readonly allowed_curr?: string;
  readonly allowed_card?: string;
}

type Json = Record<string, unknown>;
const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const num = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number(text(v)) || 0;
const list = (v: unknown): string[] =>
  text(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function parseJson(raw: { status: number; text: string }, what: string): unknown {
  if (raw.status !== 200) throw new Error(`${what}: dashboard answered HTTP ${String(raw.status)}`);
  try {
    return JSON.parse(raw.text) as unknown;
  } catch {
    throw new Error(`${what}: the dashboard did not return data (session or permission problem?)`);
  }
}

export async function getBankSettings(
  backoffice: BackofficeClient,
  bankName: string,
): Promise<BankSettings> {
  const rows = parseJson(
    await backoffice.rawRequest('GET', '/admin/getAllActivePaymentBanks'),
    'Banks',
  );
  const bank = (Array.isArray(rows) ? (rows as Json[]) : []).find((b) => text(b.name) === bankName);
  if (bank === undefined)
    throw new Error(`Bank "${bankName}" is not an active bank in the dashboard`);
  return {
    id: num(bank.id),
    name: bankName,
    maxRefundDays: num(bank.max_refund_days),
    allowedCurr: list(bank.allowed_curr),
    allowedCard: list(bank.allowed_card),
  };
}

function toMidSettings(row: Json): MidSettings {
  return {
    id: num(row.id),
    bankId: num(row.pp_id),
    mid: text(row.mid),
    currConvertTo: text(row.curr_convert_to),
    onlyTwoD: num(row.onlyTwoD),
    is3ds: num(row.is3ds),
    partialRefundAllowed: num(row.partial_refund_allowed),
    allowedCurr: text(row.allowed_curr),
    allowedCard: text(row.allowed_card),
    allowedCountry: text(row.allowedCountry),
    isTestData: row.is_test_data === true,
  };
}

export async function getMidSettings(
  backoffice: BackofficeClient,
  bankId: number,
  midName: string,
): Promise<MidSettings> {
  const rows = parseJson(
    await backoffice.rawRequest(
      'GET',
      `/admin/v2/getAllPaymentBankMIDList?pp_id=${String(bankId)}`,
    ),
    'MIDs',
  );
  const row = (Array.isArray(rows) ? (rows as Json[]) : []).find(
    (m) => text(m.mid) === midName || text(m.mid_desc) === midName,
  );
  if (row === undefined) throw new Error(`MID "${midName}" not found on bank ${String(bankId)}`);
  return toMidSettings(row);
}

/** Active banks: id and name only (the raw rows hold credentials). */
export async function listBanks(
  backoffice: BackofficeClient,
): Promise<{ id: number; name: string }[]> {
  const rows = parseJson(
    await backoffice.rawRequest('GET', '/admin/getAllActivePaymentBanks'),
    'Banks',
  );
  return (Array.isArray(rows) ? (rows as Json[]) : [])
    .map((b) => ({ id: num(b.id), name: text(b.name).trim() }))
    .filter((b) => b.name !== '');
}

/**
 * Bank + MID by MID name (as shown in Limits/Charges routing). Banks whose name
 * prefixes the MID name are tried first (paysafe_payfac → paysafe_payfac_mid).
 */
export async function findMid(
  backoffice: BackofficeClient,
  midName: string,
  bankName?: string,
): Promise<{ bank: BankSettings; mid: MidSettings } | undefined> {
  const banks = await listBanks(backoffice);
  const lower = midName.toLowerCase();
  const ordered = bankName
    ? banks.filter((b) => b.name === bankName)
    : [
        ...banks
          .filter((b) => lower.startsWith(b.name.toLowerCase()))
          .sort((a, b) => b.name.length - a.name.length),
        ...banks.filter((b) => !lower.startsWith(b.name.toLowerCase())),
      ];
  for (const b of ordered) {
    try {
      const mid = await getMidSettings(backoffice, b.id, midName);
      return { bank: await getBankSettings(backoffice, b.name), mid };
    } catch {
      /* not on this bank */
    }
  }
  return undefined;
}

export async function getMerchantSettings(
  backoffice: BackofficeClient,
  merchantId: number,
): Promise<MerchantSettings> {
  const page = await backoffice.rawRequest('GET', `/admin/getMerchant?m_id=${String(merchantId)}`);
  const conversion = /"conversionAllowed"\s*:\s*(-?\d+)/.exec(page.text);
  const trxType = /"trxType"\s*:\s*"([^"]*)"/.exec(page.text);
  if (conversion === null) throw new Error('Merchant settings not found on the merchant page');
  return { conversionAllowed: Number(conversion[1]), trxType: trxType?.[1] ?? 'ALL' };
}

/** Merchant Details → "Conversion allowed" switch (the dashboard's own toggle call). */
export async function setMerchantConversionAllowed(
  backoffice: BackofficeClient,
  merchantId: number,
  flag: 0 | 1,
): Promise<void> {
  const result = await backoffice.rawRequest('POST', '/admin/updateCheckWhiteList', {
    json: { mid: merchantId, flag, type: 'conversionallowed' },
  });
  if (result.status !== 200)
    throw new Error(`Conversion allowed switch: HTTP ${String(result.status)}`);
  const after = await getMerchantSettings(backoffice, merchantId);
  if (after.conversionAllowed !== flag) {
    throw new Error(
      `Conversion allowed is ${String(after.conversionAllowed)} after setting it to ${String(flag)}`,
    );
  }
}

// ── MID edit page (Banks → MID → edit) ─────────────────────────────────────

const unescapeHtml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Brace-matched JSON object that starts at `start` in `source`. */
function objectAt(source: string, start: number): string {
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('MID page: object not terminated');
}

interface MidPage {
  readonly object: Json;
  readonly formNames: readonly string[];
  readonly authKeyLabels: string;
}

async function readMidPage(
  backoffice: BackofficeClient,
  bankId: number,
  midId: number,
): Promise<MidPage> {
  const page = await backoffice.rawRequest(
    'GET',
    `/admin/getPaymentBankMID?pp_id=${String(bankId)}&id=${String(midId)}`,
  );
  const html = page.text;
  const formStart = html.lastIndexOf('<form', html.indexOf('setPaymentBankMID'));
  if (formStart < 0) throw new Error('MID page: edit form not found (SUPERADMIN login needed)');
  const form = html.slice(formStart, html.indexOf('</form>', formStart));
  const formNames = [
    ...new Set(
      [...form.matchAll(/<(?:input|select|textarea)[^>]*\sname="([^"]+)"/g)].map((m) => m[1] ?? ''),
    ),
  ];
  const marker = new RegExp(`\\{"id":${String(midId)},"pp_id":${String(bankId)},`);
  const found = marker.exec(html);
  if (found === null) throw new Error('MID page: MID data not found');
  const object = JSON.parse(objectAt(html, found.index)) as Json;
  const labels =
    /name="auth_key_labels"[^>]*value="([^"]*)"/.exec(form) ??
    /value="([^"]*)"[^>]*name="auth_key_labels"/.exec(form);
  return { object, formNames, authKeyLabels: unescapeHtml(labels?.[1] ?? '') };
}

const keyOf = (name: string): string => name.toLowerCase().replace(/_/g, '');

/** Form body exactly as the dashboard form posts it: every MID field, current values. */
function formFor(page: MidPage, change: MidChange): Record<string, string> {
  const byKey = new Map(Object.keys(page.object).map((k) => [keyOf(k), k]));
  const form: Record<string, string> = {};
  for (const name of page.formNames) {
    if (name === '_csrf') continue;
    if (name === 'auth_key_labels') {
      form[name] = page.authKeyLabels;
      continue;
    }
    const key = byKey.get(keyOf(name));
    if (key === undefined) continue; // UI-only helper inputs
    const value = page.object[key];
    if (value === null || value === undefined) continue;
    form[name] = typeof value === 'object' ? JSON.stringify(value) : text(value);
  }
  for (const [name, value] of Object.entries(change)) form[name] = String(value);
  return form;
}

function differences(before: Json, after: Json, ignore: ReadonlySet<string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (k) => !ignore.has(keyOf(k)) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}

/**
 * Changes MID settings through the dashboard's MID form and verifies that ONLY
 * those settings changed. Any other difference → the original values are posted
 * back immediately and the call fails. Returns the previous values for restore.
 */
export async function updateMidSettings(
  backoffice: BackofficeClient,
  bankId: number,
  midId: number,
  change: MidChange,
): Promise<MidChange> {
  const before = await readMidPage(backoffice, bankId, midId);
  if (before.object.is_test_data === true) {
    // setPaymentBankMID always saves is_test_data=false – it could not be restored.
    throw new Error(
      'This MID is marked as test data; the dashboard form would clear that flag – not changing it',
    );
  }
  const previous: MidChange = {};
  const byKey = new Map(Object.keys(before.object).map((k) => [keyOf(k), k]));
  for (const name of Object.keys(change))
    (previous as Record<string, unknown>)[name] =
      before.object[byKey.get(keyOf(name)) ?? name] ?? '';

  const post = async (body: Record<string, string>): Promise<void> => {
    const result = await backoffice.rawRequest('POST', '/admin/setPaymentBankMID', { form: body });
    if (result.status >= 400) throw new Error(`MID update: HTTP ${String(result.status)}`);
  };
  await post(formFor(before, change));
  const after = await readMidPage(backoffice, bankId, midId);
  const changedKeys = new Set(Object.keys(change).map(keyOf));
  const unexpected = differences(before.object, after.object, changedKeys);
  const missing = Object.entries(change).filter(
    ([name, value]) => text(after.object[byKey.get(keyOf(name)) ?? name]) !== String(value),
  );
  if (unexpected.length > 0 || missing.length > 0 || after.authKeyLabels !== before.authKeyLabels) {
    await post(formFor(before, {})); // put everything back as it was
    throw new Error(
      `MID update was not clean – restored. Unexpected changes: ${unexpected.join(', ') || 'none'}; not applied: ${missing.map(([n]) => n).join(', ') || 'none'}`,
    );
  }
  return previous;
}
