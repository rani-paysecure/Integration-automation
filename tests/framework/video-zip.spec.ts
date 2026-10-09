import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- launcher module (CommonJS)
const videoZip = require('../../tools/launcher/video-zip.js') as {
  reportVideos: (report: unknown, root: string) => { file: string; name: string }[];
  streamVideoZip: (res: PassThrough, videos: { file: string; name: string }[]) => Promise<number>;
  crc32: (buf: Buffer) => number;
};

test('payment videos zip: named by purchase ID, only test-results files, valid zip, one-time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-'));
  const dir = path.join(root, 'test-results', 'run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.webm'), 'AAAA');
  fs.writeFileSync(path.join(dir, 'b.webm'), 'BBBBBB');
  fs.writeFileSync(path.join(root, 'secret.webm'), 'X');
  const report = {
    tests: [
      { purchaseId: 'pid-1', title: 'a', videos: ['test-results/run/a.webm', 'secret.webm'] },
      { purchaseId: 'pid-1', title: 'b', videos: ['test-results/run/b.webm'] },
    ],
  };
  const videos = videoZip.reportVideos(report, root);
  expect(videos.map((v) => v.name)).toEqual(['pid-1.webm', 'pid-1-2.webm']);
  expect(videoZip.crc32(Buffer.from('123456789'))).toBe(0xcbf43926);

  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  expect(await videoZip.streamVideoZip(sink, videos)).toBe(2);
  const zip = Buffer.concat(chunks);
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  expect(zip.includes(Buffer.from('pid-1-2.webm'))).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(dir, 'a.webm'))).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});
