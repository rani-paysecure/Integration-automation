// @ts-check
/**
 * Test execution report as one Excel workbook (for sharing with the team lead):
 *   "Summary" – run details, overall result, results per category, failed tests, legend
 *   "Results" – every test: category, case, positive/negative, result, expected, actual, IDs
 * Built from the launcher report (reports/ui/*.json), which is already masked.
 */
'use strict';

const ExcelJS = require('exceljs');

const CATEGORY_ORDER = [
  'field',
  'regex',
  'psp',
  'edge',
  'card',
  'refund',
  'bank-config',
  's2s',
  'kyc',
  'psp-check',
  'other',
];
const CATEGORY_NAMES = {
  field: 'Field validation',
  regex: 'Regex validation',
  psp: 'PSP request / response',
  edge: 'Custom & edge cases',
  card: 'Card transactions',
  refund: 'Refunds',
  'bank-config': 'Bank & MID configuration',
  s2s: 'S2S purchase',
  kyc: 'KYC verification',
  'psp-check': 'PSP check (existing purchases)',
  other: 'Other',
};
const RESULT_TEXT = { PASS: 'PASSED', FAIL: 'FAILED', OBSERVED: 'OBSERVED', SKIPPED: 'SKIPPED' };
const TYPE_TEXT = { positive: 'Positive', negative: 'Negative', neutral: 'Informational' };

const COLORS = {
  ink: 'FF1F2A44',
  muted: 'FF667085',
  headerFill: 'FF1F2A44',
  subtleFill: 'FFF2F4F7',
  border: 'FFD0D5DD',
  pass: 'FF1A7F4B',
  passFill: 'FFE3F4EA',
  fail: 'FFB42318',
  failFill: 'FFFDE7E4',
  failRow: 'FFFFF6F5',
  warn: 'FF9A6700',
  warnFill: 'FFFDF3D8',
  skipFill: 'FFEEF0F3',
};
const RESULT_STYLE = {
  PASS: { font: COLORS.pass, fill: COLORS.passFill },
  FAIL: { font: COLORS.fail, fill: COLORS.failFill },
  OBSERVED: { font: COLORS.warn, fill: COLORS.warnFill },
  SKIPPED: { font: COLORS.muted, fill: COLORS.skipFill },
};
const thin = { style: 'thin', color: { argb: COLORS.border } };
const box = { top: thin, bottom: thin, left: thin, right: thin };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function categoryFromKey(key) {
  if (/^@(FT|FV)-/.test(key)) return 'field';
  if (key.startsWith('@RX-')) return 'regex';
  if (key.startsWith('@PR-')) return 'psp';
  if (key.startsWith('@EC-')) return 'edge';
  if (key.startsWith('@card-')) return 'card';
  if (/^@(RF|RC)-/.test(key)) return 'refund';
  if (/^@(BM|BC)-/.test(key)) return 'bank-config';
  if (/^@(S2S|S2|s2s-card)-/.test(key)) return 's2s';
  if (/^@(KYC|KV)-/.test(key)) return 'kyc';
  if (key === '@psp-by-id' || key === '@backoffice-smoke') return 'psp-check';
  return 'other';
}

/** Same fallbacks as the launcher view, so older reports export too. */
function normalise(t) {
  const category = t.category || categoryFromKey(t.key);
  return {
    ...t,
    category,
    polarity: t.polarity || 'neutral',
    caseId: /^@(FT|FV|RX|PR|EC|RF|RC|BM|BC|S2S|S2|KYC|KV)-/.test(t.key) ? t.key.slice(1) : '',
    name: String(t.title).replace(/^(FT|FV|RX|PR|EC|RF|RC|BM|BC|S2S|S2|KYC|KV)-\S+\s(· )?/, ''),
    expectedItems: t.expectedItems?.length
      ? t.expectedItems
      : t.expected
        ? [{ label: '', value: t.expected }]
        : [],
    actualItems: t.actualItems?.length
      ? t.actualItems
      : String(t.actual || '')
          .split(' · ')
          .filter(Boolean)
          .map((v) => ({ label: '', value: v })),
  };
}

const lines = (items) =>
  items.map((i) => (i.label ? `${i.label}: ${i.value}` : i.value)).join('\n');
