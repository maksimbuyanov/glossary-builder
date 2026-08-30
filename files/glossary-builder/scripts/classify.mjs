#!/usr/bin/env node
// classify.mjs — дешёвый настраиваемый проход.
// Читает raw-attribution.json + пороги, раскладывает файлы по ролям.
// Перезапускайте сколько угодно раз при подкрутке порогов: git не читается.
import { resolve, join } from 'node:path';
import {
  readJson, writeJson, writeText, loadConfig, arg, makeMatcher, log, fail,
} from './lib/util.mjs';

const { config } = loadConfig(arg('config'));
const outDir = resolve(config.output?.dir || 'out');
const T = config.thresholds;

const raw = readJson(join(outDir, 'raw-attribution.json'));
if (!raw) fail('Не найден out/raw-attribution.json. Сначала запустите extract.mjs.');
const ticketsDoc = readJson(resolve(config.tickets.file));
const tickets = ticketsDoc.tickets || [];
const ticketByKey = new Map(tickets.map((t) => [t.key, t]));

const isExcluded = makeMatcher(config.exclude.paths || []);

// ── агрегаты по тикету ───────────────────────────────────────────────────────
const byTicket = new Map();
for (const ch of raw.changes) {
  if (!byTicket.has(ch.ticket)) byTicket.set(ch.ticket, []);
  byTicket.get(ch.ticket).push(ch);
}

// ── роль файла в тикете ──────────────────────────────────────────────────────
function noiseReason(ch) {
  if (ch.isBinary) return 'binary';
  if (isExcluded(ch.path)) return 'excluded-path';
  if (ch.added + ch.deleted > 0 && ch.addedIgnoringWhitespace + ch.deletedIgnoringWhitespace === 0)
    return 'formatting-only';
  if (ch.punctuationOnlyCandidate) return 'punctuation-only';
  if (ch.commentOnly) return 'comment-only';
  return null;
}

const result = {};
const fileStats = new Map();

for (const [ticket, changes] of byTicket) {
  // схлопываем несколько коммитов одного тикета по одному файлу
  const merged = new Map();
  for (const ch of changes) {
    const prev = merged.get(ch.path);
    if (!prev) {
      merged.set(ch.path, { ...ch, shas: [ch.sha] });
    } else {
      prev.added += ch.added;
      prev.deleted += ch.deleted;
      prev.addedIgnoringWhitespace += ch.addedIgnoringWhitespace;
      prev.deletedIgnoringWhitespace += ch.deletedIgnoringWhitespace;
      prev.shas.push(ch.sha);
      // статус создания/переименования важнее последующих правок
      if (ch.status === 'A' || ch.status === 'R') prev.status = ch.status;
      prev.importOnly = prev.importOnly && ch.importOnly;
      prev.commentOnly = prev.commentOnly && ch.commentOnly;
      prev.punctuationOnlyCandidate = prev.punctuationOnlyCandidate && ch.punctuationOnlyCandidate;
    }
  }

  const files = [...merged.values()];
  const noise = [];
  const rest = [];
  for (const f of files) {
    const reason = noiseReason(f);
    if (reason) noise.push({ ...f, role: 'noise', reason });
    else rest.push(f);
  }

  const totalLines = rest.reduce((s, f) => s + f.added + f.deleted, 0) || 1;
  for (const f of rest) {
    f.lines = f.added + f.deleted;
    f.share = f.lines / totalLines;
  }
  // import-only отсеиваем только когда правка мелкая на фоне тикета
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].importOnly && rest[i].share < T.importOnlyMaxShare) {
      noise.push({ ...rest[i], role: 'noise', reason: 'import-only' });
      rest.splice(i, 1);
    }
  }
  const total2 = rest.reduce((s, f) => s + f.lines, 0) || 1;
  for (const f of rest) f.share = f.lines / total2;

  const target = [];
  const supporting = [];
  for (const f of rest) {
    let reason = null;
    if (f.status === 'A') reason = 'создан в рамках тикета';
    else if (f.status === 'R') reason = 'переименован в рамках тикета';
    else if (rest.length === 1) reason = 'единственный значимый файл тикета';
    else if (f.share >= T.targetShare) reason = `доля в диффе ${f.share.toFixed(2)} >= ${T.targetShare}`;
    else if (f.lines >= T.targetMinLines && f.share >= T.targetMinLinesShare)
      reason = `${f.lines} строк при доле ${f.share.toFixed(2)}`;
    if (reason) target.push({ ...f, role: 'target', reason });
    else supporting.push({ ...f, role: 'supporting', reason: `доля ${f.share.toFixed(2)}` });
  }

  const t = ticketByKey.get(ticket);
  result[ticket] = {
    order: t ? t.order : null,
    knownTicket: !!t,
    summary: t ? t.summary : null,
    commits: [...new Set(changes.map((c) => c.sha))],
    target: target.map(slim),
    supporting: supporting.map(slim),
    noise: noise.map((f) => ({ path: f.path, reason: f.reason })),
  };

  for (const f of [...target, ...supporting]) {
    const key = f.currentPath || f.path;
    if (!fileStats.has(key)) {
      fileStats.set(key, {
        category: null, churn: 0,
        tickets: new Set(), targetTickets: new Set(), supportingTickets: new Set(),
        firstSeen: f.date, lastSeen: f.date,
        existsInHead: !!f.currentPath, currentPath: f.currentPath,
        historicalPaths: new Set(),
      });
    }
    const s = fileStats.get(key);
    s.tickets.add(ticket);
    s.churn += f.lines;
    (f.role === 'target' ? s.targetTickets : s.supportingTickets).add(ticket);
    if (f.date < s.firstSeen) s.firstSeen = f.date;
    if (f.date > s.lastSeen) s.lastSeen = f.date;
    if (f.path !== key) s.historicalPaths.add(f.path);
  }
}

