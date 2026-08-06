# Генератор плану дня — інструкція для внутрішнього агента

День: **{{DAY}}** (Europe/Kyiv). Це вже сьогоднішня Kyiv-дата, підставлена викликаючим
скриптом — не перераховуй її сам.

Working directory: `/root/projects/schedule-tracker`. Увесь код і конфіги, які тобі
знадобляться (`store.js`, `template.js`, `TEMPLATE.md`, `config/spice.json`,
`config/day-template.md`) — тут.

Скоуп: чіпати можна ТІЛЬКИ `/root/projects/schedule-tracker/**`, календар `planer` і
Craft. Нічого не слати в Telegram. Нічого не публікувати назовні. Токени (API, Craft) не
друкувати у вивід. Не видаляй чужі події з календаря — тільки ті, що сам створив цим
скриптом (маркер `[daygen]`, дивись нижче). Не видаляй рядки за минулі дні.

## Токен локального API

```sh
TOKEN="$(systemctl show schedule-tracker -p Environment --value | tr ' ' '\n' | sed -n 's/^SCHEDULE_API_TOKEN=//p')"
```

Усі виклики `http://127.0.0.1:3464/schedule-tracker-api/...` — з заголовком
`x-api-token: $TOKEN`. Значення `$TOKEN` НІКОЛИ не друкувати (ні в лог, ні у вивід).

## Крок 1 — зібрати дані дня

1. `POST /schedule-tracker-api/day-items/generate` з порожнім body (`{}`) — mode не
   передавай, хай сервер сам викличе `pickMode`. Ідемпотентно: якщо на сьогодні вже є
   рядки, поверне їх без дублювання.
2. `GET /schedule-tracker-api/day-items?day={{DAY}}` — повний список тасок дня
   (obligation/habit/theme/hook, можливо baseline).
3. Режим дня НЕ повертається жодним GET-ендпоінтом до збереження плану — прочитай його
   напряму з БД (read-only, це не мутація стану проєкту, лише читання вже записаного
   ендпоінтом із кроку 1 значення):
   ```sh
   node -e "const db=require('better-sqlite3')('tracker.db',{readonly:true}); \
     const r=db.prepare('SELECT mode FROM day_plans WHERE day=?').get('{{DAY}}'); \
     console.log(r ? r.mode : '')"
   ```
   Якщо рядка нема — крок 1 не спрацював, зупинись і повідом про помилку.
4. `GET /schedule-tracker-api/meetings?hours=24` — реальні зустрічі найближчої доби.
5. `GET /schedule-tracker-api/calendar?from={{DAY}}&to={{DAY}}` — усі події сьогодні
   (для контексту зайнятості), згруповані по Kyiv-дню.
6. Ритуали дня вже враховані у списку з кроку 2 (`kind=habit`, `source` починається з
   `ritual:`) — окремо запитувати не треба.

Режим дня (`mode`) визначає емодзі/підпис: `hands`→🔌 руки, `head`→💻 голова,
`ears`→🎧 вуха, `body`→🫀 тіло, `magic`→🔮 магія (`store.js` → `MODE_LABELS`).

## Крок 2 — календар `planer`

Календар: `4d8cc9c43e8ed3eda1875b85f888c2157516c4e1e41cfbf142d0803288d8615b@group.calendar.google.com`
(id `planer`). НЕ основний календар — жодних подій там не чіпай і не створюй.

### 2.1 Ідемпотентність — спершу прибери старі

`list_events` по календарю `planer` за {{DAY}} (00:00–23:59 Europe/Kyiv). Для кожної
знайденої події, у чиєму `description` є рядок `[daygen]` — видали (`delete_event`).
Події БЕЗ цього маркера (створені людиною) не чіпай за жодних умов, навіть якщо вони
там же і того ж дня.

### 2.2 Зайнятість

`list_events` по ВСІХ календарях за {{DAY}} (00:00–23:59 Europe/Kyiv) — це реальні
зустрічі й будь-що інше, що вже стоїть у розкладі. З цього списку виключи щойно видалені
на кроці 2.1 (вони вже пішли).

### 2.3 Детерміноване розкидання

Візьми список тасок з кроку 1.2 (усі рядки `day-items`, кожен — окрема подія). Розклади
їх псевдовипадково, але детерміновано від дати, у вікні **10:00–23:30 Europe/Kyiv**,
тривалість кожної **45–90 хв**, буфер **≥15 хв** від справжніх подій (з кроку 2.2) і між
собою, без накладань.

Напиши невеликий Node-скрипт (тимчасовий файл, наприклад `logs/.gen-day-schedule.js`,
видали його наприкінці кроку) з РІВНО такою детермінованою логікою (seed — хеш дати,
той самий підхід, що й `store.js`: FNV-1a хеш рядка → `mulberry32`):

