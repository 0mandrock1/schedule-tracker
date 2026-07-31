# schedule-tracker

**Переархітектуровано 2026-07-31.** Джерело правди — власний стор (`projects`/`captures` у sqlite), не Google Calendar. Стара Calendar-backed версія (title-prefix `✅ `/`❌ ` + colorId на події) заморожена як окремий sellable продукт у `/root/projects/schedule-tracker-gcal/` (тег `gcal-v1` у цьому репо) — не чіпати, туди нові фічі не йдуть.

Одна тема/проєкт (`projects`) торкається щодня через `captures` (день = запис: які проєкти торкнув, енергія 1-5, одна річ на завтра, опційний нотатка/voice-транскрипт). Пушиться раз на добу з Telegram-бота `evening-checkin` (`/root/projects/tg_bots/evening-checkin/`), не з календаря. Google Calendar лишився **тільки read-only джерелом реальних зустрічей** (події з attendees або тегом `[meet]` у title) — жодних записів статусу в Calendar більше немає.

## Стек
Node 22 (nvm) / Express 5 / better-sqlite3 / node-ical. Vanilla JS фронтенд (`public/index.html`), без білд-степу, без фреймворку.

## Структура
- `server.js` — Express-роутинг, `requireAuth` middleware на всі `/schedule-tracker-api/*` (крім `/login`, `/logout`). Старого shared-passcode гейта більше немає.
- `store.js` — вся бізнес-логіка проєктів/captures: CRUD проєктів, `projectsMenu`, `upsertCapture` (partial-update aware — bot дописує note/voice окремим викликом, не перезаписуючи topics/energy/tomorrow), `stats`, `getDay` (pull для `/day`), park sweep (active без touch 14+ днів → parked).
- `calendar.js` — **тільки читання**: iCal-фетч (публічний `ICAL_URL`, кеш 60с) + `getMeetingsInRange` (attendees/`[meet]`-фільтр). Жодних Calendar API write-викликів, жодного OAuth — публічного iCal фіда досить.
- `db.js` — SQLite (`tracker.db`, gitignored). Нові таблиці: `projects`, `captures`, `parked_reviews`, `dashboard_opens` (джерело правди для тем/трекінгу), `obligations`, `spice_votes`, `day_items`, `flags`. Старі `tasks`/`legacy_history`/`pomodoro_*`/`push_subscriptions` лишились не чіпані (historical/pomodoro — не в скоупі переархітектури), `tasks` тепер нічим не наповнюється (Calendar-write endpoints видалені).
- `public/index.html` — read-only дашборд: coverage (N/30), історія captures, проєкти по статусах. Без редагування, без pomodoro-UI (pomodoro-бекенд лишився недоторканим, просто не показаний у новому фронті).
- `pomodoro.js` — не займаний цією переархітектурою, ендпоінти `/pomodoro/*` лишились.
- `migrate-legacy-to-calendar.js` — **видалений 2026-07-31 (аудит)**: одноразовий скрипт з ери Calendar-write, посилався на видалені `calendar.js`-функції і писав статуси назад у Google Calendar. Історія лишилась у форку `schedule-tracker-gcal`.
- `auth.js` / `setup-auth.js` — видалені 2026-07-31 (Phase 4) разом з OAuth-флоу і `/oauth/callback` роутом: жодних Calendar API write-викликів більше немає, публічного iCal фіда досить для read-only зустрічей. `config/token.json` і `config/oauth-client.json` видалені з диска 2026-07-31 (аудит) — мертві OAuth-креденшели.

