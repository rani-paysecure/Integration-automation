import { HttpStatus } from '@constants/http';
import { omitPath, setPath } from '@utils/object';

export interface InvalidPaymentScenario {
  readonly title: string;
  /** Dotted path of the field being broken. */
  readonly field: string;
  /** `undefined` → remove the field; anything else → set it to this value. */
  readonly value?: unknown;
  readonly remove?: boolean;
  readonly expectedStatus: number;
  readonly expectedMessage?: RegExp;
}

/** Negative scenarios: each breaks exactly one field of a valid request. */
export const invalidPaymentScenarios: readonly InvalidPaymentScenario[] = [
  {
    title: 'missing amount',
    field: 'amount',
    remove: true,
    expectedStatus: HttpStatus.BAD_REQUEST,
    expectedMessage: /amount/i,
  },
  {
    title: 'negative amount',
    field: 'amount',
    value: -100,
    expectedStatus: HttpStatus.BAD_REQUEST,
    expectedMessage: /amount/i,
  },
  {
    title: 'amount as string',
    field: 'amount',
    value: '1000',
    expectedStatus: HttpStatus.BAD_REQUEST,
  },
  {
    title: 'unsupported currency',
    field: 'currency',
    value: 'XYZ',
    expectedStatus: HttpStatus.BAD_REQUEST,
    expectedMessage: /currency/i,
  },
  {
    title: 'missing merchant reference',
    field: 'merchantReference',
    remove: true,
    expectedStatus: HttpStatus.BAD_REQUEST,
  },
  {
    title: 'invalid customer email',
    field: 'customer.email',
    value: 'not-an-email',
    expectedStatus: HttpStatus.BAD_REQUEST,
    expectedMessage: /email/i,
  },
  {
    title: 'invalid card number (fails Luhn)',
    field: 'paymentMethod.card.cardNumber',
    value: '4111111111111112',
    expectedStatus: HttpStatus.BAD_REQUEST,
  },
  {
    title: 'expired card',
    field: 'paymentMethod.card.expiryYear',
    value: '2020',
    expectedStatus: HttpStatus.BAD_REQUEST,
  },
];

/** Applies a scenario to a valid request, producing the invalid payload. */
export function toInvalidRequest(
  valid: object,
  scenario: InvalidPaymentScenario,
): Record<string, unknown> {
  return scenario.remove === true
    ? omitPath(valid, scenario.field)
    : setPath(valid, scenario.field, scenario.value);
}