/** Masking rules: one line per field that is not masked ("CVV is not masked – readable at …"). */
const unmaskedLines = (t) =>
  ((t.psp && t.psp.checks) || [])
    .filter((c) => !c.passed && /^Masking · /.test(c.name))
    .map((c) => {
      const field = c.name.split(' · ')[2] || c.name;
      const where = String(c.actual || '').replace(/^NOT MASKED – .*? is readable at /, '');
      return `${field} is not masked – readable at ${where}`;
    });
const firstError = (t) => {
  const unmasked = unmaskedLines(t);
  if (unmasked.length > 0) return unmasked.join('\n').slice(0, 1000);
  return String((t.errors && t.errors[0]) || '')
    .split('\n')[0]
    .slice(0, 300);
};
/** Row height that fits wrapped text: ~1.15 characters per column-width unit, 14 pt per line. */
function fitHeight(cells, min = 18) {
  let linesNeeded = 1;
  for (const [text, width] of cells) {
    const count = String(text || '')
      .split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (width * 1.15))), 0);
    linesNeeded = Math.max(linesNeeded, count);
  }
  return Math.min(300, Math.max(min, linesNeeded * 14 + 4));
}
const passRate = (passed, failed) =>
  passed + failed === 0 ? '—' : `${Math.round((passed / (passed + failed)) * 100)}%`;

function styleHeader(row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = fill(COLORS.headerFill);
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = box;
  });
}

function styleResult(cell, verdict) {
  const s = RESULT_STYLE[verdict] || RESULT_STYLE.SKIPPED;
  cell.value = RESULT_TEXT[verdict] || verdict;
  cell.font = { name: 'Calibri', bold: true, color: { argb: s.font } };
  cell.fill = fill(s.fill);
  cell.alignment = { vertical: 'top', horizontal: 'center' };
}

