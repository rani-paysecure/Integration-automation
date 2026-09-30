#!/usr/bin/env node
// @ts-check
/**
 * Test-case helper for Claude (skill "generate-test-cases") and for QAs:
 *
 *   npm run cases -- spec <category> [--env local]          template columns, allowed values, cards
 *   npm run cases -- context <category> [--env local] [--bank <bank>] [--profile <id>]
 *                                                           what to base new cases on (fields, regexes, cards, existing cases)
 *   npm run cases -- rules <bank> [--env local] [--profile <id>]   field regexes of a bank (dashboard)
 *   npm run cases -- write <category> <rows.json> <out.xlsx> [--env local]   rows → filled, upload-ready template
 *   npm run cases -- check <category> <file.xlsx|csv> [--env local]         validate exactly like the launcher upload
 *   npm run cases -- sync-pgs <path to PGS repo>             refresh config/pgs/country-validation-regex.json
 *
 * Categories: field, regex, psp, edge. Output is JSON / text on stdout.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const settingsCore = require('../../config/settings-core');
const caseImport = require('./test-case-import');
const { buildContext } = require('./ai-generate');
const { DashboardClient } = require('./dashboard');

const ROOT = path.resolve(__dirname, '..', '..');

function args() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--'))
      flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
    else positional.push(rest[i]);
  }
  return { command, positional, flags };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function settings() {
  const result = settingsCore.resolveSettings();
  if (!result.success) fail('config/defaults.json or settings.local.json is invalid');
  return result.data;
}

function category(id) {
  const c = caseImport.CATEGORIES[id];
  if (!c) fail(`Unknown category "${id}" – use field, regex, psp or edge`);
  return c;
}

const envOf = (flags) => (flags.env === 'uat' ? 'uat' : 'local');

function cardsFor(env) {
  return (settings().cards[env] || []).map((c) => ({
    id: c.id,
    label: c.label,
    expectedOutcome: c.expectedOutcome,
    expectedStatuses: c.expectedStatuses,
    challenge: c.challenge,
  }));
}

/** Dashboard client with the tester's login from profiles.local.json (this computer only). */
function dashboard(env, profileId) {
  let profiles = [];
  try {
    profiles =
      JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles.local.json'), 'utf8')).profiles || [];
  } catch {
    fail(
      'profiles.local.json not found – add a tester with a dashboard login in the launcher first',
    );
  }
  const profile = profiles.find((p) =>
    profileId ? p.id === profileId : p.environments?.[env]?.dashboard?.password,
  );
  const creds = profile?.environments?.[env]?.dashboard;
  if (!creds?.username || !creds?.password)
    fail(
      `No tester with a ${env.toUpperCase()} dashboard login${profileId ? ` (profile "${profileId}")` : ''}`,
    );
  const baseUrl = settings().environments[env].baseUrl;
  if (!baseUrl) fail(`No dashboard URL for ${env.toUpperCase()}`);
  return new DashboardClient({ baseUrl, username: creds.username, password: creds.password });
}

