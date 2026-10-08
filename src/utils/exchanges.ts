import type { HttpExchange } from '../types/api.types';

/** An exchange in the report; `repeats` > 1 = the same call was polled and answered the same. */
export type ReportExchange = HttpExchange & {
  /** How many identical calls in a row this entry stands for. */
  readonly repeats?: number;
  /** Timestamp of the last of those calls. */
  readonly lastAt?: string;
};

const statusOf = (body: unknown): string => {
  const status =
    typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
  return typeof status === 'string' || typeof status === 'number' ? String(status) : '';
};

/** Same GET, same HTTP status and same purchase status → the same poll answer. */
const pollKey = (x: HttpExchange): string | undefined =>
  x.request.method === 'GET' && x.response !== undefined
    ? `${x.request.url}|${String(x.response.status)}|${statusOf(x.response.body)}`
    : undefined;

/**
 * Status polling (e.g. waiting for the final purchase status while a 3DS page is open)
 * repeats the same GET many times with the same answer. Consecutive identical answers are
 * collapsed into one entry with a `repeats` count; a status change starts a new entry,
 * so every transition (PENDING → PAID …) stays visible.
 */
export function collapsePolls(exchanges: readonly HttpExchange[]): ReportExchange[] {
  const out: { key: string | undefined; entry: ReportExchange }[] = [];
  for (const x of exchanges) {
    const key = pollKey(x);
    const prev = out.at(-1);
    if (key !== undefined && prev?.key === key) {
      prev.entry = { ...prev.entry, repeats: (prev.entry.repeats ?? 1) + 1, lastAt: x.timestamp };
      continue;
    }
    out.push({ key, entry: x });
  }
  return out.map((o) => o.entry);
}
