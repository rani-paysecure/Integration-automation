import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

interface ImportedCard {
  number: string;
  scheme: string;
  group: string;
  label: string;
  expiry: string;
  cvv: string;
  expectedOutcome: string;
  expectedStatuses: string[];
  challenge: string;
}
interface CardImport {
  extractCards: (source: string) => {
    title: string;
    defaults: { expiry: string; cvv: string; expiryFound: boolean; cvvFound: boolean };
    cards: ImportedCard[];
  };
  luhn: (digits: string) => boolean;
}

const { extractCards, luhn } = createRequire(__filename)(
  '../../tools/launcher/card-import.js',
) as CardImport;

// Shape of a PSP help page: a title row (colspan), a header row and a rowspan "result" cell.
const PAGE = `<html><head><title>PSP 3DS testing</title></head><body>
<p>Use CVV 123 and any future expiry date.</p>
<table>
  <tr><td colspan="3">(3DSv2) Test Case 1: Successful Frictionless 3D Secure Authentication &amp; Successful Authorisation. Cardholder authenticated.</td></tr>
  <tr><th>Card type</th><th>Number</th><th>Result</th></tr>
  <tr><td>VISA</td><td>4000 0000 0000 0002</td><td rowspan="2">AUTH Error code: 0 – Ok</td></tr>
  <tr><td>MASTERCARD</td><td>5555555555554444</td></tr>
</table>
<h3>Test Case 9: Failed Step Up 3D Secure Authentication &amp; No Authorisation</h3>
<table>
  <tr><th>Card type</th><th>Number</th></tr>
  <tr><td>AMEX</td><td>378282246310005</td></tr>
  <tr><td>Not a card</td><td>1234567890123</td></tr>
</table></body></html>`;

test.describe('Test card import (PSP test-card pages)', () => {
  test('Luhn check', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
  });

  test('reads cards from HTML tables with titles, rowspan and outcome hints', () => {
    const { title, defaults, cards } = extractCards(PAGE);
    expect(title).toBe('PSP 3DS testing');
    expect(defaults.cvv).toBe('123');
    expect(cards.map((c) => c.number)).toEqual([
      '4000000000000002',
      '5555555555554444',
      '378282246310005',
    ]);
    const [visa, master, amex] = cards as [ImportedCard, ImportedCard, ImportedCard];
    expect(visa.scheme).toBe('VISA');
    expect(master.scheme).toBe('MASTERCARD');
    expect(visa.group).toBe(
      'Successful Frictionless 3D Secure Authentication & Successful Authorisation',
    );
    expect(visa.label).toBe('Visa – Successful Frictionless 3DS & Successful auth');
    expect(visa.expectedOutcome).toBe('success-redirect');
    expect(visa.expectedStatuses).toEqual(['PAID']);
    expect(visa.challenge).toBe('none');
    expect(amex.expectedOutcome).toBe('failure-redirect');
    expect(amex.expectedStatuses).toEqual(['ERROR']);
    expect(amex.challenge).toBe('manual');
  });

  test('reads cards from pasted plain text', () => {
    const { cards } = extractCards(
      'Visa approved 4111 1111 1111 1111 exp 11/31\nMastercard declined 5555-5555-5555-4444',
    );
    expect(cards.map((c) => [c.scheme, c.number, c.expectedOutcome, c.expiry])).toEqual([
      ['VISA', '4111111111111111', 'success-redirect', '11/31'],
      ['MASTERCARD', '5555555555554444', 'failure-redirect', cards[1]?.expiry],
    ]);
  });
});
