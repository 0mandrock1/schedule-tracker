# schedule-tracker

**Переархітектуровано 2026-07-31.** Джерело правди — власний стор (`projects`/`captures` у sqlite), не Google Calendar. Стара Calendar-backed версія (title-prefix `✅ `/`❌ ` + colorId на події) заморожена як окремий sellable продукт у `/root/projects/schedule-tracker-gcal/` (тег `gcal-v1` у цьому репо) — не чіпати, туди нові фічі не йдуть.

Одна тема/проєкт (`projects`) торкається щодня через `captures` (день = запис: які проєкти торкнув, енергія 1-5, одна річ на завтра, опційний нотатка/voice-транскрипт). Пушиться раз на добу з Telegram-бота `evening-checkin` (`/root/projects/tg_bots/evening-checkin/`), не з календаря. Google Calendar лишився **тільки read-only джерелом реальних зустрічей** (події з attendees або тегом `[meet]` у title) — жодних записів статусу в Calendar більше немає.

## Стек
Node 22 (nvm) / Express 5 / better-sqlite3 / node-ical. Vanilla JS фронтенд (`public/index.html`), без білд-степу, без фреймворку.

## Структура
- `server.js` — Express-роутинг, `requirePasscode` middleware на всі `/schedule-tracker-api/*`.
- `store.js` — вся бізнес-логіка проєктів/captures: CRUD проєктів, `projectsMenu`, `upsertCapture` (partial-update aware — bot дописує note/voice окремим викликом, не перезаписуючи topics/energy/tomorrow), `stats`, `getDay` (pull для `/day`), park sweep (active без touch 14+ днів → parked).
- `calendar.js` — **тільки читання**: iCal-фетч (публічний `ICAL_URL`, кеш 60с) + `getMeetingsInRange` (attendees/`[meet]`-фільтр). Жодних Calendar API write-викликів, жодного OAuth — публічного iCal фіда досить.
- `db.js` — SQLite (`tracker.db`, gitignored). Нові таблиці: `projects`, `captures`, `parked_reviews`, `dashboard_opens` (джерело правди для тем/трекінгу). Старі `tasks`/`legacy_history`/`pomodoro_*`/`push_subscriptions` лишились не чіпані (historical/pomodoro — не в скоупі переархітектури), `tasks` тепер нічим не наповнюється (Calendar-write endpoints видалені).
- `public/index.html` — read-only дашборд: coverage (N/30), історія captures, проєкти по статусах. Без редагування, без pomodoro-UI (pomodoro-бекенд лишився недоторканим, просто не показаний у новому фронті).
- `pomodoro.js` — не займаний цією переархітектурою, ендпоінти `/pomodoro/*` лишились.
- `migrate-legacy-to-calendar.js` — одноразовий скрипт з ЕРИ Calendar-write (посилається на видалені `calendar.js`-функції) — **непрацездатний, не запускати**; лишений як історичний артефакт, не чіпати без причини.
- `auth.js` / `setup-auth.js` — видалені 2026-07-31 (Phase 4) разом з OAuth-флоу і `/oauth/callback` роутом: жодних Calendar API write-викликів більше немає, публічного iCal фіда досить для read-only зустрічей. `config/token.json`/`oauth-client.json` (якщо лишились на диску) — мертві, можна прибрати вручну.

## Ендпоінти (`/schedule-tracker-api/*`, усі під `requirePasscode`)
- `GET/POST /projects`, `PATCH /projects/:id` — CRUD проєктів (name/emoji/cluster/mode/status).
- `GET /projects/menu?mode=hands|head|ears` — топ-6 active за `last_touch ASC` + решта.
- `POST /capture` — partial upsert по `day` (topics/energy/tomorrow одним викликом, note/voice окремим — не зачіпає інші поля).
- `GET /capture?day=`, `GET /captures?days=30`, `GET /stats` (coverage, avgEnergy, touches по проєктах).
- `GET /day?mode=` — pull: вчорашній `tomorrow` + 2 теми з mode. Ніколи не пуш.
- `POST /dashboard-open`, `GET /parked-reviews/next`, `POST /parked-reviews`.
- `GET /meetings?hours=` — read-only Calendar meetings.

