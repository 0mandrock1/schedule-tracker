# schedule-tracker

Task tracker де **джерело правди — Google Calendar**, не БД. Кожна подія календаря = задача; статус живе прямо на події (title prefix + colorId), не в окремому сторі.

## Стек
Node 22 (nvm) / Express 5 / better-sqlite3 / googleapis / node-ical. Vanilla JS фронтенд (`public/index.html`), без білд-степу, без фреймворку.

## Структура
- `server.js` — Express-роутинг, `requirePasscode` middleware на всі `/schedule-tracker-api/*`.
- `calendar.js` — authed Google Calendar клієнт, iCal-фетч з кешем 60с (`icalCache`), write-операції (`setEventStatus`, `setEventMarkers`) через `cal.events.patch` на конкретний instance, не master event.
- `db.js` — SQLite (`tracker.db`, gitignored). **Не джерело правди для статусу** — тільки дзеркало для лічильника, pomodoro-лог, legacy-історія.
- `auth.js` / `setup-auth.js` — Google OAuth (Web application client, не deprecated installed-app flow), пише `config/token.json` (gitignored).
- `public/index.html` — SPA, passcode-гейт, день-лист, pomodoro-кнопки, лічильник.
- `migrate-legacy-to-calendar.js` — одноразовий скрипт, не чіпати без причини.

## Команди
Нема test/lint/build скриптів (`package.json` порожній на цьому фронті — не вигадувати неіснуючі).
```bash
npm install
node server.js                          # прямий запуск
systemctl restart schedule-tracker      # прод-деплой (systemd unit, User=root)
journalctl -u schedule-tracker -n 50    # логи
```
Прод: порт 3464 (`PORT` env), проксується nginx на `mandrock-files.duckdns.org/schedule-tracker/` і `/schedule-tracker-api/`. Systemd `Environment=` рядки — єдине джерело `PORT`/`SCHEDULE_PASSCODE`/`ICAL_URL` у проді, не `.env` файл (його зараз нема).

## Конвенції
- **Google Calendar — джерело правди статусу**, sqlite — ні. Будь-яка нова "категорія" статусу означає розширення title-prefix/colorId схеми в `calendar.js`, не просто нову колонку в БД. Не міняти цю архітектуру мовчки.
- Write-операції завжди резолвлять конкретний instance event id (`resolveInstanceEventId`) перед `patch`/`delete` — recurring events інакше ламаються (чіпають master замість occurrence).
- Секрети (OAuth client, token.json, VAPID приватний ключ) — ніколи в git. `config/` в `.gitignore`. Нові секрети класти в Craft `🔑 Credentials & API Keys` (rootBlockId `a2f756ac-f003-f256-d616-8b8c0c70e651`), той самий паттерн що video-stash/telegram credentials там.
- `x-passcode` header (або `?passcode=`) гейтить усі `/schedule-tracker-api/*` — нові ендпоінти йдуть під той самий `requirePasscode` middleware, не окремий.
- Frontend — без білд-степу, чистий JS в одному `index.html`. Не тягнути React/бандлер заради малих фіч.
- Комітити й пушити в `origin main` після кожного завершеного логічного шматка роботи, не накопичувати один величезний diff.

## Агенти / команди
Проєктно-специфічних сабагентів нема. Загальні claudekit (code-review, refactoring, database) — застосовувати за потребою, не форсити.

## MCP
Не використовується в рантаймі проєкту (Calendar API — напряму через googleapis, не MCP). Якщо треба глянути на секрети/нотатки — Craft MCP (`Craft:craft_read`/`craft_write`), документ credentials вище.

## Reading rules / token optimization
- Читай лише релевантні файли. Спершу `/code-search` для пошуку, не сліпий обхід дерева.
- Не перечитуй CLAUDE.md — він уже в контексті.
- Не вантаж великі файли цілком, якщо вистачає фрагмента; читай по діапазону рядків.
- Не дублюй контекст і не переказуй уже відоме. Compressed prose: імператив, без вступів/підсумків, один факт — один раз.
- Перед записом — переконайся, що зміни мінімальні й точкові; не роздувай рішення.
- Мутуюча дія → звірка з реальним станом (re-read зміненого, тест), не з припущенням.