```js
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = process.argv[2]; // YYYY-MM-DD
const tasks = JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8')); // [{id,title}]
const busy = JSON.parse(require('fs').readFileSync(process.argv[4], 'utf8'));  // [{startMin,endMin}] minutes-of-day, Kyiv, already buffered by caller

const rand = mulberry32(hashStr(DAY));
const WINDOW_START = 10 * 60, WINDOW_END = 23 * 60 + 30;
const BUFFER = 15;

// shuffle tasks deterministically (Fisher-Yates with seeded rand)
const order = tasks.slice();
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

const placed = []; // {startMin,endMin}
function overlaps(s, e, list) {
  return list.some((b) => s < b.endMin + BUFFER && e + BUFFER > b.startMin);
}

const out = [];
for (const t of order) {
  const dur = 45 + Math.floor(rand() * 46); // 45..90
  let start = null;
  // try up to 200 randomized offsets in the window before giving up
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = WINDOW_START + Math.floor(rand() * Math.max(1, WINDOW_END - WINDOW_START - dur));
    if (candidate + dur > WINDOW_END) continue;
    if (!overlaps(candidate, candidate + dur, busy) && !overlaps(candidate, candidate + dur, placed)) {
      start = candidate;
      break;
    }
  }
  if (start == null) continue; // day is full — this task gets no calendar slot, that's fine
  placed.push({ startMin: start, endMin: start + dur });
  out.push({ id: t.id, title: t.title, startMin: start, endMin: start + dur });
}
console.log(JSON.stringify(out));
```

Конвертуй `startMin`/`endMin` (хвилини від півночі Europe/Kyiv) у ISO з offset
Europe/Kyiv (`+02:00`/`+03:00` залежно від DST на {{DAY}}) для виклику
`create_event`.

Назва події = `{емодзі режиму дня} {назва таски}`. Опис = посилання на сторінку дня
(`https://mandrock-tools.duckdns.org/day/`, якщо інший URL сторінки дня тобі відомий з
`/var/www/html/day/index.html` — використай його) + окремим рядком рівно `[daygen]`.

Створи події (`create_event`) по одній на кожен запис із виводу скрипта, у календарі
`planer`. Якщо для якоїсь таски місця не знайшлось (день забитий) — пропусти її, не
намагайся втиснути силою.

## Крок 3 — наповнити шаблон і зберегти

1. `GET /schedule-tracker-api/template/tokens` — звір з `TEMPLATE.md`, які токени
   очікуються.
2. Зібрати `data` — обʼєкт під усі токени. Обовʼязкові поля:
   - `date`: `{{DAY}}`; `mode`: з кроку 1.3.
   - `obligation`, `tasks`, `rituals`: з рядків day-items (obligation — kind=obligation;
     tasks — kind=theme/hook у вигляді списку рядків; rituals — kind=habit).
   - `schedule`: масив `{title, time, real}` — реальні зустрічі (крок 1.4, `real:true`,
     `time` у форматі `HH:MM`) ПЛЮС щойно створені `[daygen]`-події (крок 2.3,
     `real:false`), відсортовані за часом.
   - `meetings`: тільки реальні зустрічі, той самий формат.
   - див. «Зміст блоків» нижче для `magic_*`, `space`, `news`, `joke_diagram`, `spice`,
     `moon`, `stats`, `claude_comment`, `header_image`, `image_anchor`.
3. Відрендери прев'ю: `POST /schedule-tracker-api/day-plan/{{DAY}}/render` з
   `{data}` у body — щоб побачити `warnings` ДО збереження. Виправ, якщо є невідомі
   токени чи помилки.
4. Збережи: `PUT /schedule-tracker-api/day-plan/{{DAY}}` з `{mode, md, html, data}` —
   `md`/`html` бери з результату рендера кроку 3 (або віддай `data` і дай серверу
   відрендерити — обидва шляхи ОК, головне щоб збережене `md` відповідало щойно
   відрендереному тексту).

## Зміст блоків (пиши українською, тон грайливий, емодзі щедро, не суцільним килимом)

### 🔮 МАГІЯ (`magic_card`, `magic_fact`, `magic_prophecy`, `magic_absurd`)

- `magic_card`: витягни карту дня з колоди Neon Moon за
  `/root/claude-config/skills/user/tarot-reading/SKILL.md` (масті Signals/Mirrors/
  Codes/Chips, двори Glitch/Runner/Proxy/Node). Витяг ДЕТЕРМІНОВАНИЙ від дати — можеш
  використати той самий `hashStr({{DAY}})` підхід (карта = хеш мод 78, масть/старший
  аркан за індексом). Трактування коротке й практичне, побутовий поетизм, без
  езотеричного пафосу — тон з того ж SKILL.md.
- `magic_fact`: справжній історичний або етнографічний магічний факт дня —
  перевірюваний, не вигаданий. Не знайшов надійного — пропусти краще, ніж вигадати.
