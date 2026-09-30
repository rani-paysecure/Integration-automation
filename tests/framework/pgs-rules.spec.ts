import { expect, test } from '@playwright/test';
import { evaluatePgsRule } from '@helpers/pgs-rules';

/** Port of PGS ClientDetailsValidator – expectations taken from the Java code. */
test.describe('PGS field-regex rules (port of ClientDetailsValidator)', () => {
  const countryList = '["IN", "US", "GB", "default"]';

  test('flat regex: whole value must match (Java String.matches), "NA" is invalid', () => {
    expect(evaluatePgsRule('city', 'Vienna', '^[A-Za-z][A-Za-z\\s\\-]{1,}$', 'AT').verdict).toBe(
      'valid',
    );
    expect(evaluatePgsRule('city', 'Wien1', '^[A-Za-z][A-Za-z\\s\\-]{1,}$', 'AT').verdict).toBe(
      'invalid',
    );
    expect(evaluatePgsRule('stateCode', 'AB', '[A-Z]', 'AT').verdict).toBe('invalid');
    expect(evaluatePgsRule('city', 'NA', '.*', 'AT').verdict).toBe('invalid');
    expect(
      evaluatePgsRule('full_name', 'NULL', '^(?i)(?!n/?a$|null$).{2,120}$', 'AT').verdict,
    ).toBe('invalid');
  });

  test('country list: listed country uses its catalog regex, others the catalog default', () => {
    expect(evaluatePgsRule('phone', '+436641112233', countryList, 'AT')).toMatchObject({
      verdict: 'valid',
      source: 'catalog default',
    });
    expect(evaluatePgsRule('phone', '12345', countryList, 'AT').verdict).toBe('invalid');
    expect(evaluatePgsRule('phone', '9876543210', countryList, 'IN')).toMatchObject({
      verdict: 'valid',
      source: 'catalog IN',
      sentValue: '+919876543210',
    });
    expect(evaluatePgsRule('phone', '987654321', countryList, 'IN').verdict).toBe('invalid');
    expect(evaluatePgsRule('phone', '+929876543210', countryList, 'IN').sentValue).toBe(
      '+919876543210',
    );
    expect(evaluatePgsRule('phone', '+436641112233', '["IN"]', 'AT').verdict).toBe('invalid');
  });

  test('object rule: enabled country from the catalog, bank default otherwise', () => {
    const rule = '{"enable":["IN"],"default":"^\\\\d{5,}$"}';
    expect(evaluatePgsRule('phone', '9876543210', rule, 'IN').source).toBe('catalog IN');
    expect(evaluatePgsRule('phone', '12345', rule, 'AT')).toMatchObject({
      verdict: 'valid',
      source: 'bank default',
    });
    expect(evaluatePgsRule('phone', '1234', rule, 'AT').verdict).toBe('invalid');
  });

  test('malformed rules force a replacement', () => {
    expect(evaluatePgsRule('city', 'Vienna', '([', 'AT').verdict).toBe('invalid');
    expect(evaluatePgsRule('phone', '1', '[not json', 'AT').verdict).toBe('invalid');
  });
});
