# schedule-tracker

A personal theme/project tracker with its own store. **Rewritten 2026-07-31**: Google Calendar is
no longer the database. The source of truth is a local SQLite store (`projects` + `captures`);
Calendar is read-only and only used to surface *real meetings*.

The previous Calendar-as-database version (status encoded on the event via `✅ `/`❌ ` title prefix
and `colorId`) is frozen as a separate sellable product in `/root/projects/schedule-tracker-gcal/`
(tag `gcal-v1` in this repo). Nothing in this repo writes to Google Calendar any more.

## How it works

- One entry per day (`captures`): which projects were touched, energy 1-5, one thing for tomorrow,
  optional note / voice transcript. Pushed once a day from the `evening-checkin` Telegram bot, not
  from the calendar.
- `projects` is the theme registry (status `active` / `parked` / `dead`, cluster, mode
  `hands` / `head` / `ears`). It replaced the retired Craft doc "Меню дня — ротація тем" and the
  old day-of-week theme rotation — themes are now picked by the API from real coverage, not by
  weekday.
- `day_items` is the day checklist (obligation + baseline + habits + theme/hook picks), driven by
  the bot and mirrored into the daily Craft doc.
- **Calendar is read-only.** `calendar.js` fetches the public iCal feed (`node-ical`, 60s cache)
  and exposes exactly two things: `getEventsInRange` and `getMeetingsInRange`. A "real meeting" is
  an event with attendees or an explicit `[meet]` tag in the title; everything else in the
  calendar is leftover noise from the retired minute-by-minute era and is ignored.
- No Google OAuth, no `config/token.json`, no `/oauth/callback`. The public iCal feed is enough
  for read-only access. (Removed 2026-07-31 together with `auth.js` / `setup-auth.js`.)

## Setup

```bash
npm install
```

### iCal feed URL

Set `ICAL_URL` in the environment — Google Calendar → Settings → your calendar → "Secret address
in iCal format". The URL embeds a secret token; never commit it.

### Environment variables

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default 3463; production runs on 3464) |
| `SCHEDULE_USER` | Login username for the web dashboard. |
| `SCHEDULE_PASS_HASH` | scrypt hash of the login password, format `scrypt:saltHex:hashHex` — generate with `node scripts/hash-password.js <password>`. Never store the plaintext password. |
| `SCHEDULE_SESSION_SECRET` | HMAC key signing the session cookie. Random 32+ bytes hex, e.g. `openssl rand -hex 32`. |
| `SCHEDULE_API_TOKEN` | Bearer token for machine callers (the Telegram bot, the prep-day scripts) — sent as `x-api-token` or `Authorization: Bearer`, bypasses the login form. Random 32+ bytes hex. |
| `ICAL_URL` | Your calendar's private iCal address. Required. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push keys (Pomodoro phase notifications only). Optional. |

There is no shared-passcode variable any more; login/password + machine token replaced it on
2026-07-31.

### Running

```bash
node server.js
```

Production runs under `systemd` (unit `schedule-tracker`), not pm2 — plain pm2 fork-mode was found
to intermittently exit the process cleanly (exit code 0, no exception) on this deployment.

```ini
[Unit]
Description=schedule-tracker
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/projects/schedule-tracker
ExecStart=/usr/bin/node /root/projects/schedule-tracker/server.js
Restart=always
RestartSec=5
Environment="PORT=3464"
Environment="SCHEDULE_USER=your-username"
Environment="SCHEDULE_PASS_HASH=scrypt:...:..."
Environment="SCHEDULE_SESSION_SECRET=..."
Environment="SCHEDULE_API_TOKEN=..."
Environment="ICAL_URL=https://calendar.google.com/calendar/ical/.../basic.ics"

[Install]
WantedBy=multi-user.target
```

## Auth

All `/schedule-tracker-api/*` routes (except `/login`, `/logout`) require either a valid
`st_session` login cookie (obtained via `POST /login`) or an `x-api-token` /
`Authorization: Bearer` header matching `SCHEDULE_API_TOKEN` (timing-safe compare). `/login` is
rate-limited to 10 attempts / 15 min per IP (in-memory), 429 over the limit.

## API

### Store (source of truth)

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects?status=&mode=` | Project registry |
| POST | `/projects` | `{ name, emoji, cluster, mode }` |
| PATCH | `/projects/:id` | Partial update (status, cluster, mode, …) |
| GET | `/projects/menu?mode=` | Bot keyboard payload |
| POST | `/capture` | Daily capture upsert (projects touched, energy, tomorrow, note, voice) |
| GET | `/capture?day=` | One day's capture |
| GET | `/captures?days=` | Recent captures |
| GET | `/stats` | Coverage, streak, spice votes |
| GET | `/stats/energy-by-project` | Mean energy per project (>=3 observations / 30 days) |
| GET | `/day?mode=` | Today's obligation + <=2 topics for that mode — what prep-day reads |
| POST | `/obligation` | `{ text }` — set today's obligation |
| POST | `/obligation/decide` | `{ outcome }` ∈ `taken, moved, dropped` |
| GET | `/parked-reviews/next?n=` | Parked projects due for Sunday review |
| POST | `/parked-reviews` | `{ project_id, answer }` ∈ `alive, sleeping, dead` |
| POST | `/dashboard-open` | Dashboard-open ping |
| GET | `/spice-vote?day=&connector=&vote=&token=` | 👍/👎 link target inside the daily Craft doc |

### Day checklist

| Method | Path | Purpose |
|---|---|---|
| POST | `/day-items/generate` | `{ mode? }` — build today's checklist |
| GET | `/day-items?day=` | Today's items |
| PATCH | `/day-items/:id` | `{ done, note, slot }` |
| GET | `/habits-nudge-check` | One-time "time to add a habit" gate (>= 2026-08-07) |
| POST | `/habits-nudge-sent` | Marks the one-time nudge as fired (persisted in `flags`) |

### Calendar (read-only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/meetings?hours=` | Real meetings only (attendees or `[meet]`), never task statuses |
| POST | `/meeting-ping-claim` | `{ key }` → `{ claimed }` — atomic dedup claim so a bot restart can't double-ping |

### Legacy / side features (untouched by the rewrite)

`/counter`, `/legacy-history`, `/pomodoro/*`, `/push/*`.

## Frontend

Single-page app at `public/index.html`, served under `/schedule-tracker/`: login gate, coverage
("capture: N з 30"), day history (projects, energy, note, transcript), projects by status, the
parking lot. `POST /dashboard-open` fires on load. No task editing, no minute-by-minute schedule.

## Scripts

| Script | What it does |
|---|---|
| `scripts/prep-day-run.sh [mode]` | On-demand prep-day generation via `claude -p`. One doc per Kyiv day (marker file), 3× retry on 529/overloaded. Prints the Craft URL. |
| `scripts/day-items-to-craft.sh [YYYY-MM-DD]` | Mirrors today's `day_items` into the "Заняття на день" section of the daily Craft doc. Idempotent, 3× retry. |
| `scripts/verify.mjs` | System health check — all endpoints, bot cron registration, script presence + executable bit. `npm run verify`. |
| `scripts/hash-password.js <password>` | Generates `SCHEDULE_PASS_HASH`. |

## Legacy data import

`legacy-import.json` (gitignored personal data) in the shape `{ "<slotKey>": "done"|"skipped" }` is
imported into `legacy_history` on every boot (idempotent). The old `migrate-legacy-to-calendar.js`
projector was deleted on 2026-07-31 — it wrote back into Google Calendar, which this version does
not do.