- `magic_prophecy`: «передбачення на вчора» — жарт: пророцтво заднім числом, складене з
  РЕАЛЬНИХ вчорашніх `day_items` і чек-іну. Звірся через
  `GET /schedule-tracker-api/day-items?day=<вчора>` і
  `GET /schedule-tracker-api/capture?day=<вчора>` — має бути влучно й конкретно, а не
  абстрактно. Якщо вчора нема даних (капчур/items порожні) — чесно напиши коротке
  «вчора мовчав, тому пророцтво відкладається» замість вигадки.
- `magic_absurd`: абсурдна магічно-кіберпанкова дурниця на 1-2 речення,
  «толиновоститолистарості» — новина, про яку неясно, вона свіжа чи їй 300 років.
  Щодня інша (сам придумай, це саме той випадок, де вигадка — жанр, не хиба).

### 🚀 КОСМОС І НАУКА (`space`)

2-3 пункти. Джерела: свіжі релізи NASA/ESA/arXiv astro-ph, помітні статті — використай
`WebSearch`/`WebFetch`, якщо доступні в тулах цієї сесії; якщо ні — Google Calendar/Craft
тобі цього не дадуть, тоді чесно напиши менше пунктів. Кожен пункт: рядок факту + рядок
«чому це цікаво». БЕЗ вигаданих новин: не знайшов свіжого — краще менше пунктів, ніж
вигадка.

### 😄 ПОХИХОТІТИ (`joke_diagram`, `spice`)

- `joke_diagram`: паралельний виклик уже запустив субагента `jokediagram-whimsical` у
  фоні. Почекай на `logs/jokediagram-{{DAY}}.done` до 5 хвилин (polling, напр. кожні
  10с). Якщо файл з'явився — прочитай `logs/jokediagram-{{DAY}}.out`, візьми звідти
  все після рядка `CONTENT:`. Якщо за 5 хвилин файл не з'явився — здайся, лиши
  `joke_diagram` порожнім (блок сам зникне через `{? joke_diagram ?}` — якщо в шаблоні
  такої умови нема навколо цього токена, просто передай порожній рядок).
- `spice`: ротаційний конектор `config/spice.json` за днем тижня {{DAY}} (`day`:
  mon/tue/.../sun). Виконай `prompt` цього дня (і `bonus`, якщо його `transport: mcp` і
  відповідний MCP реально живий) — формат один короткий блок тексту з підписом
  конектора.

### `claude_comment`

Короткі репліки в КІЛЬКОХ (не всіх) блоках шаблону — рівно там, де в
`config/day-template.md` є `{? claude_comment ?}...{?/?}`. Формат рівно
`•Коментар клода• …`. Це не резюме блоку, а кинута збоку ремарка: спостереження, підкол,
зауваження про самого Марка. Різної довжини. Не заповнюй усі входження — обери 1-2.

### `header_image`

Картинка дня через `/root/tools/kek/kek.py`. Режим `quote` (без вихідної картинки —
найпростіший і сюди пасує) з фразою дня в тон режиму:

```sh
python3 /root/tools/kek/kek.py quote --text 'ФРАЗА ДНЯ' --color 'HEX' \
  -o /var/www/html/day/img/{{DAY}}.png
```

Мапінг режим→акцент (з `/root/claude-config/skills/user/palette-themes/references/themes.json`,
dark-варіант — картинка на темному тлі краще пасує до кіберпанк-тону шаблону):

| mode | accent | hex (dark) |
|---|---|---|
| hands | blue | `4aa3e0` |
| head | octarine-2 | `00f5d4` |
| ears | pink-violet | `e06ec0` |
| body | red | `ff5a4d` |
| magic | octarine-3 | `e94aff` |

Екранування для `/bin/sh`: одинарні лапки навколо `--text`, апостроф усередині фрази —
як `'\''`. У шаблон іде ВІДНОСНИЙ URL: `/day/img/{{DAY}}.png`.

### `image_anchor`

Просто передай `header_image` у `data` — рушій (`template.js`) сам обирає, куди
підставити картинку; місце в шаблоні НЕ хардкодь і не вибирай сам.

### `moon`, `stats`

- `moon`: фаза місяця на {{DAY}} — можна порахувати офлайн (синодичний місяць
  ≈29.53059 днів від відомого нового місяця, напр. 2000-01-06) або пошуком, якщо є
  WebSearch. Один рядок з емодзі фази.
- `stats`: `GET /schedule-tracker-api/stats` — коротке саммарі (coverage, avgEnergy)
  одним-двома реченнями.

### `news`

Коротко (1-3 пункти) — «новини поки спав»: якщо є доступ до WebSearch/WebFetch, свіже
дотичне до тем Марка (агенти/self-hosted/аудіо/3D); немає — залиш порожнім, не вигадуй.

## Готово

Останнім кроком переконайся, що `GET /schedule-tracker-api/day-plan/{{DAY}}` повертає
збережений план (md непорожній). Це і є ознака успіху для скрипта, що тебе викликав.
