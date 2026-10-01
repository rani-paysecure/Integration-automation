import type { BackofficeClient } from '../clients/backoffice-client';

/**
 * S2S is only supported for CARD payment methods (APMs are not S2S on PGS). Whether a
 * method is a card comes from the dashboard's Payment Methods page (`is_Card`); without a
 * dashboard login the known card schemes below are used.
 */
export const KNOWN_CARD_METHODS: readonly string[] = [
  'VISA',
  'MASTER',
  'MASTERCARD',
  'AMEX',
  'DISCOVER',
  'JCB',
  'DINERS',
  'MAESTRO',
  'RUPAY',
  'UNIONPAY',
  'SOLO',
];

let dashboardCards: Promise<ReadonlySet<string> | undefined> | undefined;

async function loadDashboardCards(
  backoffice: BackofficeClient,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const raw = await backoffice.rawRequest('GET', '/admin/getAllPaymentMethods');
    const rows = JSON.parse(raw.text) as unknown;
    if (!Array.isArray(rows)) return undefined;
    const cards = (rows as Record<string, unknown>[])
      .filter((r) => String(r.is_Card) === '1')
      .map((r) => (typeof r.name === 'string' ? r.name.trim().toUpperCase() : ''))
      .filter((n) => n !== '');
    return cards.length > 0 ? new Set(cards) : undefined;
  } catch {
    return undefined;
  }
}

/** Card payment method? Dashboard first, known schemes as fallback. */
export async function isCardPaymentMethod(
  method: string,
  backoffice?: BackofficeClient,
): Promise<{ card: boolean; source: 'dashboard' | 'built-in list' }> {
  const wanted = method.trim().toUpperCase();
  if (backoffice !== undefined) {
    dashboardCards ??= loadDashboardCards(backoffice);
    const cards = await dashboardCards;
    if (cards !== undefined) return { card: cards.has(wanted), source: 'dashboard' };
  }
  return { card: KNOWN_CARD_METHODS.includes(wanted), source: 'built-in list' };
}
