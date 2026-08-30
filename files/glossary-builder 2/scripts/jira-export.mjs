#!/usr/bin/env node
// jira-export.mjs — выгрузка тикетов, нормализация текста, порядок обработки.
// Режимы:
//   rest   — ходит в Jira REST API (нужен JIRA_TOKEN)
//   manual — сети не касается, читает готовые ответы из .cache/jira/*.json
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  readJson, writeJson, writeText, loadConfig, arg, log, fail, progress,
} from './lib/util.mjs';

const { config } = loadConfig(arg('config'));
const outDir = resolve(config.output?.dir || 'out');
const cacheDir = resolve(config.jira.cacheDir || '.cache/jira');
const mode = arg('mode', config.jira.mode || 'rest');
const refresh = arg('refresh', false) === true;

mkdirSync(cacheDir, { recursive: true });

// ── нормализация текста ──────────────────────────────────────────────────────
const cleanupLog = new Map();
function note(what) {
  cleanupLog.set(what, (cleanupLog.get(what) || 0) + 1);
}

// ADF (Jira Cloud) → Markdown
function adfToMarkdown(node, depth = 0) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map((n) => adfToMarkdown(n, depth)).join('');
  const kids = (d = depth) => adfToMarkdown(node.content || [], d);
  switch (node.type) {
    case 'doc': return kids();
    case 'paragraph': return kids() + '\n\n';
    case 'text': {
      let t = node.text || '';
      for (const m of node.marks || []) {
        if (m.type === 'strong') t = `**${t}**`;
        if (m.type === 'em') t = `*${t}*`;
        if (m.type === 'code') t = '`' + t + '`';
        if (m.type === 'link') t = `[${t}](${m.attrs?.href || ''})`;
      }
      return t;
    }
    case 'hardBreak': return '\n';
    case 'heading': return '#'.repeat(node.attrs?.level || 1) + ' ' + kids() + '\n\n';
    case 'bulletList': return kids() + '\n';
    case 'orderedList': return kids() + '\n';
    case 'listItem': return '- ' + kids().trim().replace(/\n+/g, ' ') + '\n';
    case 'codeBlock': return '```' + (node.attrs?.language || '') + '\n' + kids() + '\n```\n\n';
    case 'blockquote': return kids().split('\n').map((l) => (l ? '> ' + l : l)).join('\n');
    case 'rule': return '\n---\n';
    case 'table': return kids() + '\n';
    case 'tableRow': return '| ' + (node.content || []).map((c) => adfToMarkdown(c).trim()).join(' | ') + ' |\n';
    case 'tableHeader':
    case 'tableCell': return kids();
    case 'mediaSingle':
    case 'media': {
      note('вложение заменено маркером');
      return `[attachment: ${node.attrs?.alt || node.attrs?.id || 'file'}]\n`;
    }
    case 'mention': return '@' + (node.attrs?.text || '').replace(/^@/, '');
    case 'inlineCard': return node.attrs?.url || '';
    case 'panel': { note('панель развёрнута в текст'); return kids(); }
    case 'emoji': return node.attrs?.text || '';
    default: return kids();
  }
}

// Wiki-разметка (Jira Server) → Markdown
function wikiToMarkdown(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/\{code(?::([^}]*))?\}([\s\S]*?)\{code\}/g, (_, lang, body) => '```' + (lang || '') + '\n' + body.trim() + '\n```');
  t = t.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, (_, b) => '```\n' + b.trim() + '\n```');
  t = t.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, b) => b.trim().split('\n').map((l) => '> ' + l).join('\n'));
  t = t.replace(/\{panel(?::[^}]*)?\}([\s\S]*?)\{panel\}/g, (_, b) => { note('панель развёрнута в текст'); return b.trim(); });
  t = t.replace(/\{color(?::[^}]*)?\}([\s\S]*?)\{color\}/g, '$1');
  t = t.replace(/^h([1-6])\.\s*/gm, (_, n) => '#'.repeat(+n) + ' ');
  t = t.replace(/\*([^*\n]+)\*/g, '**$1**');
  t = t.replace(/_([^_\n]+)_/g, '*$1*');
  t = t.replace(/\{\{([^}]+)\}\}/g, '`$1`');
  t = t.replace(/\[([^|\]]+)\|([^\]]+)\]/g, '[$1]($2)');
  t = t.replace(/\[~([^\]]+)\]/g, '@$1');
  t = t.replace(/^\s*[*#]\s+/gm, '- ');
  t = t.replace(/!([^!|\s]+)(\|[^!]*)?!/g, (_, f) => { note('вложение заменено маркером'); return `[attachment: ${f}]`; });
  t = t.replace(/\{[a-z-]+(?::[^}]*)?\}/g, () => { note('служебный макрос удалён'); return ''; });
  return t;
}

function normalizeText(value) {
  if (!value) return '';
  const md = typeof value === 'object' ? adfToMarkdown(value) : wikiToMarkdown(String(value));
  let t = md.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (config.output?.redactEmails) {
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => { note('email скрыт'); return '[email]'; });
  }
  return t;
}

