import fs from 'node:fs';
import path from 'node:path';
import type { BackofficeClient } from '../clients/backoffice-client';
import {
  getMerchantSettings,
  setMerchantConversionAllowed,
  updateMidSettings,
  type MidChange,
} from '../clients/bank-config';

/**
 * Flip → test → restore for bank / MID / merchant settings (shared test4 config).
 *
 * Every change is written to a journal file BEFORE the test uses it and removed
 * once it is restored. If a run is killed mid-test, the next Bank & MID run (or
 * `restoreJournal`) puts the recorded original values back first.
 */
export type JournalEntry =
  | {
      readonly kind: 'mid';
      readonly bankId: number;
      readonly midId: number;
      /** Original values of the changed fields. */
      readonly original: MidChange;
      readonly at: string;
    }
  | {
      readonly kind: 'merchant-conversion';
      readonly merchantId: number;
      readonly original: 0 | 1;
      readonly at: string;
    };

export const JOURNAL_FILE = path.resolve(
  process.env.BANK_CONFIG_JOURNAL ?? path.join('reports', 'bank-config-journal.json'),
);

export function readJournal(file = JOURNAL_FILE): JournalEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
  } catch {
    return [];
  }
}

function writeJournal(entries: readonly JournalEntry[], file = JOURNAL_FILE): void {
  if (entries.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

/** Text of a scalar setting value ('' for anything else). */
export const scalar = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

const sameTarget = (a: JournalEntry, b: JournalEntry): boolean =>
  a.kind === 'mid' && b.kind === 'mid'
    ? a.bankId === b.bankId && a.midId === b.midId
    : a.kind === 'merchant-conversion' &&
      b.kind === 'merchant-conversion' &&
      a.merchantId === b.merchantId;

/** Records an original value. An older entry for the same target wins (it holds the real original). */
export function journalAdd(entry: JournalEntry, file = JOURNAL_FILE): void {
  const entries = readJournal(file);
  const existing = entries.find((e) => sameTarget(e, entry));
  if (existing === undefined) {
    writeJournal([...entries, entry], file);
    return;
  }
  if (existing.kind === 'mid' && entry.kind === 'mid') {
    // Keep the oldest value per field.
    const merged: JournalEntry = {
      ...existing,
      original: { ...entry.original, ...existing.original },
    };
    writeJournal(
      entries.map((e) => (e === existing ? merged : e)),
      file,
    );
  }
}

export function journalRemove(entry: JournalEntry, file = JOURNAL_FILE): void {
  writeJournal(
    readJournal(file).filter((e) => !sameTarget(e, entry)),
    file,
  );
}

async function restoreEntry(backoffice: BackofficeClient, entry: JournalEntry): Promise<void> {
  if (entry.kind === 'mid') {
    await updateMidSettings(backoffice, entry.bankId, entry.midId, entry.original);
    noteRoutingWrite(entry.original);
  } else {
    await setMerchantConversionAllowed(backoffice, entry.merchantId, entry.original);
  }
}

/** Restores what an interrupted run left changed. Returns a line per restored entry. */
export async function restoreJournal(backoffice: BackofficeClient): Promise<string[]> {
  const done: string[] = [];
  for (const entry of readJournal()) {
    await restoreEntry(backoffice, entry);
    journalRemove(entry);
    done.push(
      entry.kind === 'mid'
        ? `MID ${String(entry.midId)}: ${Object.keys(entry.original).join(', ')} restored`
        : `merchant ${String(entry.merchantId)}: conversion allowed restored to ${String(entry.original)}`,
    );
  }
  return done;
}

/**
 * PGS routing reads the live MIDs from Redis (MISCDaoimpl.getAllLiveMid, key cacheALM8,
 * 5 minutes) and a MID edit does not clear it. After a change that affects routing, a
 * payment only sees the new value once that cache has expired – and after the restore,
 * the changed value can still be used for up to 5 minutes. Refunds read the MID from the
 * database (no wait needed for partial_refund_allowed).
 */
export const MID_CACHE_MS = Number(process.env.BANK_CONFIG_MID_CACHE_SECONDS ?? 315) * 1000;
const ROUTING_FIELDS = new Set(['onlyTwoD', 'curr_convert_to', 'allowed_curr', 'allowed_card']);
const LAST_WRITE_FILE = path.join(path.dirname(JOURNAL_FILE), 'bank-config-last-write.json');

function noteRoutingWrite(change: MidChange): void {
  if (!Object.keys(change).some((k) => ROUTING_FIELDS.has(k))) return;
  fs.mkdirSync(path.dirname(LAST_WRITE_FILE), { recursive: true });
  fs.writeFileSync(LAST_WRITE_FILE, JSON.stringify({ at: Date.now() }));
}

/** Milliseconds until PGS's MID cache can no longer hold a value from before the last write. */
export function midCacheWaitMs(now = Date.now()): number {
  try {
    const { at } = JSON.parse(fs.readFileSync(LAST_WRITE_FILE, 'utf8')) as { at?: unknown };
    return typeof at === 'number' ? Math.max(0, at + MID_CACHE_MS - now) : 0;
  } catch {
    return 0;
  }
}

/** Waits out PGS's MID cache after a routing-relevant MID change (no-op otherwise). */
export async function waitForMidCache(): Promise<number> {
  const wait = midCacheWaitMs();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return wait;
}

export interface MidTarget {
  readonly bankId: number;
  readonly midId: number;
}

/**
 * Runs `body` with the MID changed as given (only the fields that differ are
 * posted) and always restores the original values afterwards.
 */
export async function withMidSettings<T>(
  backoffice: BackofficeClient,
  target: MidTarget,
  change: MidChange,
  current: MidChange,
  body: () => Promise<T>,
): Promise<T> {
  const needed = Object.fromEntries(
    Object.entries(change).filter(
      ([k, v]) => scalar(v) !== scalar((current as Record<string, unknown>)[k]),
    ),
  ) as MidChange;
  if (Object.keys(needed).length === 0) return body();
  const original = Object.fromEntries(
    Object.keys(needed).map((k) => [k, (current as Record<string, unknown>)[k] ?? '']),
  ) as MidChange;
  const entry: JournalEntry = { kind: 'mid', ...target, original, at: new Date().toISOString() };
  journalAdd(entry);
  try {
    await updateMidSettings(backoffice, target.bankId, target.midId, needed);
    noteRoutingWrite(needed);
    return await body();
  } finally {
    await restoreEntry(backoffice, entry);
    journalRemove(entry);
  }
}

/** Runs `body` with Merchant Details → "Conversion allowed" set to `flag`, then restores it. */
export async function withMerchantConversion<T>(
  backoffice: BackofficeClient,
  merchantId: number,
  flag: 0 | 1,
  body: () => Promise<T>,
): Promise<T> {
  const current = (await getMerchantSettings(backoffice, merchantId)).conversionAllowed;
  if (current === flag) return body();
  const entry: JournalEntry = {
    kind: 'merchant-conversion',
    merchantId,
    original: current === 0 ? 0 : 1,
    at: new Date().toISOString(),
  };
  journalAdd(entry);
  try {
    await setMerchantConversionAllowed(backoffice, merchantId, flag);
    return await body();
  } finally {
    await restoreEntry(backoffice, entry);
    journalRemove(entry);
  }
}

/** PGS puts the MID auth key into some refund errors – never report it. */
export function safeMessage(message: string): string {
  return message.replace(/\bauth\s*key\s*=\s*.*$/i, 'authkey = ***');
}

/**
 * Expected refund deadline (InitiateAction): success time + max_refund_days − 1 h;
 * max_refund_days ≤ 0 → 0 (not refundable).
 */
export function expectedRefundUpto(paidAtSeconds: number, maxRefundDays: number): number {
  return maxRefundDays > 0 ? paidAtSeconds + maxRefundDays * 86_400 - 3_600 : 0;
}

/** A currency that differs from `purchaseCurrency` (for conversion / allowed-currency cases). */
export function otherCurrency(purchaseCurrency: string, preferred?: string): string {
  const wanted = preferred?.trim().toUpperCase();
  if (wanted !== undefined && /^[A-Z]{3}$/.test(wanted) && wanted !== purchaseCurrency)
    return wanted;
  return purchaseCurrency.toUpperCase() === 'USD' ? 'EUR' : 'USD';
}

/** Card scheme the MID must NOT accept for the allowed-card case. */
export function otherScheme(scheme: string): string {
  return scheme.toUpperCase().startsWith('MASTER') ? 'VISA' : 'MASTER';
}
