// @ts-check
/**
 * "⬇ Videos (zip)" on the Report: every recorded payment video of a run in one .zip, each named
 * after its purchase ID. Store-only zip (videos are already compressed), streamed file by file –
 * no extra dependency. One-time: the launcher deletes each video once it is in the zip.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(/** @type {Buffer} */ buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time of now (zip headers). */
function dosStamp(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Videos of a report: [{ file (absolute), name (in the zip) }] – files that still exist.
 * Names: <purchaseId>.webm (or the test title when there is no purchase), -2, -3 … when repeated.
 */
function reportVideos(/** @type {any} */ report, /** @type {string} */ root) {
  const base = path.resolve(root, 'test-results') + path.sep;
  const used = new Set();
  /** @type {{ file: string, name: string }[]} */
  const out = [];
  for (const t of report.tests || []) {
    for (const rel of t.videos || []) {
      const file = path.resolve(root, String(rel));
      if (!file.startsWith(base) || !/\.webm$/i.test(file) || !fs.existsSync(file)) continue;
      const stem =
        String(t.purchaseId || '').trim() ||
        String(t.title || 'payment')
          .replace(/[^\w.-]+/g, '_')
          .slice(0, 60);
      let name = `${stem}.webm`;
      for (let n = 2; used.has(name); n += 1) name = `${stem}-${String(n)}.webm`;
      used.add(name);
      out.push({ file, name });
    }
  }
  return out;
}

/** Streams the zip to `res` and deletes each video once written. Returns how many were zipped. */
async function streamVideoZip(
  /** @type {import('node:http').ServerResponse} */ res,
  /** @type {{ file: string, name: string }[]} */ videos,
) {
  const { time, date } = dosStamp();
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  const write = (/** @type {Buffer} */ chunk) =>
    new Promise((resolve) => {
      if (!res.write(chunk)) res.once('drain', resolve);
      else resolve(undefined);
    });
  for (const v of videos) {
    const data = fs.readFileSync(v.file);
    const name = Buffer.from(v.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local);
    await write(name);
    await write(data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
    fs.rm(v.file, { force: true }, () => undefined); // one-time
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(videos.length, 8);
  end.writeUInt16LE(videos.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(dir);
  res.end(end);
  return videos.length;
}

module.exports = { reportVideos, streamVideoZip, crc32 };