const BOT_RE = /(bot|jenkins|gitlab|bitbucket|automation|integration|ci)/i;

// ── REST ─────────────────────────────────────────────────────────────────────
async function restFetch(path) {
  const token = process.env.JIRA_TOKEN;
  if (!token) fail('Не задан JIRA_TOKEN. Либо задайте его, либо запустите с --mode manual.');
  const url = `${config.jira.baseUrl.replace(/\/$/, '')}${path}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const wait = 2 ** attempt * 500;
      log(`  ${res.status}, повтор через ${wait}мс`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    fail(`Jira ответила ${res.status} на ${path}`);
  }
  fail(`Не удалось получить ${path} после 5 попыток`);
}

async function discoverFields() {
  if (config.jira.fieldIds && Object.keys(config.jira.fieldIds).length) return config.jira.fieldIds;
  log('Определяю id кастомных полей...');
  const fields = await restFetch('/rest/api/2/field');
  const find = (names) =>
    fields.find((f) => names.some((n) => (f.name || '').toLowerCase() === n))?.id || null;
  const ids = {
    acceptanceCriteria: find(['acceptance criteria', 'критерии приёмки', 'критерии приемки']),
    sprint: find(['sprint', 'спринт']),
    epic: find(['epic link', 'эпик']),
  };
  log(`  ${JSON.stringify(ids)}`);
  log('  Проверьте их и запишите в конфиг (jira.fieldIds), чтобы не определять заново.');
  return ids;
}

async function fetchAll(fieldIds) {
  const jql = [
    `project = ${config.jira.projectKey}`,
    config.scope.resolvedAfter
      ? `(resolutiondate >= "${config.scope.resolvedAfter}"${config.scope.includeUnresolved ? ' OR resolution IS EMPTY' : ''})`
      : null,
  ].filter(Boolean).join(' AND ');

  const out = [];
  let startAt = 0;
  for (;;) {
    const page = await restFetch(
      `/rest/api/2/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=50&expand=changelog&fields=*all`,
    );
    out.push(...page.issues);
    progress('выгрузка', out.length, page.total);
    for (const issue of page.issues) writeJson(join(cacheDir, `${issue.key}.json`), issue);
    startAt += page.issues.length;
    if (startAt >= page.total || page.issues.length === 0) break;
  }
  return out;
}

function loadCache() {
  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0)
    fail(`В ${cacheDir} нет выгруженных тикетов. В режиме manual их должен положить туда браузерный агент или человек.`);
  return files.map((f) => readJson(join(cacheDir, f)));
}

// ── нормализация тикета ──────────────────────────────────────────────────────
function parseSprints(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const pattern = new RegExp(config.jira.sprintNumberPattern || '(\\d+)');
  return arr.map((s) => {
    if (typeof s === 'object') {
      const name = s.name || '';
      return {
        id: s.id ?? null, name, state: s.state ?? null,
        startDate: s.startDate ?? null, endDate: s.endDate ?? s.completeDate ?? null,
        number: Number((name.match(pattern) || [])[1] ?? NaN),
      };
    }
    const name = (String(s).match(/name=([^,\]]+)/) || [])[1] || String(s);
    return {
      id: Number((String(s).match(/id=(\d+)/) || [])[1] ?? NaN) || null,
      name, state: (String(s).match(/state=([^,\]]+)/) || [])[1] || null,
      startDate: (String(s).match(/startDate=([^,\]]+)/) || [])[1] || null,
      endDate: (String(s).match(/endDate=([^,\]]+)/) || [])[1] || null,
      number: Number((name.match(pattern) || [])[1] ?? NaN),
    };
  });
}

function normalizeIssue(issue, fieldIds) {
  const f = issue.fields || {};
  const sprints = parseSprints(fieldIds.sprint ? f[fieldIds.sprint] : null);
  const comments = (f.comment?.comments || []).map((c) => ({
    author: c.author?.displayName || c.author?.name || 'unknown',
    created: c.created,
    body: normalizeText(c.body),
    isBot: BOT_RE.test(c.author?.displayName || c.author?.name || ''),
  }));
  return {
    key: issue.key,
    type: f.issuetype?.name || null,
    status: f.status?.name || null,
    resolution: f.resolution?.name || null,
    summary: f.summary || '',
    description: normalizeText(f.description),
    acceptanceCriteria: fieldIds.acceptanceCriteria ? normalizeText(f[fieldIds.acceptanceCriteria]) : '',
    comments,
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name),
    epic: fieldIds.epic ? f[fieldIds.epic] || null : null,
    sprints,
    created: f.created || null,
    updated: f.updated || null,
    resolutiondate: f.resolutiondate || null,
    linkedIssues: (f.issuelinks || []).map((l) => ({
      key: l.outwardIssue?.key || l.inwardIssue?.key || null,
      type: l.type?.name || null,
    })).filter((l) => l.key),
  };
}

// ── порядок обработки ────────────────────────────────────────────────────────
function assignOrder(list) {
  const sprintMap = new Map();
  for (const t of list) {
    for (const s of t.sprints) {
      if (!Number.isNaN(s.number) && !sprintMap.has(s.number)) sprintMap.set(s.number, s);
    }
  }
  const sprintList = [...sprintMap.values()].sort((a, b) => a.number - b.number);

  function pseudoSprint(date) {
    if (!date) return Number.MAX_SAFE_INTEGER;
    const d = new Date(date);
    for (const s of sprintList) {
      if (s.startDate && s.endDate && d >= new Date(s.startDate) && d <= new Date(s.endDate)) return s.number;
    }
    let best = sprintList[0]?.number ?? 0;
    for (const s of sprintList) if (s.endDate && new Date(s.endDate) <= d) best = s.number;
    return best;
  }

  for (const t of list) {
    const last = t.sprints.filter((s) => !Number.isNaN(s.number)).sort((a, b) => a.number - b.number).pop();
    if (last) {
      t.sprintNumber = last.number;
      t.orderConfidence = t.resolutiondate ? 'high' : 'low';
    } else if (t.resolutiondate) {
      t.sprintNumber = pseudoSprint(t.resolutiondate);
      t.orderConfidence = 'medium';
    } else {
      t.sprintNumber = Number.MAX_SAFE_INTEGER;
      t.orderConfidence = 'low';
    }
    t._sortDate = t.resolutiondate || t.updated || t.created || '';
    t._num = Number((t.key.match(/(\d+)$/) || [])[1] || 0);
  }

  list.sort(
    (a, b) =>
      a.sprintNumber - b.sprintNumber ||
      (a._sortDate < b._sortDate ? -1 : a._sortDate > b._sortDate ? 1 : 0) ||
      a._num - b._num,
  );
  list.forEach((t, i) => {
    t.order = i;
    delete t._sortDate;
    delete t._num;
  });
  return sprintList;
}

// ── main ─────────────────────────────────────────────────────────────────────
const cached = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.endsWith('.json')) : [];
let issues;
let fieldIds = config.jira.fieldIds || {};

if (mode === 'manual') {
  log('Режим manual: сеть не используется, читаю .cache/jira/');
  issues = loadCache();
  if (!fieldIds.sprint) log('ВНИМАНИЕ: jira.fieldIds не заданы — спринты и AC могут не подхватиться.');
} else if (cached.length > 0 && !refresh) {
  log(`Кэш содержит ${cached.length} тикетов, сеть не используется. Для перевыгрузки: --refresh`);
  issues = loadCache();
} else {
  fieldIds = await discoverFields();
  issues = await fetchAll(fieldIds);
}

const tickets = issues.map((i) => normalizeIssue(i, fieldIds));
const sprints = assignOrder(tickets);

writeJson(join(outDir, 'tickets.json'), {
  meta: {
    generatedAt: new Date().toISOString(),
    projectKey: config.jira.projectKey,
    mode,
    totalTickets: tickets.length,
    scope: config.scope,
    fieldIds,
  },
  sprints,
  tickets,
});

const lowConfidence = tickets.filter((t) => t.orderConfidence !== 'high');
const emptyDesc = tickets.filter((t) => !t.description);
const shortDesc = tickets.filter((t) => t.description && t.description.length < 100);
const byType = {};
for (const t of tickets) byType[t.type] = (byType[t.type] || 0) + 1;
const bySprint = {};
for (const t of tickets) bySprint[t.sprintNumber] = (bySprint[t.sprintNumber] || 0) + 1;

writeText(
  join(outDir, 'tickets-report.md'),
  `# Отчёт по выгрузке тикетов

Сформирован: ${new Date().toISOString()}
Режим: ${mode} | Проект: ${config.jira.projectKey} | Тикетов: ${tickets.length}

## По типам
${Object.entries(byType).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## По спринтам
${Object.entries(bySprint).sort((a, b) => a[0] - b[0]).map(([k, v]) => `- спринт ${k}: ${v}`).join('\n')}

## Требует внимания

- Тикетов с ненадёжным порядком (orderConfidence != high): **${lowConfidence.length}**
${lowConfidence.slice(0, 40).map((t) => `  - ${t.key} (${t.orderConfidence})`).join('\n')}
- Тикетов с пустым описанием: **${emptyDesc.length}**
- Тикетов с описанием короче 100 символов: **${shortDesc.length}** — кандидаты в «невнятные для агента»
- Не сопоставленные поля: ${Object.entries(fieldIds).filter(([, v]) => !v).map(([k]) => k).join(', ') || '— нет'}

## Что вычищено при нормализации
${[...cleanupLog.entries()].map(([k, v]) => `- ${k}: ${v}`).join('\n') || '— ничего'}
`,
);

log(`Готово: ${tickets.length} тикетов → ${join(outDir, 'tickets.json')}`);
log(`Отчёт: ${join(outDir, 'tickets-report.md')}`);