function slim(f) {
  return {
    path: f.path,
    currentPath: f.currentPath,
    existsInHead: !!f.currentPath,
    status: f.status,
    lines: f.lines,
    share: Number(f.share.toFixed(3)),
    reason: f.reason,
  };
}

// ── категория файла (частотный фильтр) ───────────────────────────────────────
const filesIndex = {};
for (const [path, s] of fileStats) {
  const ticketCount = s.tickets.size;
  let category = 'mixed';
  if (ticketCount >= T.hotTicketCount) category = 'hot';
  else if (ticketCount >= T.sharedTicketCount) category = 'shared';
  else if (ticketCount <= T.featureMaxTicketCount) category = 'feature';
  // Категория файла и роль в тикете — независимые оси: shared-файл, бывший
  // целью нескольких тикетов, сохраняет их в targetTickets и не отсеивается.
  filesIndex[path] = {
    category,
    ticketCount,
    churn: s.churn,
    targetTickets: [...s.targetTickets],
    supportingTickets: [...s.supportingTickets],
    firstSeen: s.firstSeen.slice(0, 10),
    lastSeen: s.lastSeen.slice(0, 10),
    existsInHead: s.existsInHead,
    historicalPaths: [...s.historicalPaths],
  };
}

// ── тикеты без коммитов ──────────────────────────────────────────────────────
const withCommits = new Set(Object.keys(result));
const withoutCommits = tickets
  .filter((t) => !withCommits.has(t.key))
  .map((t) => ({
    key: t.key, order: t.order, type: t.type, summary: t.summary,
    components: t.components || [], labels: t.labels || [],
  }));

writeJson(join(outDir, 'ticket-files.json'), result);
writeJson(join(outDir, 'files-index.json'), filesIndex);
writeJson(join(outDir, 'tickets-without-commits.json'), withoutCommits);

// ── отчёт ────────────────────────────────────────────────────────────────────
const allTargets = Object.values(result).reduce((s, r) => s + r.target.length, 0);
const allSupporting = Object.values(result).reduce((s, r) => s + r.supporting.length, 0);
const allNoise = Object.values(result).reduce((s, r) => s + r.noise.length, 0);

const shares = Object.values(result)
  .flatMap((r) => [...r.target, ...r.supporting].map((f) => f.share))
  .sort((a, b) => a - b);
const decile = (k) => (shares.length ? shares[Math.floor((shares.length - 1) * k)].toFixed(3) : 'n/a');

const allNoiseTickets = Object.entries(result).filter(
  ([, r]) => r.target.length === 0 && r.supporting.length === 0 && r.noise.length > 0,
);
const hugeTickets = Object.entries(result).filter(
  ([, r]) => r.target.length + r.supporting.length > (T.hugeTicketFiles ?? 40),
);
const ambiguous = readJson(join(outDir, 'ambiguous-moves.json'), []);

const topFiles = Object.entries(filesIndex)
  .sort((a, b) => b[1].ticketCount - a[1].ticketCount)
  .slice(0, 30);

writeText(
  join(outDir, 'attribution-report.md'),
  `# Отчёт по привязке файлов к тикетам

Сформирован: ${new Date().toISOString()}
HEAD: ${raw.meta.head}

## Общее

- Тикетов всего: ${tickets.length}
- Тикетов с коммитами: ${withCommits.size}
- Тикетов без коммитов: ${withoutCommits.length}
- Коммитов просмотрено: ${raw.meta.commitsScanned}
- Коммитов без ключа тикета: ${readJson(join(outDir, 'orphan-commits.json'), []).length}

## Роли файлов

| Роль | Количество |
|---|---|
| target | ${allTargets} |
| supporting | ${allSupporting} |
| noise | ${allNoise} |

## Распределение доли файла в диффе (для калибровки порогов)

| Дециль | Значение |
|---|---|
| 10% | ${decile(0.1)} |
| 25% | ${decile(0.25)} |
| 50% | ${decile(0.5)} |
| 75% | ${decile(0.75)} |
| 90% | ${decile(0.9)} |

Текущий \`targetShare\` = ${T.targetShare}.

## Топ-30 файлов по числу тикетов

| Файл | Категория | Тикетов | Был целью в |
|---|---|---|---|
${topFiles
  .map(
    ([p, s]) =>
      `| \`${p}\` | ${s.category} | ${s.ticketCount} | ${s.targetTickets.slice(0, 4).join(', ') || '—'} |`,
  )
  .join('\n')}

## Требует внимания

### Тикеты, где все файлы попали в noise (${allNoiseTickets.length})
${allNoiseTickets.slice(0, 30).map(([k]) => `- ${k}`).join('\n') || '— нет'}

### Тикеты с более чем ${T.hugeTicketFiles ?? 40} значимыми файлами (${hugeTickets.length})
${hugeTickets.slice(0, 30).map(([k, r]) => `- ${k} — ${r.target.length + r.supporting.length} файлов`).join('\n') || '— нет'}

### Неоднозначные переносы (${ambiguous.length})
${ambiguous.slice(0, 20).map((a) => `- \`${a.deleted.path}\` → ${a.candidates.map((c) => '`' + c.path + '`').join(' / ')} (по ${a.matchedBy})`).join('\n') || '— нет'}
`,
);

log(`target: ${allTargets}, supporting: ${allSupporting}, noise: ${allNoise}`);
log(`Отчёт: ${join(outDir, 'attribution-report.md')}`);
