import { test } from '@playwright/test';
import { getSettings } from '@config/settings';
import { resolveChallenge } from '@helpers/three-ds-flows';
import type { TestEnvironment } from '@app-types/config.types';
import type { CashierCard, CashierCardScenario } from '@app-types/cashier.types';

/**
 * Card scenarios for the cashier (hosted checkout) payment.
 *
 * Managed in the launcher ("Test cards" tab) → settings.local.json, with team
 * defaults in config/defaults.json. Extra cards can also come from env vars:
 *   UAT_CARD_APPROVED=<number>|<MM/YY>|<cvv>
 *   UAT_CARD_DECLINED=<number>|<MM/YY>|<cvv>
 * CASHIER_CARDS=id1,id2 limits a run to some scenarios. Test cards only.
 */
function cardFromEnv(name: string, holderName: string): CashierCard | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const [number, expiry, cvv] = raw.split('|').map((part) => part.trim());
  if (!number || !expiry || !cvv) {
    throw new Error(`${name} must look like <number>|<MM/YY>|<cvv>`);
  }
  return { number: number.replace(/\s/g, ''), expiry, cvv, holderName };
}

export function cashierCardScenarios(env: TestEnvironment): CashierCardScenario[] {
  const prefix = env.toUpperCase();
  const scenarios: CashierCardScenario[] = getSettings()
    .cards[env].filter((card) => card.enabled)
    .map((card) => ({
      id: card.id,
      label: card.label,
      card: {
        number: card.number,
        expiry: card.expiry,
        cvv: card.cvv,
        holderName: card.holderName,
        challenge: resolveChallenge(card.challenge),
      },
      expected: { outcome: card.expectedOutcome, statuses: card.expectedStatuses },
    }));

  const approved = cardFromEnv(`${prefix}_CARD_APPROVED`, 'Test Approved');
  if (approved) {
    scenarios.push({
      id: 'env-approved',
      label: 'Approved card (.env)',
      card: approved,
      expected: { outcome: 'success-redirect', statuses: ['PAID'] },
    });
  }
  const declined = cardFromEnv(`${prefix}_CARD_DECLINED`, 'Test Declined');
  if (declined) {
    scenarios.push({
      id: 'env-declined',
      label: 'Declined card (.env)',
      card: declined,
      expected: { outcome: 'failure-redirect', statuses: ['ERROR'] },
    });
  }

  const selected = (process.env.CASHIER_CARDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return scenarios.filter((scenario) => selected.length === 0 || selected.includes(scenario.id));
}

/** Looks up one card scenario (enabled or not) by id, e.g. the "pay with" card of a run. */
export function findCardScenario(
  env: TestEnvironment,
  id: string,
): CashierCardScenario | undefined {
  const card = getSettings().cards[env].find((candidate) => candidate.id === id);
  if (card === undefined) return undefined;
  return {
    id: card.id,
    label: card.label,
    card: {
      number: card.number,
      expiry: card.expiry,
      cvv: card.cvv,
      holderName: card.holderName,
      challenge: resolveChallenge(card.challenge),
    },
    expected: { outcome: card.expectedOutcome, statuses: card.expectedStatuses },
  };
}

/**
 * Card for an uploaded PSP / edge case: the case's own card, otherwise the
 * "pay with" card selected on the Run tab. Undefined → the test is skipped.
 */
export function resolveCaseCard(
  env: TestEnvironment,
  caseCard: string | undefined,
  runCard: string | undefined,
): { scenario?: CashierCardScenario; problem?: string } {
  const id = caseCard ?? runCard;
  if (id === undefined || id === '') {
    return {
      problem: 'No card: set "Card" in the sheet or choose a "pay with" card on the Run tab',
    };
  }
  const scenario = findCardScenario(env, id);
  return scenario ? { scenario } : { problem: `Test card "${id}" is not on the Test cards tab` };
}

/** Like `resolveCaseCard`, but skips the running test when no card can be used. */
export function requireCaseCard(
  env: TestEnvironment,
  caseCard: string | undefined,
  runCard: string | undefined,
): CashierCardScenario {
  const { scenario, problem } = resolveCaseCard(env, caseCard, runCard);
  if (scenario !== undefined) return scenario;
  test.skip(true, problem);
  throw new Error(problem);
}
