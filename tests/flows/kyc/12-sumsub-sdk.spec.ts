import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@fixtures/kyc.fixture';
import { getKyc, must } from '@test-data/kyc/kyc';

const DOCUMENT = resolve(__dirname, '../../test-data/kyc/sandbox-document.jpg');

// The SDK asks for the camera: grant it up front and let Chrome's fake device supply frames.
test.use({
  permissions: ['camera'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
  },
});

/**
 * The provider half of the happy path: driving Sumsub's WebSDK.
 *
 * Every selector below was read off the live sandbox with the inspector in
 * `99-inspect-sdk.spec.ts`, not guessed. When Sumsub changes their UI and this
 * breaks, run the inspector again rather than editing selectors by trial:
 *
 *   npm run docker:inspect
 *
 * The flow, as it actually is:
 *
 *   0. "Verification for approvely.com"            -> Continue
 *   1. dialog "Consent to start verification"      -> Agree and continue
 *   2. "Let's get you verified"                    -> turn OFF Sumsub ID, Start verification
 *   3. "Select type and issuing country ..."       -> Passport, Continue
 *   4. "Upload your document"                      -> set the file input
 *   5. liveness check                              -> NOT automatable, see below
 *
 * Step 2 is the one that matters. The "Get verified faster with Sumsub ID" switch
 * is ON by default, and leaving it on sends the subject to "Verify your email to
 * use Sumsub ID" — a six-digit code emailed before document capture can even
 * start. Turning it off goes straight to the document step.
 *
 * A failure here is usually Sumsub, not us. It is our bug only if the SDK never
 * mounts at all, or the access token is rejected — everything else is their UI.
 */
test.describe('KYC verification › 12. Sumsub WebSDK @sumsub', () => {
  test.skip(
    !existsSync(DOCUMENT),
    'data/sandbox-document.jpg is missing — add a sample ID image to drive the upload',
  );

  test(
    'KYC-34 · given the hosted page, when the subject completes document capture, then the record leaves AWAITING_USER',
    { tag: '@KYC-34' },
    async ({ api, page, newCustomer, newKyc }) => {
      test.setTimeout(300_000);

      const customer = await newCustomer();
      const created = await newKyc({ customer_id: customer.customerId });

      await page.goto(must(created.verification_url, 'verification_url'));

      // Our own contract first: opening the page is what moves the record.
      await expect
        .poll(async () => (await getKyc(api, created.kyc_id)).status, {
          timeout: 30_000,
        })
        .toBe('KYC_PENDING');

      // If this never appears, the access token or the level name is wrong — that is
      // ours, and the only failure in this file that is.
      const sdk = page.locator('iframe').first();
      await expect(sdk, 'the Sumsub SDK never mounted').toBeVisible({ timeout: 45_000 });
      const frame = page.locator('iframe').first().contentFrame();

      // --- 0. the "you are about to submit sensitive data" screen ----------------
      await frame.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 30_000 });

      // --- 1. the consent dialog --------------------------------------------------
      await frame.getByRole('button', { name: 'Agree and continue' }).click({ timeout: 30_000 });

      // --- 2. turn off Sumsub ID, or the flow diverts to an emailed code ---------
      const sumsubId = frame.getByRole('switch', { name: /Sumsub ID/i });
      await expect(sumsubId).toBeVisible({ timeout: 30_000 });
      if (await sumsubId.isChecked()) {
        await sumsubId.click();
      }
      await expect(
        sumsubId,
        'Sumsub ID still on — the flow will ask for an emailed code',
      ).not.toBeChecked();

      await frame.getByRole('button', { name: 'Start verification' }).click();

      // --- 3. document type. Continue stays disabled until one is chosen ---------
      await expect(
        frame.getByRole('heading', { name: /identity document/i }),
        'never reached the document step',
      ).toBeVisible({ timeout: 60_000 });

      // The issuing country is prefilled from the country on the record, which is
      // our {{customer.country}} mapping arriving intact at the provider.
      await expect(frame.getByRole('button', { name: /Issuing country/i })).toBeVisible();

      await frame.getByRole('radio', { name: 'Passport' }).click();
      await frame.getByRole('button', { name: 'Continue', exact: true }).click();

      // --- 4. upload -------------------------------------------------------------
      await expect(frame.getByRole('heading', { name: /Upload your document/i })).toBeVisible({
        timeout: 60_000,
      });
      // The visible control is a styled dropzone; set the real input directly.
      await frame.locator('input[type="file"]').first().setInputFiles(DOCUMENT);
      await frame.getByRole('button', { name: /Upload document/i }).click();

      // Prove the upload was accepted rather than silently ignored: the SDK leaves the
      // upload heading and moves on. Without this the test passes on the clicks alone.
      await expect(
        frame.getByRole('heading', { name: /Upload your document/i }),
        'still on the upload step — the document was not accepted',
      ).toBeHidden({ timeout: 60_000 });

      const afterUpload = await frame
        .getByRole('heading')
        .first()
        .textContent()
        .catch(() => null);
      test.info().annotations.push({
        type: 'note',
        description: `after upload, the SDK shows: ${JSON.stringify(afterUpload)}`,
      });

      // --- 5. liveness is where automation stops ---------------------------------
      // The second step is a liveness check against the camera. Chromium's fake
      // device feeds a synthetic pattern, which Sumsub will not accept as a face, so
      // the run cannot reach a GREEN verdict unattended. What we assert is that our
      // side is still tracking correctly at the boundary.
      const record = await getKyc(api, created.kyc_id);
      expect(record.provider_reference_id).toBe(created.provider_reference_id);
      expect(['KYC_PENDING', 'KYC_IN_PROCESS', 'MANUAL_REVIEW']).toContain(record.status);

      test.info().annotations.push({
        type: 'seed',
        description:
          `reached liveness · status=${record.status} customerId=${customer.customerId} ` +
          `merchantCustomerId=${customer.merchantCustomerId} kycId=${record.kyc_id} — ` +
          'finish the liveness step by hand in a headed browser to produce a verdict ' +
          'for the fixme cases in 03-guards and 11-callbacks',
      });
    },
  );
});
