import fs from 'node:fs';
import { expect, test } from '@playwright/test';

/** Same recording setup as openCashierPage (Run tab → Record payment video). */
test('a payment page is recorded to a .webm the report can offer once', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 640, height: 400 },
    recordVideo: { dir: testInfo.outputPath('video'), size: { width: 640, height: 400 } },
  });
  const page = await context.newPage();
  await page.setContent(
    '<h1>3DS Simulator</h1><select><option>Approve</option></select><button>Submit</button>',
  );
  await page.waitForTimeout(500);
  await page.close();
  const video = page.video();
  await context.close();
  const file = (await video?.path()) ?? '';
  expect(file.endsWith('.webm')).toBe(true);
  expect(fs.statSync(file).size).toBeGreaterThan(1000);
});
