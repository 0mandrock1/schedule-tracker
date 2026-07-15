# schedule-tracker

A task tracker where **Google Calendar is the database**. Each calendar event is a task; its
completion state lives directly on the event itself (title prefix + color), not in a separate
store. Inspired by the approach in
[jameskokoska/GooglyCalendar](https://github.com/jameskokoska/GooglyCalendar) — state encoded in
the event, no separate DB for state — reimplemented from scratch with a self-hosted Node backend,
a passcode gate instead of Google OAuth as the user-auth model, and a small SQLite side-store for
history/Pomodoro logging only.

## How it works

- **Reads** the calendar via its public iCal feed (`node-ical`), cached 60s. Fast, no API quota
  cost.
- **Writes** (marking a task done/skipped, or setting markers) go through the Google Calendar API
  directly, patching the specific event instance:
  - `✅ ` / `❌ ` title prefix + `colorId` (green/red) encode status.
  - `extendedProperties.private.markers` holds arbitrary user tags.
- A local SQLite file (`tracker.db`) is **not** the source of truth for task state — it only
  caches a mirror for fast counting, plus the Pomodoro session log and imported legacy history.

## Setup

```bash
npm install
```

### Google OAuth (one-time)

The backend needs a Google Cloud OAuth **Web application** client (Desktop/installed-app clients
using the `urn:ietf:wg:oauth:2.0:oob` redirect are deprecated by Google) with the Calendar API
enabled:

1. Google Cloud Console → enable **Google Calendar API**.
2. OAuth consent screen → External → add yourself as a test user (avoids needing verification for
   personal use).
3. Credentials → Create OAuth client ID → **Web application** → add an HTTPS redirect URI you
   control, e.g. `https://your-domain/oauth/callback`.
4. Put the client credentials in `config/oauth-client.json`:
   ```json
   { "client_id": "...", "client_secret": "..." }
   ```
5. Update `REDIRECT_URI` in `auth.js` to match step 3, and add a reverse-proxy route to this
   server's `/oauth/callback` for that domain.
6. Run the server, then visit:
   ```bash
   node -e "console.log(require('./auth').getAuthUrl())"
   ```
   Open the printed URL, approve access — Google redirects to `/oauth/callback`, which exchanges
   the code and writes `config/token.json` (holds the refresh token; gitignored).

### iCal feed URL

Set your own calendar's private iCal address in `calendar.js` (`ICAL_URL`) — find it under
Google Calendar → Settings → your calendar → "Secret address in iCal format".

### Environment variables

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default 3463) |
| `SCHEDULE_PASSCODE` | Shared passcode gating all `/schedule-tracker-api/*` routes and the frontend. Empty disables the gate. |
| `ICAL_URL` | Your calendar's private iCal address (Google Calendar → Settings → your calendar → "Secret address in iCal format"). Required — this URL embeds a secret token, never commit it. |

### Running

```bash
node server.js
```

A sample `systemd` unit is the recommended way to keep it running (see below) — plain `pm2`
fork-mode was found to intermittently exit the process cleanly (exit code 0, no exception) on this
particular deployment for reasons not fully root-caused; a `setInterval` keep-alive in `server.js`
works around it either way.

```ini
[Unit]
Description=schedule-tracker
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/schedule-tracker
ExecStart=/usr/bin/node /path/to/schedule-tracker/server.js
Restart=always
RestartSec=5
Environment="PORT=3463"
Environment="SCHEDULE_PASSCODE=your-passcode"

[Install]
WantedBy=multi-user.target
```

## API

All `/schedule-tracker-api/*` routes require an `x-passcode` header (or `?passcode=`) matching
`SCHEDULE_PASSCODE`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/schedule-tracker-api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` | Day-grouped events with parsed status/title/markers |
| POST | `/schedule-tracker-api/status` | `{ uid, start, status }` — status ∈ `pending, done, skipped` |
| POST | `/schedule-tracker-api/markers` | `{ uid, start, markers: string[] }` — free-form tags, not a status |
| POST | `/schedule-tracker-api/task` | `{ title, start, end }` → creates a Calendar event, returns `{ id, iCalUID }` |
| DELETE | `/schedule-tracker-api/task/:uid?start=` | Deletes one occurrence (recurring-safe — resolves the instance, not the master event) |
| PATCH | `/schedule-tracker-api/task/:uid` | `{ start, newStart, newEnd }` — reschedules one occurrence |
| GET | `/schedule-tracker-api/counter?from=&to=` | Aggregate done/skipped counts (live + legacy) |
| GET | `/schedule-tracker-api/legacy-history` | Imported historical records |
| GET | `/schedule-tracker-api/pomodoro/active` | Current pomodoro state (phase, cycleCount, remainingSec) or `{ active: false }` |
| POST | `/schedule-tracker-api/pomodoro/start` | `{ uid? }` — starts a real work/short_break/long_break cycle, persisted server-side |
| POST | `/schedule-tracker-api/pomodoro/stop` | `{ completed: boolean }` |
| POST | `/schedule-tracker-api/pomodoro/pause` / `/resume` / `/skip` | Pause, resume, or manually advance the active cycle |
| GET | `/schedule-tracker-api/pomodoro/log` | Last 200 Pomodoro phase sessions |
| GET | `/schedule-tracker-api/pomodoro/focus-summary?from=&to=` | Per-task focus time, `GROUP BY eventId` on completed work phases |
| GET | `/schedule-tracker-api/push/vapid-public-key` | Public VAPID key for `pushManager.subscribe` |
| POST | `/schedule-tracker-api/push/subscribe` | `{ subscription }` — registers a Web Push endpoint for phase-change notifications |

`GET /oauth/callback` is unauthenticated (needed for the Google redirect) and refuses to run once
`config/token.json` already exists.

## Frontend

Single-page app at `public/index.html`, served under `/schedule-tracker/`: passcode gate, day list
view with a date-range picker, done/skip/Pomodoro/reschedule/delete/tag buttons per event, an
add-task form, a counter tab (live + legacy history + per-task focus time), and an "Про" (about)
tab explaining the app to a new user. Dark theme, responsive down to mobile widths.

Status toggles apply optimistically (flip the UI before the POST resolves, revert + show an inline
error on failure) instead of waiting on a full recalendar fetch + re-render. Add/delete/reschedule
do the same — Google's public iCal feed (what `GET /calendar` reads from) lags real-time Calendar
API writes by more than this app's own 60s cache TTL, so waiting on a refetch to reflect a write
would show stale data for a while.

### Web Push (Pomodoro phase-change notifications)

Requires VAPID keys (`npx web-push generate-vapid-keys`) in a gitignored `.env` — see
`.env.example`. Without them, `push/vapid-public-key` returns `null` and the frontend silently
skips the push-permission prompt; Pomodoro still works fully without it. `public/sw.js` is the
service worker; permission is requested on first Pomodoro start, not on page load.

## Legacy data import

If migrating from a prior tracker, drop its exported history as `legacy-import.json` (gitignored —
it's personal data, not part of this repo) in the shape `{ "<slotKey>": "done"|"skipped", ... }`.
It's imported into the `legacy_history` table on every boot (idempotent). `migrate-legacy-to-calendar.js`
is a one-off script that additionally tries to project each historical record back onto the
matching real Calendar event (by date + closest start time), so old history shows up visually too
— not every entry can be matched if the original event no longer exists or times drifted.
