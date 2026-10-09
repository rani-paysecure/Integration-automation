// @ts-check
/**
 * Jira connection for the launcher (Advanced → Jira): site, e-mail and personal API token.
 * Kept in this computer's .env only (git-ignored) – never in settings, git or logs.
 * Create a token: https://id.atlassian.com/manage-profile/security/api-tokens
 */
'use strict';

const { readEnvFile, writeEnvValues } = require('./ai-generate');

const DEFAULT_SITE = 'https://paysecure-team.atlassian.net';

/** Current values: .env first (what the UI saved), then the process environment. */
function settings() {
  const file = readEnvFile();
  const pick = (/** @type {string} */ key) => String(file[key] ?? process.env[key] ?? '').trim();
  return {
    baseUrl: (pick('JIRA_BASE_URL') || DEFAULT_SITE).replace(/\/+$/, ''),
    email: pick('JIRA_EMAIL'),
    token: pick('JIRA_API_TOKEN'),
  };
}

/** What the UI may see – never the token. */
function jiraStatus() {
  const s = settings();
  return {
    baseUrl: s.baseUrl,
    email: s.email,
    tokenSet: s.token !== '',
    configured: s.email !== '' && s.token !== '',
  };
}

/** Calls GET /rest/api/3/myself – who the token belongs to. */
async function whoAmI(s = settings()) {
  const res = await fetch(`${s.baseUrl}/rest/api/3/myself`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401)
    throw new Error(
      'Jira did not accept the e-mail + API token – check both (the token must belong to this e-mail)',
    );
  if (res.status === 403)
    throw new Error(
      'Jira refused the token (HTTP 403) – API tokens may be blocked by your Atlassian admin',
    );
  if (!res.ok) throw new Error(`Jira answered HTTP ${String(res.status)}`);
  const me = /** @type {{ displayName?: string, emailAddress?: string }} */ (await res.json());
  return me.displayName || me.emailAddress || s.email;
}

/** Saves site / e-mail / token (empty token keeps the saved one) and tests them. */
async function setupJira(
  /** @type {{ baseUrl?: unknown, email?: unknown, token?: unknown }} */ input,
) {
  const baseUrl = String(input.baseUrl || DEFAULT_SITE)
    .trim()
    .replace(/\/+$/, '');
  const email = String(input.email || '').trim();
  const token = String(input.token || '').trim();
  if (!/^https:\/\/[\w.-]+$/.test(baseUrl))
    throw new Error('Jira site must look like https://paysecure-team.atlassian.net');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error('Enter the e-mail of your Atlassian account');
  if (!token && !settings().token) throw new Error('Paste your Jira API token');
  writeEnvValues({
    JIRA_BASE_URL: baseUrl,
    JIRA_EMAIL: email,
    ...(token ? { JIRA_API_TOKEN: token } : {}),
  });
  let check = { ok: true, message: '' };
  try {
    check.message = `Connected to Jira as ${await whoAmI()}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check = {
      ok: false,
      message: `Saved, but ${/timeout|abort/i.test(message) ? `${baseUrl} did not answer within 15 s` : message}`,
    };
  }
  return { ...jiraStatus(), check };
}

/** Removes the token from .env (site and e-mail stay). */
function removeJiraToken() {
  writeEnvValues({ JIRA_API_TOKEN: '' });
  return jiraStatus();
}

// ── prefill a bank profile from a Jira ticket ─────────────────────────────────

const { SECRET } = require('../../config/bank-profiles');

/** IDE-132 from "https://…/browse/IDE-132", "…atlassian.net/browse/IDE-132?x" or "IDE-132". */
function issueKey(/** @type {string} */ link) {
  const m = /([A-Z][A-Z0-9]+-\d+)(?![\w-])/.exec(String(link || '').toUpperCase());
  return m ? m[1] : '';
}

/** Atlassian Document Format → plain text lines (links / cards written as their URL). */
function adfText(/** @type {any} */ node) {
  /** @type {string[]} */
  const out = [];
  let line = '';
  const flush = () => {
    out.push(line);
    line = '';
  };
  const walk = (/** @type {any} */ n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    switch (n.type) {
      case 'text': {
        const link = (n.marks || []).find((/** @type {any} */ m) => m.type === 'link')?.attrs?.href;
        line += link && link !== n.text ? `${n.text} ${link}` : n.text || '';
        return;
      }
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard':
        line += ` ${n.attrs?.url || ''} `;
        return;
      case 'mention':
        line += n.attrs?.text || '';
        return;
      case 'hardBreak':
        flush();
        return;
      case 'codeBlock':
        flush();
        out.push(
          '```',
          ...(n.content || [])
            .map((/** @type {any} */ c) => c.text || '')
            .join('')
            .split('\n'),
          '```',
        );
        return;
      default:
        walk(n.content);
        if (['paragraph', 'heading', 'listItem', 'blockquote', 'tableRow'].includes(n.type))
          flush();
    }
  };
  walk(node);
  flush();
  return out;
}

