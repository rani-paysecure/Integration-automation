import { getSettings } from '../../config/settings';
import type { ChallengeSetting, ResolvedThreeDsFlow } from '../types/cashier.types';

type Flow = ReturnType<typeof getSettings>['threeDsFlows']['flows'][number];

/** {otp}, {sortCode} … → the flow's 3DS detail values. Unknown keys stay as written. */
function fill(value: string, details: Flow['details']): string {
  return value.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const detail = details.find((d) => d.key.toLowerCase() === key.toLowerCase());
    return detail === undefined ? whole : detail.value;
  });
}

/** What the report shows for a typed value: the detail's label, never the value itself. */
function shownValue(value: string, details: Flow['details']): string {
  const keys = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
  if (keys.length === 0) return value === '' ? '' : 'typed value';
  return keys
    .map((k) => {
      const label = details.find((d) => d.key.toLowerCase() === k.toLowerCase())?.label ?? '';
      return label === '' ? k : label;
    })
    .join(' + ');
}

/** The scenario a card points to, steps resolved – or undefined when it no longer exists. */
export function resolveThreeDsFlow(
  flowId: string,
  scenarioId: string,
  flows: readonly Flow[] = getSettings().threeDsFlows.flows,
): ResolvedThreeDsFlow | undefined {
  const flow = flows.find((f) => f.id === flowId);
  const scenario = flow?.scenarios.find((s) => s.id === scenarioId);
  if (flow === undefined || scenario === undefined) return undefined;
  return {
    bank: flow.label || flow.bank,
    scenario: scenario.name,
    outcome: scenario.outcome,
    steps: scenario.steps.map((step) => ({
      action: step.action,
      target: step.target,
      value: fill(step.value, flow.details),
      shown: step.action === 'fill' ? shownValue(step.value, flow.details) : step.value,
    })),
  };
}

/** Card 3DS setting → what the cashier page runs (a "flow" card gets its scenario's steps). */
export function resolveChallenge(challenge: ChallengeSetting): ChallengeSetting {
  if (challenge.action !== 'flow') return challenge;
  return {
    ...challenge,
    flow: resolveThreeDsFlow(challenge.flowId ?? '', challenge.scenarioId ?? ''),
  };
}
