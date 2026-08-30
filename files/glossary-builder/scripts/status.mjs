#!/usr/bin/env node
// status.mjs — где мы сейчас. Показывает очередь тикетов и следующий на обработку.
// Прогресс хранится в out/progress.json, его пишет мастер-агент через
// `node scripts/status.mjs --done PROJ-1204`.
import { resolve, join } from 'node:path';
import { readJson, writeJson, loadConfig, arg, log } from './lib/util.mjs';

const { config } = loadConfig(arg('config'));
const outDir = resolve(config.output?.dir || 'out');
const progressPath = join(outDir, 'progress.json');

const ticketFiles = readJson(join(outDir, 'ticket-files.json')) || {};
const withoutCommits = readJson(join(outDir, 'tickets-without-commits.json')) || [];
const state = readJson(progressPath, { done: [], skipped: [], startedAt: null });

const done = new Set(state.done);
const skipped = new Set(state.skipped);

const markDone = arg('done');
const markSkipped = arg('skip');
const reset = arg('reset', false) === true;

if (reset) {
  writeJson(progressPath, { done: [], skipped: [], startedAt: new Date().toISOString() });
  log('Прогресс сброшен.');
  process.exit(0);
}
if (typeof markDone === 'string') {
  done.add(markDone);
  writeJson(progressPath, {
    ...state, done: [...done], skipped: [...skipped],
    startedAt: state.startedAt || new Date().toISOString(),
  });
  log(`Отмечен как обработанный: ${markDone}`);
}
if (typeof markSkipped === 'string') {
  skipped.add(markSkipped);
  writeJson(progressPath, {
    ...state, done: [...done], skipped: [...skipped],
    startedAt: state.startedAt || new Date().toISOString(),
  });
  log(`Отмечен как пропущенный: ${markSkipped}`);
}

// Очередь строго по возрастанию order: поздний тикет перекрывает ранний.
const queue = Object.entries(ticketFiles)
  .map(([key, r]) => ({ key, ...r }))
  .filter((t) => t.order !== null)
  .sort((a, b) => a.order - b.order);

const pending = queue.filter((t) => !done.has(t.key) && !skipped.has(t.key));
const pilot = config.glossary.pilotTickets || [];
const pilotPending = pilot.filter((k) => !done.has(k) && !skipped.has(k));

log('');
log(`Всего тикетов с коммитами: ${queue.length}`);
log(`Обработано: ${done.size} | Пропущено: ${skipped.size} | Осталось: ${pending.length}`);
log(`Тикетов без коммитов (отдельная очередь): ${withoutCommits.length}`);
if (pilot.length) log(`Пилотных тикетов осталось: ${pilotPending.length} из ${pilot.length}`);
log('');

const next = pilotPending.length
  ? queue.find((t) => t.key === pilotPending[0])
  : pending[0];

if (!next) {
  log('Очередь пуста.');
} else {
  log('СЛЕДУЮЩИЙ ТИКЕТ:');
  log(`  ${next.key} (order ${next.order}) — ${next.summary || 'без описания'}`);
  log(`  target: ${next.target.length}, supporting: ${next.supporting.length}, noise: ${next.noise.length}`);
  log('');
  log('  Файлы-цели:');
  for (const f of next.target) log(`    ${f.currentPath || f.path}  [${f.reason}]`);
}
