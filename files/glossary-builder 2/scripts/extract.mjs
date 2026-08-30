#!/usr/bin/env node
// extract.mjs — дорогой детерминированный проход по git.
// Ничего не решает про «важность» файла: только собирает факты.
// Выход: out/raw-attribution.json, out/path-history.json,
//        out/orphan-commits.json, out/ambiguous-moves.json
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  git, gitSafe, unquotePath, readJson, writeJson, loadConfig, arg,
  log, fail, progress, jaccard, basename, daysBetween,
} from './lib/util.mjs';

const { config } = loadConfig(arg('config'));
const repo = resolve(config.repo.path);
const outDir = resolve(config.output?.dir || 'out');

if (!existsSync(join(repo, '.git'))) fail(`Не похоже на git-репозиторий: ${repo}`);

// ── проверка, что мы ничего не сломаем ───────────────────────────────────────
const dirty = git(repo, ['status', '--porcelain']).trim();
if (dirty) log('ВНИМАНИЕ: в рабочем дереве есть незакоммиченные изменения. Скрипт их не тронет.');

const ref = config.repo.ref || 'HEAD';
const head = git(repo, ['rev-parse', ref]).trim();
const keyRe = new RegExp(config.tickets.keyPattern, 'g');

// ── диапазон истории ─────────────────────────────────────────────────────────
const ticketsFile = resolve(config.tickets.file);
const ticketsDoc = readJson(ticketsFile);
if (!ticketsDoc) fail(`Не найден ${ticketsFile}. Сначала выполните шаг выгрузки Jira.`);
const tickets = ticketsDoc.tickets || [];
if (tickets.length === 0) fail('В tickets.json нет тикетов.');

const earliest = tickets
  .map((t) => t.created)
  .filter(Boolean)
  .sort()[0];
const since = new Date(new Date(earliest).getTime() - 30 * 86400000).toISOString().slice(0, 10);
const knownKeys = new Set(tickets.map((t) => t.key));

log(`Репозиторий: ${repo}`);
log(`HEAD: ${head.slice(0, 10)}`);
log(`Диапазон истории: с ${since}`);

// ── парсер вывода git log -z ─────────────────────────────────────────────────
function splitCommits(output) {
  return output
    .split('\x01')
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf('\x03');
      const header = chunk.slice(0, end);
      const tokens = chunk
        .slice(end + 1)
        .split('\0')
        .map((t) => t.replace(/^\n/, ''))
        .filter((t) => t !== '');
      return { header, tokens };
    });
}

function parseNumstat(tokens) {
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const parts = tokens[i].split('\t');
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, pathRaw] = parts;
    const isBinary = addedRaw === '-' || deletedRaw === '-';
    const added = isBinary ? 0 : parseInt(addedRaw, 10) || 0;
    const deleted = isBinary ? 0 : parseInt(deletedRaw, 10) || 0;
    if (pathRaw === '') {
      const from = unquotePath(tokens[++i]);
      const to = unquotePath(tokens[++i]);
      rows.push({ path: to, renamedFrom: from, added, deleted, isBinary });
    } else {
      rows.push({ path: unquotePath(pathRaw), renamedFrom: null, added, deleted, isBinary });
    }
  }
  return rows;
}

function parseNameStatus(tokens) {
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (/^[RC]/.test(status)) {
      const from = unquotePath(tokens[++i]);
      const to = unquotePath(tokens[++i]);
      rows.push({ path: to, renamedFrom: from, status: status[0], similarity: parseInt(status.slice(1), 10) });
    } else {
      rows.push({ path: unquotePath(tokens[++i]), renamedFrom: null, status: status[0], similarity: null });
    }
  }
  return rows;
}

const renameThreshold = config.repo.renameThreshold ?? 30;
const baseArgs = [
  'log', ref, '-z', `--since=${since}`,
  `--find-renames=${renameThreshold}%`, '--find-copies',
];
if (config.repo.includeMerges === false || config.repo.includeMerges === undefined) {
  baseArgs.push('--no-merges');
}

// ── проход 1: numstat + метаданные коммита ───────────────────────────────────
log('Проход 1/4: numstat');
const pass1 = splitCommits(
  git(repo, [...baseArgs, '--numstat', `--format=\x01%H\x02%P\x02%aI\x02%an\x02%B\x03`]),
);

