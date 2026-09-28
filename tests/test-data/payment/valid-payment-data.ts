import type { CreatePaymentRequest } from '@app-types/payment.types';
import type { DeepPartial } from '@utils/object';

export interface ValidPaymentScenario {
  readonly title: string;
  readonly overrides: DeepPartial<CreatePaymentRequest>;
  /** Dotted paths of optional fields to remove. */
  readonly omit?: readonly string[];
}

/** Happy-path variations applied on top of `buildPaymentRequest`. */
export const validPaymentScenarios: readonly ValidPaymentScenario[] = [
  { title: 'standard card payment', overrides: {} },
  { title: 'payment in EUR', overrides: { currency: 'EUR' } },
  {
    title: 'payment without optional fields',
    overrides: {},
    omit: ['description', 'metadata', 'callbackUrl'],
  },
  {
    title: 'payment with customer phone',
    overrides: { customer: { phone: '+15555550100' } },
  },
];