async function main() {
  const { command, positional, flags } = args();
  const env = envOf(flags);

  if (command === 'spec') {
    const id = positional[0];
    const c = category(id);
    const cardIds = cardsFor(env).map((x) => x.id);
    process.stdout.write(
      `${JSON.stringify(
        {
          category: id,
          label: c.label,
          idPrefix: c.prefix,
          description: c.description,
          columns: c.columns.map((col) => ({
            key: col.key,
            header: col.header,
            required: col.required,
            guide: col.guide,
            ...(col.options ? { allowed: col.options === 'cards' ? cardIds : col.options } : {}),
            example: col.example,
          })),
          exampleRows: c.examples,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === 'rules') {
    const bank = positional[0];
    if (!bank) fail('Usage: rules <bank> [--env local]');
    const rules = await dashboard(env, flags.profile).fieldRules(bank);
    process.stdout.write(`${JSON.stringify({ bank, rules }, null, 2)}\n`);
    return;
  }

  if (command === 'context') {
    const id = positional[0];
    category(id);
    const s = settings();
    const ctx = { cards: cardsFor(env), purchaseTemplate: s.purchase[env], existing: [] };
    if (id === 'regex') {
      if (!flags.bank) fail('Regex context needs --bank <bank>');
      ctx.bank = flags.bank;
      ctx.rules = await dashboard(env, flags.profile).fieldRules(flags.bank);
      for (const c of caseImport.loadCases('regex'))
        if (!c.bank || c.bank === flags.bank) ctx.existing.push(`${c.field} = ${c.value}`);
    } else if (id === 'field') {
      for (const c of caseImport.builtinFieldCases()) {
        const v = c.mutation?.type === 'set' ? JSON.stringify(c.mutation.value) : c.mutation?.type;
        ctx.existing.push(`${c.path} = ${String(v).slice(0, 40)} → ${c.expectation}`);
      }
      for (const c of caseImport.loadCases('field')) ctx.existing.push(`${c.path} – ${c.title}`);
    } else {
      for (const c of caseImport.loadCases(id)) ctx.existing.push(c.title);
    }
    process.stdout.write(`${buildContext(id, ctx)}\n`);
    return;
  }

  if (command === 'write') {
    const [id, input, output] = positional;
    const c = category(id);
    if (!input || !output) fail('Usage: write <category> <rows.json> <out.xlsx>');
    const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
    const list = Array.isArray(rows) ? rows : rows.cases;
    if (!Array.isArray(list) || list.length === 0)
      fail('rows.json must be a non-empty array of rows');
    // Start from the real template (styles, dropdowns, guide) and replace the example rows.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      Buffer.from(
        await caseImport.templateBuffer(
          id,
          cardsFor(env).map((x) => x.id),
        ),
      ),
    );
    const sheet = wb.getWorksheet('Test Cases');
    if (!sheet) fail('Template has no "Test Cases" sheet');
    // Replace the example rows; rows 2–500 already exist (they carry the dropdowns).
    const cellValue = (row, col) => {
      const v = row[col.key] ?? row[col.header] ?? '';
      return typeof v === 'string' ? v : String(v);
    };
    const total = Math.max(list.length, c.examples.length);
    for (let i = 0; i < total; i++) {
      const target = sheet.getRow(2 + i);
      c.columns.forEach((col, n) => {
        target.getCell(n + 1).value = i < list.length ? cellValue(list[i], col) : null;
      });
      target.alignment = { vertical: 'top', wrapText: true };
      target.font = { name: 'Calibri', size: 11 };
    }
    await wb.xlsx.writeFile(output);
    process.stdout.write(`Wrote ${list.length} row(s) to ${output}\n`);
    return;
  }

  if (command === 'sync-pgs') {
    const repo = positional[0];
    if (!repo) fail('Usage: sync-pgs <path to the PGS repo>');
    const source = path.join(repo, 'src', 'main', 'resources', 'country-validation-regex.json');
    if (!fs.existsSync(source)) fail(`Not found: ${source}`);
    JSON.parse(fs.readFileSync(source, 'utf8')); // must be valid JSON
    const target = path.join(ROOT, 'config', 'pgs', 'country-validation-regex.json');
    const changed =
      !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== fs.readFileSync(source, 'utf8');
    if (changed) fs.copyFileSync(source, target);
    process.stdout.write(
      changed ? `Updated ${path.relative(ROOT, target)}\n` : 'Catalog already up to date\n',
    );
    return;
  }

  if (command === 'check') {
    const [id, file] = positional;
    category(id);
    if (!file) fail('Usage: check <category> <file.xlsx|csv>');
    const preview = await caseImport.previewImport(
      id,
      fs.readFileSync(file),
      path.basename(file),
      cardsFor(env).map((x) => x.id),
    );
    const ok = preview.cases.filter((x) => x.include).length;
    const lines = preview.cases.map((x) => {
      const state = x.issues.length ? 'FIX ' : x.duplicate ? 'DUP ' : 'OK  ';
      const notes = [...x.issues, ...x.warnings].join(' · ');
      return `${state} row ${x.rows.join(',')}: ${x.display.join(' | ').replace(/\n/g, ' / ')}${notes ? `  → ${notes}` : ''}`;
    });
    process.stdout.write(
      `${lines.join('\n')}\n\n${preview.cases.length} case(s): ${ok} ready to add, ${preview.cases.filter((x) => x.duplicate).length} duplicate(s), ${preview.cases.filter((x) => x.issues.length).length} to fix\n`,
    );
    process.exit(preview.cases.some((x) => x.issues.length) ? 2 : 0);
  }

  process.stdout.write(
    fs
      .readFileSync(__filename, 'utf8')
      .split('\n')
      .slice(2, 15)
      .map((l) => l.replace(/^ \*\s?/, ''))
      .join('\n') + '\n',
  );
}

main().catch((error) => fail(error.message));
