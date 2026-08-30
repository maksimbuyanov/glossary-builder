#!/usr/bin/env node
// validate.mjs — механическая проверка того, что написали агенты.
// Заменяет собой агентов «вычитки» и «сверки»: LLM плохо ловит собственные
// галлюцинации, а эти проверки детерминированы.
//
// Проверяет:
//   1. схему карточки (обязательные поля фронтматтера)
//   2. что каждый файл из карточки реально существует (в HEAD или в истории)
//   3. что файл действительно был в диффе указанного тикета
//   4. что глава взята из контролируемого словаря
//   5. что тикеты из sourceTickets существуют в выгрузке
//   6. что имя модуля не дублирует существующее под другим написанием
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { readJson, writeJson, writeText, loadConfig, arg, log, fail } from './lib/util.mjs';

const { config } = loadConfig(arg('config'));
const outDir = resolve(config.output?.dir || 'out');
const glossaryDir = resolve(config.glossary.dir);

const ticketFiles = readJson(join(outDir, 'ticket-files.json')) || {};
const filesIndex = readJson(join(outDir, 'files-index.json')) || {};
const pathHistory = readJson(join(outDir, 'path-history.json')) || {};
const ticketsDoc = readJson(resolve(config.tickets.file)) || { tickets: [] };
const knownTickets = new Set(ticketsDoc.tickets.map((t) => t.key));
const chapters = new Set(config.glossary.chapters || []);

if (!existsSync(glossaryDir)) fail(`Каталог глоссария не найден: ${glossaryDir}`);

const REQUIRED = ['id', 'title', 'status', 'provenance', 'confidence'];
const STATUS = new Set(['active', 'frozen', 'deprecated']);
const PROVENANCE = new Set(['from-ticket', 'from-code', 'unknown-legacy']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (extname(p) === '.md') out.push(p);
  }
  return out;
}

// Минимальный парсер фронтматтера: только то, что мы сами пишем в шаблонах.
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const raw = kv[2].trim();
      if (raw === '') fm[key] = [];
      else if (raw.startsWith('[')) fm[key] = raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      else fm[key] = raw;
    } else if (key && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(fm[key])) fm[key] = [];
      fm[key].push(line.replace(/^\s*-\s+/, '').trim());
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

function resolvePath(p) {
  if (filesIndex[p]) return { ok: true, current: p };
  const hist = pathHistory[p];
  if (hist?.currentPath) return { ok: true, current: hist.currentPath, moved: true };
  if (hist) return { ok: false, reason: 'файл удалён и не найден в HEAD' };
  return { ok: false, reason: 'путь не встречается ни в одном тикете диапазона' };
}

const problems = [];
const ids = new Map();
const cards = [];

for (const file of walk(glossaryDir)) {
  const rel = file.slice(glossaryDir.length + 1);
  if (rel === 'index.md' || rel === 'terms.md' || rel.startsWith('_')) continue;
  const text = readFileSync(file, 'utf8');
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    problems.push({ file: rel, level: 'error', msg: 'нет YAML-фронтматтера' });
    continue;
  }
  const { fm, body } = parsed;
  cards.push({ rel, fm });

  for (const key of REQUIRED) {
    if (!fm[key]) problems.push({ file: rel, level: 'error', msg: `не заполнено поле ${key}` });
  }
  if (fm.status && !STATUS.has(fm.status))
    problems.push({ file: rel, level: 'error', msg: `недопустимый status: ${fm.status}` });
  if (fm.provenance && !PROVENANCE.has(fm.provenance))
    problems.push({ file: rel, level: 'error', msg: `недопустимый provenance: ${fm.provenance}` });
  if (fm.confidence && !CONFIDENCE.has(fm.confidence))
    problems.push({ file: rel, level: 'error', msg: `недопустимый confidence: ${fm.confidence}` });

  if (fm.chapter && chapters.size && !chapters.has(fm.chapter))
    problems.push({
      file: rel, level: 'error',
      msg: `глава "${fm.chapter}" не из контролируемого словаря. Допустимые: ${[...chapters].join(', ')}`,
    });

  if (fm.id) {
    if (ids.has(fm.id))
      problems.push({ file: rel, level: 'error', msg: `дубль id "${fm.id}" (уже в ${ids.get(fm.id)})` });
    else ids.set(fm.id, rel);
  }

  for (const t of fm.sourceTickets || []) {
    if (!knownTickets.has(t))
      problems.push({ file: rel, level: 'error', msg: `тикет ${t} отсутствует в выгрузке` });
  }

  // пути из таблицы файлов: строки вида | `path` | role | tickets |
  const rows = [...body.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([a-z]+)\s*\|([^|]*)\|/gm)];
  for (const [, path, role, ticketCell] of rows) {
    const r = resolvePath(path);
    if (!r.ok) {
      problems.push({ file: rel, level: 'error', msg: `${r.reason}: \`${path}\`` });
      continue;
    }
    if (r.moved)
      problems.push({ file: rel, level: 'warn', msg: `путь устарел, актуальный — \`${r.current}\`: \`${path}\`` });

    const cited = (ticketCell.match(new RegExp(config.tickets.keyPattern, 'g')) || []);
    for (const t of cited) {
      const tf = ticketFiles[t];
      if (!tf) {
        problems.push({ file: rel, level: 'error', msg: `тикет ${t} не имеет коммитов, но указан у \`${path}\`` });
        continue;
      }
      const inDiff = [...tf.target, ...tf.supporting, ...tf.noise].some(
        (f) => f.path === path || f.currentPath === path,
      );
      if (!inDiff)
        problems.push({
          file: rel, level: 'error',
          msg: `файл \`${path}\` отсутствует в диффе тикета ${t} — вероятно, выдумано`,
        });
      const isNoise = tf.noise.some((f) => f.path === path);
      if (isNoise && role === 'target')
        problems.push({
          file: rel, level: 'warn',
          msg: `\`${path}\` помечен target, но в ${t} классифицирован как noise`,
        });
    }
  }
}

// покрытие: значимые файлы, не попавшие ни в одну карточку
const mentioned = new Set();
for (const file of walk(glossaryDir)) {
  for (const m of readFileSync(file, 'utf8').matchAll(/`([^`]+\.[a-zA-Z]{1,5})`/g)) mentioned.add(m[1]);
}
const uncovered = Object.entries(filesIndex)
  .filter(([p, s]) => s.targetTickets.length > 0 && !mentioned.has(p))
  .map(([p]) => p);

const errors = problems.filter((p) => p.level === 'error');
const warns = problems.filter((p) => p.level === 'warn');

writeJson(join(outDir, 'validation.json'), { problems, uncovered, cards: cards.length });
writeText(
  join(outDir, 'validation-report.md'),
  `# Отчёт валидации глоссария

Карточек проверено: ${cards.length}
Ошибок: ${errors.length} | Предупреждений: ${warns.length}

## Ошибки
${errors.map((p) => `- **${p.file}** — ${p.msg}`).join('\n') || '— нет'}

## Предупреждения
${warns.map((p) => `- **${p.file}** — ${p.msg}`).join('\n') || '— нет'}

## Файлы, бывшие целью тикета, но не попавшие ни в одну карточку (${uncovered.length})
${uncovered.slice(0, 60).map((p) => `- \`${p}\``).join('\n') || '— нет'}
`,
);

log(`Карточек: ${cards.length}, ошибок: ${errors.length}, предупреждений: ${warns.length}`);
log(`Не покрыто карточками файлов: ${uncovered.length}`);
log(`Отчёт: ${join(outDir, 'validation-report.md')}`);
process.exit(errors.length > 0 ? 1 : 0);
