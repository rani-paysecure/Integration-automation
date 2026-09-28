import { expect, test } from '@playwright/test';
import { applyFieldCase, describeTestData, type FieldTestCase } from '@helpers/field-testing';
import { omitPath, setPath } from '@utils/object';

const baseline = {
  client: { phone: '+436601234567', country: 'AT' },
  purchase: { products: [{ name: 'Gaming Cards', price: 2 }], total: 2 },
};

const caseOf = (overrides: Partial<FieldTestCase>): FieldTestCase => ({
  id: 'T-1',
  parameter: 'client.phone',
  path: 'client.phone',
  title: 'x',
  mutation: { type: 'none' },
  expectation: 'observe',
  expectedResult: '',
  ...overrides,
});

test.describe('Field-testing engine', () => {
  test('setPath / omitPath address array items by index', () => {
    expect(setPath(baseline, 'purchase.products.0.price', 'ten')).toMatchObject({
      purchase: { products: [{ name: 'Gaming Cards', price: 'ten' }] },
    });
    expect(omitPath(baseline, 'purchase.products.0.name')).toMatchObject({
      purchase: { products: [{ price: 2 }] },
    });
    expect(baseline.purchase.products[0]?.price).toBe(2); // input untouched
  });

  test('applies context first, then the mutation', () => {
    const request = applyFieldCase(
      baseline,
      caseOf({
        mutation: { type: 'set', value: '+919876543210' },
        context: { 'client.country': 'DE' },
      }),
    );
    expect(request).toMatchObject({ client: { phone: '+919876543210', country: 'DE' } });
  });

  test('remove and none mutations', () => {
    expect(applyFieldCase(baseline, caseOf({ mutation: { type: 'remove' } }))).not.toHaveProperty(
      'client.phone',
    );
    expect(applyFieldCase(baseline, caseOf({}))).toEqual(baseline);
  });

  test('describes test data for the report', () => {
    expect(describeTestData(caseOf({ mutation: { type: 'remove' } }))).toBe('(field not sent)');
    expect(
      describeTestData(
        caseOf({ mutation: { type: 'set', value: 'ten' }, context: { 'purchase.total': 'ten' } }),
      ),
    ).toBe('"ten" | purchase.total="ten"');
  });
});
