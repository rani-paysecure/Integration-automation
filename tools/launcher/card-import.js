// @ts-check
/**
 * Reads a PSP's public test-card page (or pasted text) and lists the test cards
 * on it, so the Test cards tab can add them in one go.
 *
 * - Works on HTML tables (rowspan/colspan aware) and, as a fallback, on plain
 *   text lines. A number counts as a card only when it is 12–19 digits and
 *   passes the Luhn check.
 * - Outcome, 3DS challenge, expiry and CVV are guessed from the page text; the
 *   tester reviews every card in the import window before anything is saved.
 * - Read-only: only http(s) pages are fetched, with a size and time limit.
 */
'use strict';

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_CARDS = 200;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  hellip: '…',
};
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
/** Visible text of an HTML fragment. */
const textOf = (html) =>
  decode(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
/** Card numbers in a text (spaces / dashes inside the number are allowed). */
function cardNumbers(text) {
  const found = [];
  for (const m of text.matchAll(/(?<![\d])\d(?:[ -]?\d){11,18}(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 12 && digits.length <= 19 && luhn(digits) && !/^(\d)\1+$/.test(digits))
      found.push(digits);
  }
  return found;
}

const SCHEMES = [
  ['VISA', /\bvisa\b/i, /^4/],
  ['MASTERCARD', /\bmaster ?card\b|\bmc\b/i, /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/],
  ['AMEX', /\bamex\b|american express/i, /^3[47]/],
  ['DISCOVER', /\bdiscover\b/i, /^(6011|65|64[4-9])/],
  ['DINERS', /\bdiners\b/i, /^3(0[0-5]|[68])/],
  ['JCB', /\bjcb\b/i, /^35/],
  ['MAESTRO', /\bmaestro\b/i, /^(50|5[6-9]|6)/],
  ['UNIONPAY', /union ?pay|\bcup\b/i, /^62/],
];
function schemeFor(number, context) {
  for (const [name, word] of SCHEMES) if (word.test(context)) return name;
  for (const [name, , bin] of SCHEMES) if (bin.test(number)) return name;
  return 'CARD';
}

/** Expected outcome / 3DS behaviour guessed from the words around a card. */
function guessBehaviour(context) {
  const t = context.toLowerCase();
  const challenge =
    /challenge|\botp\b|one[- ]time password|step[- ]up/.test(t) &&
    !/frictionless|without (a )?challenge|no challenge|not requiring a challenge/.test(t);
  // "… & Successful Authorisation" / "… & Failed Authorisation" decides the cashier result.
  const auth = /\b(successful|approved) authori[sz]ation\b/.test(t)
    ? 'ok'
    : /\b(failed|no|declined) authori[sz]ation\b/.test(t)
      ? 'ko'
      : '';
  const fail =
    /\b(fail(ed|s|ure)?|declin\w*|reject\w*|denied|not authenticated|unsuccessful|insufficient|do not honou?r|stolen|lost|blocked|invalid|error|status:? ?[nr]\b)/.test(
      t,
    );
  const success =
    /\b(success\w*|approv\w*|authori[sz]ed|authenticated|frictionless|status:? ?[ya]\b)/.test(t);
  const outcome =
    auth === 'ok'
      ? 'success-redirect'
      : auth === 'ko' || fail
        ? 'failure-redirect'
        : 'success-redirect';
  return {
    expectedOutcome: outcome,
    expectedStatuses: outcome === 'failure-redirect' ? ['ERROR'] : ['PAID'],
    challenge: challenge ? 'manual' : 'none',
    confident: Boolean(auth) || fail || success,
  };
}

/** Rows of a <table> as text cells, with rowspan / colspan filled in. */
function tableRows(tableHtml) {
  const grid = [];
  const pending = []; // column -> { text, left }
  for (const tr of tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const row = [];
    let col = 0;
    const take = () => {
      while (pending[col] && pending[col].left > 0) {
        row[col] = pending[col].text;
        pending[col].left -= 1;
        col += 1;
      }
    };
    for (const cell of tr[0].matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      take();
      const attrs = cell[2];
      const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] || 1);
      const rows = Number(/rowspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] || 1);
      const text = oneLine(textOf(cell[3]));
      for (let i = 0; i < span; i++) {
        row[col] = text;
        if (rows > 1) pending[col] = { text, left: rows - 1 };
        col += 1;
      }
    }
    take();
    const filled = row.filter((c) => c);
    grid.push({
      cells: row.map((c) => c ?? ''),
      single: filled.length > 0 && new Set(filled).size === 1,
    });
  }
  return grid;
}