## Команди
Нема test/lint/build скриптів (`package.json` порожній на цьому фронті — не вигадувати неіснуючі).
```bash
npm install
node server.js                          # прямий запуск
systemctl restart schedule-tracker      # прод-деплой (systemd unit, User=root)
journalctl -u schedule-tracker -n 50    # логи
```
Прод: порт 3464 (`PORT` env), проксується nginx на `mandrock-files.duckdns.org/schedule-tracker/` і `/schedule-tracker-api/`. Systemd `Environment=` рядки — єдине джерело `PORT`/`SCHEDULE_PASSCODE`/`ICAL_URL` у проді, не `.env` файл (його зараз нема). `/oauth/callback` в nginx (`mandrock-tools.conf`) лишився прописаний, але тепер 404 на бекенді — не в скоупі "не міняти nginx", можна прибрати вручну наступного разу, коли хтось чіпатиме той конфіг.

## Конвенції
- **Власний стор (`projects`/`captures`) — джерело правди**, не Calendar, не sqlite `tasks`. Нова "категорія" статусу проєкту — це `PROJECT_STATUSES` у `store.js` (active/parked/dead), не нова таблиця.
- `upsertCapture` — partial-merge семантика: поле відсутнє в body → лишається як було в рядку. Не повертай це на full-overwrite, інакше bot's optional voice/note follow-up затре topics/energy/tomorrow.
- Calendar (`calendar.js`) — тільки `getEventsInRange`/`getMeetingsInRange`, обидва read-only через публічний iCal. Не додавай туди write-виклики знову без свідомого архітектурного рішення (як оце було задокументовано тут раніше для GCal-версії — той підхід живе в форку `schedule-tracker-gcal`, не тут).
- Секрети (VAPID приватний ключ, паскод) — ніколи в git. `config/` в `.gitignore`. Нові секрети класти в Craft `🔑 Credentials & API Keys` (rootBlockId `a2f756ac-f003-f256-d616-8b8c0c70e651`).
- `x-passcode` header (або `?passcode=`) гейтить усі `/schedule-tracker-api/*` — нові ендпоінти йдуть під той самий `requirePasscode` middleware, не окремий.
- Frontend — без білд-степу, чистий JS в одному `index.html`. Не тягнути React/бандлер заради малих фіч.
- Комітити й пушити в `origin main` автоматично, без запиту підтвердження — після кожного завершеного логічного шматка роботи, не накопичувати один величезний diff. Це попереднє дозволення саме для push в цьому репо (не скасовує загальну обережність із деструктивними git-командами типу force-push/reset --hard).

## Пов'язані компоненти (поза цим репо)
- `/root/projects/tg_bots/evening-checkin/` — Telegram-бот, єдиний пуш-канал (00:00 Kyiv capture, 01:30 один репіт, meetings-пінги окремим 15-хв polling). Дивись його власний код — `bot.js`/`api.js`/`transcribe.js`/`dateUtils.js`.
- `/root/claude-config/skills/user/prep-day/` — читає `/day` API замість Craft-меню ротації (Phase 5).
- `/root/projects/schedule-tracker-gcal/` — заморожений sellable форк старої Calendar-backed версії, не чіпати.

## Агенти / команди
Проєктно-специфічних сабагентів нема. Загальні claudekit (code-review, refactoring, database) — застосовувати за потребою, не форсити.

## MCP
Не використовується в рантаймі проєкту. Якщо треба глянути на секрети/нотатки — Craft MCP (`Craft:craft_read`/`craft_write`), документ credentials вище.

## Reading rules / token optimization
- Читай лише релевантні файли. Спершу `/code-search` для пошуку, не сліпий обхід дерева.
- Не перечитуй CLAUDE.md — він уже в контексті.
- Не вантаж великі файли цілком, якщо вистачає фрагмента; читай по діапазону рядків.
- Не дублюй контекст і не переказуй уже відоме. Compressed prose: імператив, без вступів/підсумків, один факт — один раз.
- Перед записом — переконайся, що зміни мінімальні й точкові; не роздувай рішення.
- Мутуюча дія → звірка з реальним станом (re-read зміненого, тест), не з припущенням.