/** Lines that hold credentials (username / password / key …) – never imported. */
const CREDENTIAL_LINE =
  /(password|passwd|username|user\s*name|secret|api[\s_-]*key|token|private\s*api|credential)/i;

/** {a:{b:"x"}} JS-ish object text from a Jira code block → leaves [path, value]. */
function objectLeaves(/** @type {string} */ code) {
  let text = code.trim();
  if (!text.startsWith('{')) text = `{${text}}`;
  const json = text
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,\s*([}\]])/g, '$1');
  let open = 0;
  for (const ch of json) open += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  let parsed;
  try {
    parsed = JSON.parse(json + '}'.repeat(Math.max(0, open)));
  } catch {
    return [];
  }
  /** @type {[string, string][]} */
  const out = [];
  const walk = (/** @type {any} */ v, /** @type {string} */ p) => {
    if (v && typeof v === 'object' && !Array.isArray(v))
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    else if (p) out.push([p, String(v)]);
  };
  walk(parsed, '');
  return out;
}

/**
 * Reads a Jira ticket and drafts a bank profile from it: notes (description without
 * credential lines), doc links, attachments / linked issues, and field-mapping rows from
 * request samples in code blocks. Nothing is saved here – the launcher shows it for review.
 */
async function jiraPrefill(/** @type {string} */ link) {
  const s = settings();
  if (!s.email || !s.token)
    throw new Error('Set up Jira first: Advanced → Jira (your e-mail + API token)');
  const key = issueKey(link);
  if (!key)
    throw new Error(
      'No Jira issue key in the link – it looks like https://paysecure-team.atlassian.net/browse/IDE-132',
    );
  const res = await fetch(
    `${s.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,comment,attachment,issuelinks,status,parent`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (res.status === 401)
    throw new Error('Jira did not accept your e-mail + API token – check Advanced → Jira');
  if (res.status === 404) throw new Error(`${key} not found, or you have no access to it`);
  if (!res.ok) throw new Error(`Jira answered HTTP ${String(res.status)} for ${key}`);
  const issue = /** @type {any} */ (await res.json());
  const f = issue.fields || {};
  const description = adfText(f.description);
  const comments = (f.comment?.comments || []).map((/** @type {any} */ c) => ({
    author: c.author?.displayName || '',
    lines: adfText(c.body),
  }));

  let skipped = 0;
  const safe = (/** @type {string[]} */ lines) =>
    lines.filter((l) => {
      const bad = CREDENTIAL_LINE.test(l) || SECRET.test(l);
      if (bad) skipped += 1;
      return !bad;
    });
  // A credential label on its own line is often followed by the value on the next line.
  const dropFollowing = (/** @type {string[]} */ lines) =>
    lines.filter(
      (l, i) =>
        !(i > 0 && CREDENTIAL_LINE.test(lines[i - 1] || '') && /^\S{12,}$/.test(l.trim())) ||
        ((skipped += 1), false),
    );

  // Doc links: every URL with the text before it on the line as its title.
  /** @type {{ title: string, url: string }[]} */
  const docs = [];
  const seen = new Set();
  for (const raw of [...description, ...comments.flatMap((c) => c.lines)]) {
    for (const m of raw.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
      const url = m[0].replace(/[.,;]+$/, '');
      if (
        seen.has(url) ||
        /atlassian\.net|atl-paas\.net|paymentsclub\.net|paysecure\.(dev|net)|blob:/i.test(url)
      )
        continue;
      seen.add(url);
      const title = raw
        .slice(0, m.index)
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*:_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(-120);
      docs.push({
        title:
          title ||
          url
            .replace(/^https?:\/\//, '')
            .split('/')
            .slice(0, 3)
            .join('/'),
        url,
      });
    }
  }

  // Mapping rows from request samples in code blocks (comments + description).
  /** @type {{ ours: string, psp: string, check: string, mandatory: boolean, note: string }[]} */
  const mapping = [];
  const blocks = [];
  for (const lines of [description, ...comments.map((c) => c.lines)]) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] !== '```') continue;
      const end = lines.indexOf('```', i + 1);
      if (end < 0) break;
      blocks.push(lines.slice(i + 1, end).join('\n'));
      i = end;
    }
  }
  for (const code of blocks) {
    for (const [p, v] of objectLeaves(code)) {
      if (mapping.some((m) => m.psp === p)) continue;
      const masked = v.includes('*') || /x{4,}/i.test(v);
      mapping.push({
        ours: '',
        psp: p,
        check: masked ? 'masked' : 'present',
        mandatory: true,
        note: `from ${key}`,
      });
    }
  }

  const URL_RE = /https?:\/\/\S+/;
  /** Short label line ("Payments API:") whose following lines (up to a blank) are all links. */
  const linkHeading = (/** @type {string[]} */ lines, /** @type {number} */ i) => {
    const l = lines[i]?.trim() ?? '';
    if (!l || URL_RE.test(l) || l.length > 60 || /\d{4,}/.test(l)) return false;
    let j = i + 1;
    let links = 0;
    while (j < lines.length && (lines[j] ?? '').trim() !== '') {
      if (!URL_RE.test(lines[j] ?? '')) return false;
      links += 1;
      j += 1;
    }
    return links > 0;
  };
  const clean = (/** @type {string[]} */ lines) =>
    dropFollowing(safe(lines))
      .filter((l) => l !== '```' && !/^\s*!\[\]\(blob:/.test(l))
      // Lines with links go to "API docs" – their labels / headings are not repeated in the notes.
      .filter((l, i, all) => !URL_RE.test(l) && !linkHeading(all, i))
      .join('\n')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const links = (f.issuelinks || [])
    .map((/** @type {any} */ l) => l.outwardIssue || l.inwardIssue)
    .filter(Boolean)
    .map(
      (/** @type {any} */ i) =>
        `${i.key} – ${i.fields?.summary || ''} (${i.fields?.status?.name || ''})`,
    );
  const attachments = (f.attachment || []).map(
    (/** @type {any} */ a) => `${a.filename} (${Math.round((a.size || 0) / 1024)} KB)`,
  );
  const notes = [
    `${key} – ${f.summary || ''}${f.status?.name ? ` (${f.status.name})` : ''}`,
    clean(description),
    links.length ? `Linked issues:\n${links.map((l) => `• ${l}`).join('\n')}` : '',
    attachments.length
      ? `Attachments in Jira:\n${attachments.map((a) => `• ${a}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 5800);
  return {
    key,
    url: `${s.baseUrl}/browse/${key}`,
    summary: String(f.summary || ''),
    notes,
    docs,
    mapping,
    attachments,
    links,
    comments: comments.length,
    skippedCredentialLines: skipped,
  };
}

module.exports = {
  jiraStatus,
  setupJira,
  removeJiraToken,
  whoAmI,
  jiraPrefill,
  issueKey,
  adfText,
  objectLeaves,
  DEFAULT_SITE,
};