const commits = new Map();
for (const { header, tokens } of pass1) {
  const [sha, parents, date, author, body] = header.split('\x02');
  const ticketMatches = [...new Set((body.match(keyRe) || []))];
  commits.set(sha, {
    sha,
    date,
    author,
    subject: body.split('\n')[0],
    parents: parents.trim() ? parents.trim().split(' ') : [],
    tickets: ticketMatches,
    files: new Map(parseNumstat(tokens).map((r) => [r.path, r])),
  });
}
log(`  коммитов: ${commits.size}`);

// ── проход 2: name-status ────────────────────────────────────────────────────
log('Проход 2/4: name-status');
for (const { header, tokens } of splitCommits(
  git(repo, [...baseArgs, '--name-status', `--format=\x01%H\x03`]),
)) {
  const c = commits.get(header);
  if (!c) continue;
  for (const row of parseNameStatus(tokens)) {
    const f = c.files.get(row.path);
    if (f) {
      f.status = row.status;
      f.similarity = row.similarity;
      if (row.renamedFrom) f.renamedFrom = row.renamedFrom;
    }
  }
}

// ── проход 3: numstat без учёта пробелов ─────────────────────────────────────
log('Проход 3/4: numstat -w (детект форматирования)');
for (const { header, tokens } of splitCommits(
  git(repo, [...baseArgs, '-w', '--ignore-blank-lines', '--numstat', `--format=\x01%H\x03`]),
)) {
  const c = commits.get(header);
  if (!c) continue;
  for (const row of parseNumstat(tokens)) {
    const f = c.files.get(row.path);
    if (f) {
      f.addedIgnoringWhitespace = row.added;
      f.deletedIgnoringWhitespace = row.deleted;
    }
  }
}
// файл, не попавший в -w проход, изменился только пробелами
for (const c of commits.values()) {
  for (const f of c.files.values()) {
    if (f.addedIgnoringWhitespace === undefined) {
      f.addedIgnoringWhitespace = 0;
      f.deletedIgnoringWhitespace = 0;
    }
    if (!f.status) f.status = 'M';
  }
}

// ── проход 4: построчный diff для мелких правок ──────────────────────────────
// Нужен только чтобы отличить import-only и comment-only. Дорого, поэтому
// только для коммитов, укладывающихся в лимит, и только для мелких файлов.
const smallFileLimit = config.repo.lineDiffMaxFileLines ?? 50;
const smallCommitLimit = config.repo.lineDiffMaxCommitLines ?? 400;
const relevantCommits = [...commits.values()].filter((c) => c.tickets.length > 0);
const needLineDiff = relevantCommits.filter((c) => {
  const total = [...c.files.values()].reduce((s, f) => s + f.added + f.deleted, 0);
  return total > 0 && total <= smallCommitLimit;
});

log(`Проход 4/4: построчный diff (${needLineDiff.length} коммитов)`);
const IMPORT_RE = /^[+-]\s*(import|export)\b.*\bfrom\b/;
const COMMENT_RE = /^[+-]\s*(\/\/|\/\*|\*|#)/;

needLineDiff.forEach((c, i) => {
  const diff = gitSafe(repo, ['show', '--format=', '--unified=0', '--no-color', c.sha], {
    maxBuffer: 64 * 1024 * 1024,
  });
  progress('построчный diff', i + 1, needLineDiff.length);
  if (!diff) return;
  let current = null;
  const lines = { };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = unquotePath(line.slice(6));
      lines[current] = [];
    } else if (line.startsWith('+++ /dev/null')) {
      current = null;
    } else if (current && /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) {
      lines[current].push(line);
    }
  }
  for (const [path, changed] of Object.entries(lines)) {
    const f = c.files.get(path);
    if (!f || changed.length === 0 || f.added + f.deleted > smallFileLimit) continue;
    f.importOnly = changed.every((l) => IMPORT_RE.test(l));
    f.commentOnly = changed.every((l) => COMMENT_RE.test(l));
    const plus = changed.filter((l) => l[0] === '+').map(strip);
    const minus = changed.filter((l) => l[0] === '-').map(strip);
    f.punctuationOnlyCandidate =
      plus.length > 0 && plus.length === minus.length && plus.every((l, k) => l === minus[k]);
  }
});