/** Nearest heading (or bold / short paragraph) before position `at`. */
function headingBefore(html, at) {
  const before = html.slice(Math.max(0, at - 4000), at);
  const all = [...before.matchAll(/<(h[1-6]|strong|b|caption)[^>]*>([\s\S]*?)<\/\1>/gi)];
  for (let i = all.length - 1; i >= 0; i--) {
    const t = oneLine(textOf(all[i][2]));
    if (t && t.length <= 140 && !cardNumbers(t).length) return t;
  }
  return '';
}

/** Page-wide expiry / CVV hints ("use any future expiry date", "CVV 123"). */
function pageDefaults(text) {
  const yy = (new Date().getFullYear() + 3) % 100;
  const expiryMatch =
    /(?:expir\w*|exp\.? date|valid (?:thru|until))[^.\n]{0,80}?\b(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})\b/i.exec(
      text,
    );
  const cvvMatch = /\b(?:cvv2?|cvc2?|csc|security code)\b[^.\n]{0,60}?\b(\d{3,4})\b/i.exec(text);
  return {
    expiry: expiryMatch
      ? `${expiryMatch[1]}/${expiryMatch[2].slice(-2)}`
      : `12/${String(yy).padStart(2, '0')}`,
    cvv: cvvMatch ? cvvMatch[1] : '123',
    expiryFound: Boolean(expiryMatch),
    cvvFound: Boolean(cvvMatch),
  };
}

const cleanTitle = (title) =>
  title
    .replace(/^\(?3ds ?v?\d?\)?\s*/i, '')
    .replace(/^test case \d+[a-z]?\s*[:–-]\s*/i, '')
    .trim();
/** First sentence of a section title ("Successful frictionless … Authorisation."). */
const shortTitle = (title) =>
  (/^(.{8,140}?[.!?])\s/.exec(`${title} `)?.[1] || title).replace(/[.!?]$/, '').slice(0, 140);

/**
 * Cards on a page.
 * @param {string} source HTML (or plain text)
 * @returns {{ title: string, defaults: ReturnType<typeof pageDefaults>, cards: Array<Record<string, unknown>> }}
 */
