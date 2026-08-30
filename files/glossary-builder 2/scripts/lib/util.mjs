// Общие утилиты. Без внешних зависимостей — контур без доступа в npm.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const SEP = { COMMIT: '\x01', FIELD: '\x02', BODY_END: '\x03' };

export function git(repo, args, { maxBuffer = 512 * 1024 * 1024 } = {}) {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer,
  });
}

export function gitSafe(repo, args, opts) {
  try {
    return git(repo, args, opts);
  } catch {
    return null;
  }
}

// git экранирует пути с не-ASCII/спецсимволами в кавычки — разворачиваем обратно
export function unquotePath(p) {
  if (!p.startsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[++i];
    const simple = { n: 10, t: 9, r: 13, '\\': 92, '"': 34 };
    if (next in simple) {
      bytes.push(simple[next]);
    } else {
      bytes.push(parseInt(body.substr(i, 3), 8));
      i += 2;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Минимальный glob: поддерживает **, *, ? — этого достаточно для масок исключений
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

export function makeMatcher(patterns) {
  const res = patterns.map(globToRegExp);
  return (path) => res.some((r) => r.test(path));
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

export function loadConfig(explicitPath) {
  const path = resolve(explicitPath || process.env.GLOSSARY_CONFIG || 'glossary.config.json');
  if (!existsSync(path)) {
    fail(
      `Конфиг не найден: ${path}\n` +
        `Создайте его из config.example.json или укажите путь через --config / GLOSSARY_CONFIG.`,
    );
  }
  return { config: readJson(path), configPath: path };
}

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

export function log(...m) {
  process.stderr.write(m.join(' ') + '\n');
}

export function fail(msg) {
  process.stderr.write('\nОШИБКА: ' + msg + '\n\n');
  process.exit(1);
}

export function progress(label, done, total) {
  if (done % 25 !== 0 && done !== total) return;
  process.stderr.write(`\r  ${label}: ${done}/${total}`);
  if (done === total) process.stderr.write('\n');
}

export function jaccard(aText, bText) {
  const norm = (t) =>
    new Set(
      t
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
  const a = norm(aText);
  const b = norm(bText);
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const line of a) if (b.has(line)) inter++;
  return inter / (a.size + b.size - inter);
}

export function basename(p) {
  return p.split('/').pop();
}

export function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 86400000;
}