function strip(l) {
  return l.slice(1).replace(/[\s'"`;,]/g, '');
}

// ── дерево HEAD ──────────────────────────────────────────────────────────────
const headFiles = new Set(
  git(repo, ['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean).map(unquotePath),
);

// ── переименования: цепочки ──────────────────────────────────────────────────
const renameEvents = [];
for (const c of commits.values()) {
  for (const f of c.files.values()) {
    if (f.renamedFrom) {
      renameEvents.push({
        from: f.renamedFrom, to: f.path, sha: c.sha, date: c.date,
        source: 'git-rename', confidence: 'high',
      });
    }
  }
}

// ── шаг 3b: резервное распознавание переносов ────────────────────────────────
log('Резервное распознавание переносов');
const matchedInCommit = new Set();
for (const c of commits.values()) {
  for (const f of c.files.values()) {
    if (f.renamedFrom) {
      matchedInCommit.add(`${c.sha}:${f.path}`);
      matchedInCommit.add(`${c.sha}:${f.renamedFrom}`);
    }
  }
}

const orphanDeletes = [];
const orphanAdds = [];
for (const c of commits.values()) {
  for (const f of c.files.values()) {
    const id = `${c.sha}:${f.path}`;
    if (matchedInCommit.has(id) || f.isBinary) continue;
    if (f.status === 'D') orphanDeletes.push({ sha: c.sha, date: c.date, path: f.path });
    if (f.status === 'A') orphanAdds.push({ sha: c.sha, date: c.date, path: f.path });
  }
}
log(`  осиротевших удалений: ${orphanDeletes.length}, созданий: ${orphanAdds.length}`);

const windowDays = config.repo.moveWindowDays ?? 90;
const simThreshold = config.repo.fallbackSimilarity ?? 0.5;
const blobCache = new Map();

function blobHash(sha, path, parent) {
  const key = `${sha}${parent ? '^' : ''}:${path}`;
  if (!blobCache.has(key)) blobCache.set(key, (gitSafe(repo, ['rev-parse', key]) || '').trim() || null);
  return blobCache.get(key);
}
const contentCache = new Map();
function blobContent(sha, path, parent) {
  const key = `${sha}${parent ? '^' : ''}:${path}`;
  if (!contentCache.has(key)) contentCache.set(key, gitSafe(repo, ['show', key]) || '');
  return contentCache.get(key);
}

const ambiguous = [];
const usedAdds = new Set();

for (const del of orphanDeletes) {
  const inWindow = orphanAdds.filter(
    (a) =>
      // тот же путь — это собственное рождение файла, а не перенос
      a.path !== del.path &&
      !usedAdds.has(`${a.sha}:${a.path}`) &&
      daysBetween(a.date, del.date) <= windowDays,
  );
  if (inWindow.length === 0) continue;

  let hits = [];
  let scores = null;
  let source = null;
  let confidence = null;

  // правило 1 — точное совпадение содержимого
  const delHash = blobHash(del.sha, del.path, true);
  if (delHash) {
    hits = inWindow.filter((a) => blobHash(a.sha, a.path, false) === delHash);
    if (hits.length) {
      source = 'exact-blob';
      confidence = 'exact';
    }
  }

  // правило 2 — совпадение имени файла
  if (hits.length === 0) {
    hits = inWindow.filter((a) => basename(a.path) === basename(del.path));
    if (hits.length) {
      source = 'basename';
      confidence = 'high';
    }
  }

  // правило 3 — схожесть содержимого
  if (hits.length === 0) {
    const delText = blobContent(del.sha, del.path, true);
    if (delText) {
      const scored = inWindow
        .map((a) => ({ a, score: jaccard(delText, blobContent(a.sha, a.path, false)) }))
        .filter((x) => x.score >= simThreshold)
        .sort((x, y) => y.score - x.score);
      if (scored.length) {
        hits = scored.map((x) => x.a);
        scores = scored.map((x) => Number(x.score.toFixed(3)));
        source = 'similarity';
        confidence = 'medium';
      }
    }
  }

  if (hits.length === 1) {
    usedAdds.add(`${hits[0].sha}:${hits[0].path}`);
    renameEvents.push({
      from: del.path, to: hits[0].path, sha: hits[0].sha, date: hits[0].date, source, confidence,
    });
  } else if (hits.length > 1) {
    ambiguous.push({
      reason: 'несколько кандидатов — возможно, файл разделили на несколько',
      deleted: del,
      candidates: hits.map((a, i) => ({
        path: a.path, sha: a.sha, date: a.date, similarity: scores ? scores[i] : null,
      })),
      matchedBy: source,
    });
  }
}

// цепочки переименований → path-history
renameEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
const forward = new Map();
for (const e of renameEvents) forward.set(e.from, e);

const pathHistory = {};
const allHistoricalPaths = new Set();
for (const c of commits.values()) for (const f of c.files.values()) allHistoricalPaths.add(f.path);
for (const e of renameEvents) allHistoricalPaths.add(e.from);

for (const start of allHistoricalPaths) {
  const chain = [];
  let cur = start;
  const seen = new Set([cur]);
  while (forward.has(cur)) {
    const e = forward.get(cur);
    if (seen.has(e.to)) break;
    chain.push(e);
    cur = e.to;
    seen.add(cur);
  }
  pathHistory[start] = {
    currentPath: headFiles.has(cur) ? cur : null,
    existsInHead: headFiles.has(cur),
    chain,
  };
}

// ── сборка выхода ────────────────────────────────────────────────────────────
const changes = [];
const orphanCommits = [];
for (const c of commits.values()) {
  if (c.tickets.length === 0) {
    orphanCommits.push({ sha: c.sha, date: c.date, author: c.author, subject: c.subject });
    continue;
  }
  for (const t of c.tickets) {
    for (const f of c.files.values()) {
      const hist = pathHistory[f.path];
      changes.push({
        ticket: t,
        knownTicket: knownKeys.has(t),
        sha: c.sha,
        date: c.date,
        path: f.path,
        currentPath: hist ? hist.currentPath : (headFiles.has(f.path) ? f.path : null),
        status: f.status,
        renamedFrom: f.renamedFrom || null,
        added: f.added,
        deleted: f.deleted,
        addedIgnoringWhitespace: f.addedIgnoringWhitespace,
        deletedIgnoringWhitespace: f.deletedIgnoringWhitespace,
        importOnly: f.importOnly ?? null,
        commentOnly: f.commentOnly ?? null,
        punctuationOnlyCandidate: f.punctuationOnlyCandidate ?? null,
        isBinary: f.isBinary,
      });
    }
  }
}

writeJson(join(outDir, 'raw-attribution.json'), {
  meta: {
    repo, head, ref, generatedAt: new Date().toISOString(),
    since, commitsScanned: commits.size,
    renameThreshold, moveWindowDays: windowDays, fallbackSimilarity: simThreshold,
  },
  commits: [...commits.values()]
    .filter((c) => c.tickets.length > 0)
    .map(({ sha, date, author, subject, tickets }) => ({ sha, date, author, subject, tickets })),
  changes,
});
writeJson(join(outDir, 'path-history.json'), pathHistory);
writeJson(join(outDir, 'orphan-commits.json'), orphanCommits);
writeJson(join(outDir, 'ambiguous-moves.json'), ambiguous);

// ── стоп-сигналы, требующие решения человека ─────────────────────────────────
const orphanShare = orphanCommits.length / Math.max(commits.size, 1);
const ticketsWithCommits = new Set(changes.map((c) => c.ticket));
const noCommitShare =
  tickets.filter((t) => !ticketsWithCommits.has(t.key)).length / Math.max(tickets.length, 1);

log('');
log(`Готово. Изменений файлов: ${changes.length}`);
log(`Коммитов без ключа тикета: ${orphanCommits.length} (${(orphanShare * 100).toFixed(1)}%)`);
log(`Тикетов без коммитов: ${(noCommitShare * 100).toFixed(1)}%`);
log(`Неоднозначных переносов: ${ambiguous.length}`);

if (orphanShare > 0.05) {
  log('');
  log('!!! СТОП: более 5% коммитов не содержат ключа тикета.');
  log('!!! Схема привязки под вопросом. Не продолжайте автоматически — покажите это человеку.');
}
if (noCommitShare > 0.5) {
  log('');
  log('!!! СТОП: более половины тикетов не имеют коммитов.');
  log('!!! Возможно, ключи есть только в merge-коммитах или в MR. Покажите это человеку.');
}