## Ендпоінти (`/schedule-tracker-api/*`, усі під `requireAuth`)
- `GET/POST /projects`, `PATCH /projects/:id` — CRUD проєктів (name/emoji/cluster/mode/status).
- `GET /projects/menu?mode=hands|head|ears` — топ-6 active за `last_touch ASC` + решта.
- `POST /capture` — partial upsert по `day` (topics/energy/tomorrow одним викликом, note/voice окремим — не зачіпає інші поля).
- `GET /capture?day=`, `GET /captures?days=30`, `GET /stats` (coverage, avgEnergy, touches по проєктах).
- `GET /day?mode=` — pull: вчорашній `tomorrow` + 2 теми з mode. Ніколи не пуш.
- `POST /dashboard-open`, `GET /parked-reviews/next`, `POST /parked-reviews`.
- `GET /meetings?hours=` — read-only Calendar meetings.
- `GET /spice-vote?day=&connector=&vote=up|down&token=` — click-through 👍/👎 from the prep-day
  "для смаку" block in the Craft doc (GET, plain hyperlink — `requireAuth` accepts the machine
  token via `?token=` too, not just headers/cookie, for exactly this case). Writes `spice_votes`;
  `GET /stats` includes `spiceVotes: {connector: {up, down}}`. Rotation config for which
  connector runs which weekday lives in `config/spice.json` (tracked despite `config/` being
  gitignored — it's routing, not a secret), read by the `prep-day` skill, not by this server.
- `POST /day-items/generate` (body `{mode}`), `GET /day-items?day=`, `PATCH /day-items/:id`
  (`{slot}` and/or `{done, note}`) — the per-day checklist (`day_items` table: `obligation` +
  `baseline` from `config/baseline.json` + active `habit`s from `config/habits.json` + 2-3
  `theme` picks for `mode`). Idempotent per day — calling `generate` twice for the same day
  returns the existing rows instead of duplicating. `baseline` is excluded from completion
  metrics (`GET /stats` → `dayItems: {theme: {total, done, share}, habits: [{title, streak,
  total}]}`) — it's background, not a signal. `slot` is a rough bucket
  (morning/day/evening/night), never a clock time — reminder scheduling per slot is bot-side,
  out of scope here.
- `GET /habits-nudge-check`, `POST /habits-nudge-sent` — one-time flag (`flags` table, key
  `habits_nudge_sent`) for the "час підселити звичку" nudge: fires no earlier than 2026-08-07
  Kyiv, only while `config/habits.json` is still `[]`. Bot cron polls `-check`, sends the
  message, then calls `-sent` so it never repeats.

## Команди
Нема test/lint/build скриптів (`package.json` порожній на цьому фронті — не вигадувати неіснуючі).
```bash
npm install
node server.js                          # прямий запуск
systemctl restart schedule-tracker      # прод-деплой (systemd unit, User=root)
journalctl -u schedule-tracker -n 50    # логи
```
Прод: порт 3464 (`PORT` env), проксується nginx на `mandrock-files.duckdns.org/schedule-tracker/` і `/schedule-tracker-api/`. Systemd `Environment=` рядки — єдине джерело `PORT`/`ICAL_URL`/auth-змінних у проді, не `.env` файл (його зараз нема). `/oauth/callback` в nginx (`mandrock-tools.conf`) лишився прописаний, але тепер 404 на бекенді — не в скоупі "не міняти nginx", можна прибрати вручну наступного разу, коли хтось чіпатиме той конфіг.

## Конвенції
- **Власний стор (`projects`/`captures`) — джерело правди**, не Calendar, не sqlite `tasks`. Нова "категорія" статусу проєкту — це `PROJECT_STATUSES` у `store.js` (active/parked/dead), не нова таблиця.
- `upsertCapture` — partial-merge семантика: поле відсутнє в body → лишається як було в рядку. Не повертай це на full-overwrite, інакше bot's optional voice/note follow-up затре topics/energy/tomorrow.
- Calendar (`calendar.js`) — тільки `getEventsInRange`/`getMeetingsInRange`, обидва read-only через публічний iCal. Не додавай туди write-виклики знову без свідомого архітектурного рішення (як оце було задокументовано тут раніше для GCal-версії — той підхід живе в форку `schedule-tracker-gcal`, не тут).
- Секрети (VAPID приватний ключ, pass hash, session secret, api token) — ніколи в git. `config/` в `.gitignore`. Нові секрети класти в Craft `🔑 Credentials & API Keys` (rootBlockId `a2f756ac-f003-f256-d616-8b8c0c70e651`).
- **Auth (з 2026-07-31, замінив shared passcode)**: два незалежні шляхи гейтять `/schedule-tracker-api/*` (крім `/login`, `/logout`) — (1) людина логіниться логін/пароль через `/login`, дістає httpOnly signed cookie `st_session` (HMAC SHA-256 на `SCHEDULE_SESSION_SECRET`, 30 днів); (2) машина (бот) шле `x-api-token`/`Authorization: Bearer` що дорівнює `SCHEDULE_API_TOKEN` (timing-safe порівняння). Пароль зберігається лише як `SCHEDULE_PASS_HASH` (`scrypt:saltHex:hashHex`, формат з `scripts/hash-password.js`) — ніколи plaintext. Rate-limit на `/login`: 10 спроб/15хв на IP (in-memory, без зовнішньої залежності), 429 понад ліміт. Нові ендпоінти йдуть під той самий `requireAuth` middleware, не окремий.
- Frontend — без білд-степу, чистий JS в одному `index.html`. Не тягнути React/бандлер заради малих фіч.
- Комітити й пушити в `origin main` автоматично, без запиту підтвердження — після кожного завершеного логічного шматка роботи, не накопичувати один величезний diff. Це попереднє дозволення саме для push в цьому репо (не скасовує загальну обережність із деструктивними git-командами типу force-push/reset --hard).

## Заготовка під звички
`config/habits.json` — масив `{title, slot, active_from, active_days, streak_goal, enabled}`,
живий приклад формату в `config/habits.example.json` (не читається кодом, лише документація).
`active_days` — ISO weekday 1(Пн)-7(Нд); порожній/відсутній масив = щодня. Додати звичку =
один запис у `habits.json`, без правки коду — з'явиться в `day_items` як `kind=habit` від
`active_from`. `config/baseline.json` — плоский масив рядків (назва звички), теж без коду.

## Пов'язані компоненти (поза цим репо)
- `/root/projects/tg_bots/evening-checkin/` — Telegram-бот, єдиний пуш-канал (00:00 Kyiv capture, 01:30 один репіт, meetings-пінги окремим 15-хв polling). Дивись його власний код — `bot.js`/`api.js`/`transcribe.js`/`dateUtils.js`. **Не реалізовано тут** (сесія, що писала `day_items`, була сендбоксована лише на `schedule-tracker/` і не мала доступу до цього репо): кнопки "Виставити на день"/слот/"нагадати" в Craft-доці й у відповіді бота, вечірня звірка по `day_items` (✅/✕/~), нагадування по слотах (09:00/14:00/19:00/23:00 Kyiv, дефолти конфігуруються бот-стороною), і сам polling `GET /habits-nudge-check` о 7 серпня 2026 12:00 Kyiv — усе це чекає на бот-сторону, API вже готове й засмоктестоване.
- `/root/claude-config/skills/user/prep-day/` — читає `/day` API (реєстр проєктів). Ротації тем по днях тижня немає; по днях тижня ротується лише джерело блоку «для смаку» (`config/spice.json`). Календар скіл лише читає — жодних записів.
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
