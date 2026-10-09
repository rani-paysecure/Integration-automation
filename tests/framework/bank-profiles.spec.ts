import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { profileMappingChecks, type BankProfile } from '@helpers/psp-compliance';
import type { BankTransaction } from '../../src/schemas/backoffice.schema';
import * as bankProfiles from '../../config/bank-profiles';

/** A Paysafe Payfac record: no paymentInfo, the payment call is in allOtherRequest. */
const bank = {
  bankName: 'paysafe-payfac',
  paymentInfo: {},
  allOtherRequest: [
    {
      merchantRefNum: 'pid-123',
      amount: 1050,
      currencyCode: 'EUR',
      profile: { firstName: 'Nitendra', lastName: 'Gautam', email: '***' },
      billingDetails: { country: 'US', zip: '99999' },
      paymentFacilitator: {
        subMerchant: {
          name: 'rani gupta',
          id: '418',
          phone: '***',
          email: '***',
          url: 'https://api.paysecure.dev',
        },
      },
    },
  ],
} as unknown as BankTransaction;

const request = {
  client: {
    full_name: 'Nitendra Gautam',
    email: 'n@example.com',
    country: 'GB',
    zip_code: '99999',
  },
  purchase: { currency: 'EUR', total: 10.5 },
};

const profile: BankProfile = {
  id: 'paysafe-payfac',
  bank: 'paysafe-payfac',
  methods: ['VISA'],
  jiraUrl: '',
  docs: [],
  notes: '',
  updatedAt: '',
  mapping: [
    { ours: 'purchase.total', psp: 'amount', check: 'minor-units', mandatory: true, note: '' },
    { ours: 'purchase.currency', psp: 'currencyCode', check: 'equals', mandatory: true, note: '' },
    { ours: '', psp: 'merchantRefNum', check: 'purchase-id', mandatory: true, note: '' },
    { ours: 'client.email', psp: 'profile.email', check: 'masked', mandatory: true, note: '' },
    {
      ours: 'client.country',
      psp: 'billingDetails.country',
      check: 'equals',
      mandatory: true,
      note: '',
    },
    {
      ours: '',
      psp: 'paymentFacilitator.subMerchant.id',
      check: 'present',
      mandatory: true,
      note: '',
    },
    {
      ours: '',
      psp: 'paymentFacilitator.subMerchant.mcc',
      check: 'present',
      mandatory: true,
      note: '',
    },
    { ours: 'client.phone', psp: 'profile.phone', check: 'equals', mandatory: false, note: '' },
  ],
};

test.describe('bank profiles – field mapping our request → PSP request', () => {
  test('each mapped field: match, mismatch (masked display), missing mandatory, optional', () => {
    const { checks } = profileMappingChecks(bank, request, profile, 'pid-123');
    expect(checks.map((c) => [c.name, c.passed, c.actual])).toEqual([
      ['Mapping · purchase.total → amount', true, 'match at allOtherRequest[0].amount'],
      [
        'Mapping · purchase.currency → currencyCode',
        true,
        'match at allOtherRequest[0].currencyCode',
      ],
      ['Mapping · merchantRefNum', true, 'match at allOtherRequest[0].merchantRefNum'],
      [
        'Mapping · client.email → profile.email',
        true,
        'masked at allOtherRequest[0].profile.email',
      ],
      [
        'Mapping · client.country → billingDetails.country',
        false,
        'MISMATCH – we sent "GB", PSP got "US" (allOtherRequest[0].billingDetails.country)',
      ],
      [
        'Mapping · paymentFacilitator.subMerchant.id',
        true,
        'sent at allOtherRequest[0].paymentFacilitator.subMerchant.id',
      ],
      [
        'Mapping · paymentFacilitator.subMerchant.mcc',
        false,
        'MISSING – mandatory field paymentFacilitator.subMerchant.mcc is not in the PSP request',
      ],
      ['Mapping · client.phone → profile.phone', true, 'not sent (optional)'],
    ]);
  });

  test('profiles are stored for the team, matched by bank + method, and refuse credentials', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'));
    process.env.BANK_PROFILES_FILE = path.join(dir, 'bank-profiles.json');
    try {
      bankProfiles.writeProfiles([profile, { ...profile, id: 'paysafe-payfac-all', methods: [] }]);
      expect(bankProfiles.profileFor('Paysafe-Payfac', 'visa')?.id).toBe('paysafe-payfac');
      expect(bankProfiles.profileFor('paysafe-payfac', 'MASTER')?.id).toBe('paysafe-payfac-all');
      expect(bankProfiles.profileFor('other-bank', 'VISA')).toBeUndefined();
      expect(() =>
        bankProfiles.writeProfiles([
          { ...profile, notes: 'Private API Password: B-qa2-0-6564d84d-0-302c' },
        ]),
      ).toThrow(/credentials must not be stored/);
    } finally {
      delete process.env.BANK_PROFILES_FILE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
