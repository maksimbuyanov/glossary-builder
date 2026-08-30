# Перенос в закрытый контур

## 1. Проверка архива

```bash
tar -tzf glossary-builder.tar.gz | head -40
sha256sum glossary-builder.tar.gz
```

Внутри только текст: `.mjs`, `.md`, `.json`. Ни бинарников, ни `node_modules`,
ни сетевых обращений в коде — проверяется грепом:

```bash
grep -rn "fetch(\|http://\|https://" scripts/
```

Единственное вхождение — `restFetch` в `jira-export.mjs`, обращение к вашей
внутренней Jira по адресу из конфига. В режиме `--mode manual` не используется
вообще.

## 2. Распаковка и установка

```bash
tar -xzf glossary-builder.tar.gz
qwen extensions install ./glossary-builder
```

Проверка: `/extensions` → в списке `glossary-builder`; `/agents manage` →
раздел Extension Agents содержит три агента.

## 3. Настройка

```bash
cd /path/to/frontend-repo
cp ~/.qwen/extensions/glossary-builder/config.example.json glossary.config.json
```

Заполнить обязательно: `jira.baseUrl`, `jira.projectKey`, `tickets.keyPattern`,
`scope.resolvedAfter`, `glossary.chapters`, `glossary.pilotTickets`.

Токен Jira — через переменную окружения, не в конфиг:

```bash
export JIRA_TOKEN=...
```

Дальше — `/glossary:init` в Qwen Code.

## 4. Дымовой тест без Jira

Убедиться, что git-часть работает, можно не дожидаясь доступа к Jira. Создайте
минимальный `out/tickets.json`:

```json
{ "meta": {}, "sprints": [], "tickets": [
  { "key": "PROJ-1", "order": 0, "summary": "проверка",
    "created": "2025-08-01T00:00:00.000+0000",
    "resolutiondate": "2025-08-02T00:00:00.000+0000", "sprints": [] }
]}
```

и запустите:

```bash
node ~/.qwen/extensions/glossary-builder/scripts/extract.mjs
node ~/.qwen/extensions/glossary-builder/scripts/classify.mjs
```

Скрипт пройдёт по истории и почти наверняка напечатает `!!! СТОП` про долю
коммитов без ключа — на одном фиктивном тикете это ожидаемо. Важно другое: что он
отработал без ошибок и создал файлы в `out/`.

## 5. Если что-то не так

- **`Конфиг не найден`** — запускайте из каталога с `glossary.config.json` либо
  передавайте `--config /путь/glossary.config.json`.
- **`ENOBUFS` или обрыв на большом репозитории** — уменьшите диапазон через
  `scope.resolvedAfter`. Лимит буфера уже поднят до 512 МБ, но история за четыре
  года может его превысить.
- **Долгий проход 4/4** — это построчный diff. Уменьшите
  `repo.lineDiffMaxCommitLines`; потеряется только детект import-only и
  comment-only на крупных коммитах.
- **Пустой `ticket-files.json`** — не совпал `tickets.keyPattern` с реальным
  форматом ключей в сообщениях коммитов. Проверьте: `git log --oneline | head -30`.
- **Все файлы уходят в noise** — перекручены пороги. Смотрите децили в
  `out/attribution-report.md` и правьте `targetShare`, затем перезапускайте только
  `classify.mjs`.
