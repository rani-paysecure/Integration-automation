import { HttpStatus } from '@constants/http';
import type { EnvironmentTestData } from '../environments';

export interface BoundaryScenario {
  readonly title: string;
  readonly field: string;
  readonly value: unknown;
  readonly expectedStatus: number;
}

/**
 * Boundary values are derived from environment limits, because LOCAL and UAT
 * can be configured with different merchant limits.
 */
export function amountBoundaryScenarios(envData: EnvironmentTestData): readonly BoundaryScenario[] {
  const { minAmount, maxAmount } = envData.limits;
  return [
    { title: 'amount = 0', field: 'amount', value: 0, expectedStatus: HttpStatus.BAD_REQUEST },
    {
      title: 'amount = min - 1',
      field: 'amount',
      value: minAmount - 1,
      expectedStatus: HttpStatus.BAD_REQUEST,
    },
    {
      title: 'amount = min',
      field: 'amount',
      value: minAmount,
      expectedStatus: HttpStatus.CREATED,
    },
    {
      title: 'amount = max',
      field: 'amount',
      value: maxAmount,
      expectedStatus: HttpStatus.CREATED,
    },
    {
      title: 'amount = max + 1',
      field: 'amount',
      value: maxAmount + 1,
      expectedStatus: HttpStatus.BAD_REQUEST,
    },
  ];
}

export const DESCRIPTION_MAX_LENGTH = 255;

export const descriptionBoundaryScenarios: readonly BoundaryScenario[] = [
  {
    title: 'description at max length',
    field: 'description',
    value: 'a'.repeat(DESCRIPTION_MAX_LENGTH),
    expectedStatus: HttpStatus.CREATED,
  },
  {
    title: 'description over max length',
    field: 'description',
    value: 'a'.repeat(DESCRIPTION_MAX_LENGTH + 1),
    expectedStatus: HttpStatus.BAD_REQUEST,
  },
];