function extractCards(source) {
  const isHtml = /<\/?(html|body|table|div|p|tr)\b/i.test(source);
  const fullText = isHtml ? textOf(source) : source;
  const title = isHtml
    ? oneLine(textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || ''))
    : '';
  const defaults = pageDefaults(fullText);
  const cards = [];
  const seen = new Set();
  const add = (number, group, rowText, extra = {}, detailText = rowText) => {
    if (seen.has(number) || cards.length >= MAX_CARDS) return;
    seen.add(number);
    const scheme = schemeFor(number, rowText);
    const groupName = shortTitle(cleanTitle(group));
    // The table / section title says what the card does; the row text is only a fallback
    // (rows often mention "error code 0" etc. even for approved cards).
    const fromTitle = guessBehaviour(group);
    const behaviour = fromTitle.confident
      ? { ...fromTitle, challenge: guessBehaviour(`${group} ${rowText}`).challenge }
      : guessBehaviour(`${group} ${rowText}`);
    const detail = oneLine(
      detailText
        .replace(/\d(?:[ -]?\d){11,18}/g, '')
        .replace(new RegExp(`\\b${scheme}\\b`, 'gi'), '')
        .replace(/[\w ]+:\s*(·|$)/g, '')
        .replace(/(\s*·\s*)+/g, ' · ')
        .replace(/^\s*·\s*|\s*·\s*$/g, ''),
    );
    const short = (groupName || detail || `•••• ${number.slice(-4)}`)
      .replace(/\s*3D Secure Authentication/gi, ' 3DS')
      .replace(/Authori[sz]ation/gi, 'auth');
    const name = scheme === 'CARD' ? 'Card' : scheme.charAt(0) + scheme.slice(1).toLowerCase();
    const label = `${name} – ${short}`;
    cards.push({
      number,
      scheme,
      group: groupName || 'Cards',
      detail: oneLine(
        `${cleanTitle(group)
          .slice(groupName.length)
          .replace(/^[.!?]\s*/, '')} ${detail}`,
      ).slice(0, 240),
      label: label.length > 80 ? `${label.slice(0, 78).replace(/\s+\S*$/, '')}…` : label,
      expiry: extra.expiry || defaults.expiry,
      cvv: extra.cvv || (scheme === 'AMEX' && !defaults.cvvFound ? '1234' : defaults.cvv),
      ...behaviour,
    });
  };

  if (isHtml) {
    for (const m of source.matchAll(/<table[\s\S]*?<\/table>/gi)) {
      const rows = tableRows(m[0]);
      let group = headingBefore(source, m.index ?? 0);
      let header = [];
      for (const { cells, single } of rows) {
        const rowText = cells.join(' · ');
        const numbers = cells.flatMap((c) => cardNumbers(c));
        if (!numbers.length) {
          if (single) group = cells.find(Boolean) || group;
          else if (cells.filter(Boolean).length > 1) header = cells;
          continue;
        }
        const pick = (re) => cells[header.findIndex((h) => re.test(h))] || '';
        const expiry = /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/.exec(pick(/expir/i).trim());
        const cvv = /^\d{3,4}$/.exec(pick(/cvv|cvc|security/i).trim());
        const labelled = cells
          .map((c, i) => (header[i] && c && !cardNumbers(c).length ? `${header[i]}: ${c}` : c))
          .filter((c) => c && !cardNumbers(c).length)
          .join(' · ');
        for (const n of numbers)
          add(
            n,
            group,
            rowText,
            {
              ...(expiry ? { expiry: `${expiry[1]}/${expiry[2].slice(-2)}` } : {}),
              ...(cvv ? { cvv: cvv[0] } : {}),
            },
            labelled,
          );
      }
    }
  }
  // Fallback / extra: card numbers in running text (lists, paragraphs, pasted text).
  const lines = fullText.split('\n');
  let heading = '';
  for (const line of lines) {
    const numbers = cardNumbers(line);
    if (!numbers.length) {
      if (line.length > 3 && line.length <= 120) heading = line;
      continue;
    }
    const exp = /\b(0[1-9]|1[0-2])\s*\/\s*(\d{4}|\d{2})\b/.exec(
      line.replace(/\d(?:[ -]?\d){11,18}/g, ''),
    );
    for (const n of numbers)
      add(n, heading, line, exp ? { expiry: `${exp[1]}/${exp[2].slice(-2)}` } : {});
  }
  return { title, defaults, cards };
}

/** Fetches a public test-card page (http/https only, size + time limit). */
async function fetchPage(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Enter a full link, e.g. https://docs.psp.com/test-cards');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only http(s) links can be read');
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'user-agent': 'Mozilla/5.0 (Paysecure QA launcher - test card import)',
      accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
    },
  });
  if (!res.ok)
    throw new Error(
      `The page answered HTTP ${res.status} – if it needs a login, copy the table and paste it instead`,
    );
  const type = res.headers.get('content-type') || '';
  if (/pdf|octet-stream|image\//i.test(type))
    throw new Error(
      'This link is a file, not a web page – open it, copy the card table and paste it instead',
    );
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { extractCards, fetchPage, cardNumbers, luhn };