/** @returns {Promise<Buffer>} */
async function reportWorkbook(report) {
  const tests = (report.tests || [])
    .map(normalise)
    .sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        (a.verdict === 'FAIL' ? 0 : 1) - (b.verdict === 'FAIL' ? 0 : 1),
    );
  const c = report.config || {};
  const count = (list, v) => list.filter((t) => t.verdict === v).length;
  const total = {
    all: tests.length,
    pass: count(tests, 'PASS'),
    fail: count(tests, 'FAIL'),
    obs: count(tests, 'OBSERVED'),
    skip: count(tests, 'SKIPPED'),
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Integration QA Automation';
  wb.created = new Date();

  // ── Summary ──────────────────────────────────────────────────────────────
  const sum = wb.addWorksheet('Summary', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sum.columns = [
    { width: 30 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
  ];

  const title = sum.addRow(['Integration QA – Test Execution Report']);
  title.font = { name: 'Calibri', bold: true, size: 18, color: { argb: COLORS.ink } };
  title.height = 30;
  const sub = sum.addRow([
    `Cashier purchase · ${c.environment || ''} · finished ${report.finishedAt ? new Date(report.finishedAt).toLocaleString('en-GB') : ''} · ${Math.round((report.durationMs || 0) / 1000)} s`,
  ]);
  sub.font = { name: 'Calibri', color: { argb: COLORS.muted } };
  sum.addRow([]);

  // Overall result tiles
  const verdictText = total.fail > 0 ? `${total.fail} FAILED` : 'ALL PASSED';
  const overall = sum.addRow(['Overall result', verdictText]);
  overall.getCell(1).font = { name: 'Calibri', bold: true, size: 12 };
  sum.mergeCells(`B${overall.number}:D${overall.number}`);
  styleResult(overall.getCell(2), total.fail > 0 ? 'FAIL' : 'PASS');
  overall.getCell(2).value = verdictText;
  overall.getCell(2).font = {
    name: 'Calibri',
    bold: true,
    size: 13,
    color: { argb: total.fail > 0 ? COLORS.fail : COLORS.pass },
  };
  overall.height = 24;
  sum.addRow([]);

  const tiles = sum.addRow([
    '',
    'Executed',
    'Passed',
    'Failed',
    'Observed',
    'Skipped',
    'Pass rate',
  ]);
  const tileValues = sum.addRow([
    '',
    total.all,
    total.pass,
    total.fail,
    total.obs,
    total.skip,
    passRate(total.pass, total.fail),
  ]);
  const tileColors = [
    null,
    [COLORS.ink, COLORS.subtleFill],
    [COLORS.pass, COLORS.passFill],
    [COLORS.fail, COLORS.failFill],
    [COLORS.warn, COLORS.warnFill],
    [COLORS.muted, COLORS.skipFill],
    [COLORS.ink, COLORS.subtleFill],
  ];
  for (let i = 2; i <= 7; i++) {
    const [ink, bg] = tileColors[i - 1];
    const head = tiles.getCell(i);
    head.font = { name: 'Calibri', size: 10, color: { argb: COLORS.muted } };
    head.fill = fill(bg);
    head.alignment = { horizontal: 'center' };
    const val = tileValues.getCell(i);
    val.font = { name: 'Calibri', bold: true, size: 20, color: { argb: ink } };
    val.fill = fill(bg);
    val.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  tileValues.height = 32;
  sum.addRow([]);

  // Run details
  const section = (text) => {
    const r = sum.addRow([text]);
    r.font = { name: 'Calibri', bold: true, size: 12, color: { argb: COLORS.ink } };
    r.height = 20;
  };
  section('Run details');
  for (const [label, value] of [
    ['Environment', c.environment],
    ['Tester', c.tester],
    ['Brand ID', c.brandId],
    ['API key', c.apiKey],
    ['Currency', c.currency],
    ['Payment method', c.paymentMethod],
    ['Routed to (MID)', c.mid && c.mid !== 'not checked' ? c.mid : c.bank],
    ['Card for payments', c.payWithCard],
    ['Device (cashier)', c.device || 'Desktop'],
    ['Started', report.startedAt ? new Date(report.startedAt).toLocaleString('en-GB') : ''],
    ['Finished', report.finishedAt ? new Date(report.finishedAt).toLocaleString('en-GB') : ''],
  ]) {
    const r = sum.addRow([label, value || '—']);
    r.getCell(1).font = { name: 'Calibri', color: { argb: COLORS.muted } };
    r.getCell(2).font = { name: 'Calibri', bold: true };
    sum.mergeCells(`B${r.number}:F${r.number}`);
  }
  sum.addRow([]);

  // By category
  section('Results by category');
  styleHeader(
    sum.addRow([
      'Category',
      'Tests',
      'Positive',
      'Negative',
      'Passed',
      'Failed',
      'Observed',
      'Skipped',
      'Pass rate',
    ]),
  );
  for (const id of CATEGORY_ORDER) {
    const list = tests.filter((t) => t.category === id);
    if (!list.length) continue;
    const p = count(list, 'PASS');
    const f = count(list, 'FAIL');
    const r = sum.addRow([
      CATEGORY_NAMES[id],
      list.length,
      list.filter((t) => t.polarity === 'positive').length,
      list.filter((t) => t.polarity === 'negative').length,
      p,
      f,
      count(list, 'OBSERVED'),
      count(list, 'SKIPPED'),
      passRate(p, f),
    ]);
    r.eachCell((cell, n) => {
      cell.border = box;
      cell.font = { name: 'Calibri' };
      if (n > 1) cell.alignment = { horizontal: 'center' };
    });
    r.getCell(1).font = { name: 'Calibri', bold: true };
    r.getCell(5).font = { name: 'Calibri', bold: true, color: { argb: COLORS.pass } };
    if (f > 0) {
      r.getCell(6).font = { name: 'Calibri', bold: true, color: { argb: COLORS.fail } };
      r.getCell(6).fill = fill(COLORS.failFill);
    }
  }
  sum.addRow([]);

  // Failed tests
  const failed = tests.filter((t) => t.verdict === 'FAIL');
  section(failed.length ? `Failed tests (${failed.length})` : 'Failed tests – none');
  if (failed.length) {
    const head = sum.addRow(['Test', 'Case', 'Category', 'Expected', '', '', 'Actual', '', '']);
    styleHeader(head);
    sum.mergeCells(`D${head.number}:F${head.number}`);
    sum.mergeCells(`G${head.number}:I${head.number}`);
    for (const t of failed) {
      const r = sum.addRow([
        t.name,
        t.caseId || '—',
        CATEGORY_NAMES[t.category],
        lines(t.expectedItems),
        '',
        '',
        lines(t.actualItems),
        '',
        '',
      ]);
      sum.mergeCells(`D${r.number}:F${r.number}`);
      sum.mergeCells(`G${r.number}:I${r.number}`);
      r.alignment = { wrapText: true, vertical: 'top' };
      r.eachCell((cell) => {
        cell.border = box;
        cell.font = { name: 'Calibri', size: 10 };
      });
      r.getCell(1).font = { name: 'Calibri', size: 10, bold: true };
      r.getCell(7).font = { name: 'Calibri', size: 10, color: { argb: COLORS.fail } };
      r.height = fitHeight(
        [
          [t.name, 30],
          [lines(t.expectedItems), 42],
          [lines(t.actualItems), 42],
        ],
        30,
      );
    }
  }
  sum.addRow([]);

  section('How to read this report');
  for (const [term, meaning] of [
    ['PASSED', 'The system behaved as expected.'],
    ['FAILED', 'The system did not behave as expected – see Expected vs Actual.'],
    ['OBSERVED', 'Behaviour is not specified; the result is recorded for review.'],
    ['Positive', 'Happy path – the request / payment should succeed or the value should be used.'],
    ['Negative', 'Invalid input or failing card – the system should reject, replace or fail it.'],
  ]) {
    const r = sum.addRow([term, meaning]);
    sum.mergeCells(`B${r.number}:I${r.number}`);
    const style =
      RESULT_STYLE[
        term === 'PASSED'
          ? 'PASS'
          : term === 'FAILED'
            ? 'FAIL'
            : term === 'OBSERVED'
              ? 'OBSERVED'
              : ''
      ];
    r.getCell(1).font = {
      name: 'Calibri',
      bold: true,
      color: { argb: style ? style.font : COLORS.ink },
    };
    r.getCell(2).font = { name: 'Calibri', color: { argb: COLORS.muted } };
  }

  // ── Results ──────────────────────────────────────────────────────────────
  const res = wb.addWorksheet('Results', {
    views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  res.columns = [
    { header: '#', width: 5 },
    { header: 'Category', width: 20 },
    { header: 'Case', width: 10 },
    { header: 'Test', width: 36 },
    { header: 'Type', width: 13 },
    { header: 'Result', width: 12 },
    { header: 'Expected', width: 44 },
    { header: 'Actual', width: 44 },
    { header: 'Purchase ID', width: 27 },
    { header: 'PSP transaction ID', width: 38 },
    { header: 'Duration (s)', width: 12 },
    { header: 'Error', width: 50 },
  ];
  styleHeader(res.getRow(1));
  tests.forEach((t, i) => {
    const r = res.addRow([
      i + 1,
      CATEGORY_NAMES[t.category],
      t.caseId || '—',
      t.name,
      TYPE_TEXT[t.polarity],
      '',
      lines(t.expectedItems),
      lines(t.actualItems),
      t.purchaseId || '',
      t.pspTransactionId || '',
      Number(((t.durationMs || 0) / 1000).toFixed(1)),
      t.verdict === 'FAIL' ? firstError(t) : '',
    ]);
    r.alignment = { wrapText: true, vertical: 'top' };
    r.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = box;
      cell.font = { name: 'Calibri', size: 10 };
      if (t.verdict === 'FAIL') cell.fill = fill(COLORS.failRow);
    });
    r.getCell(4).font = { name: 'Calibri', size: 10, bold: true };
    r.getCell(5).font = {
      name: 'Calibri',
      size: 10,
      color: {
        argb:
          t.polarity === 'positive'
            ? 'FF1D4ED8'
            : t.polarity === 'negative'
              ? 'FFB45309'
              : COLORS.muted,
      },
    };
    styleResult(r.getCell(6), t.verdict);
    r.getCell(8).font = {
      name: 'Calibri',
      size: 10,
      color: { argb: t.verdict === 'FAIL' ? COLORS.fail : COLORS.ink },
    };
    r.getCell(12).font = { name: 'Calibri', size: 10, color: { argb: COLORS.fail } };
    r.height = fitHeight([
      [t.name, 36],
      [lines(t.expectedItems), 44],
      [lines(t.actualItems), 44],
      [t.verdict === 'FAIL' ? firstError(t) : '', 50],
    ]);
  });
  res.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 12 } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { reportWorkbook };
