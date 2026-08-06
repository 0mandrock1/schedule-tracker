// Own templater for the day-plan doc — no external templating library. Four constructs:
//   {{ token }}      substitution from `data`
//   {? token ?}...{?/?}   block rendered only if `data[token]` is non-empty/truthy
//   {% microprompt %}     left verbatim — a marker for the generator to fill in later,
//                         this engine never touches its contents
//   {# comment #}         always stripped, never reaches the output
// Unknown {{token}}s (not in TEMPLATE_TOKENS) are left in place and reported as warnings —
// a typo in the template shouldn't silently eat the doc.

const MODE_LABELS = { hands: '🔌 руки', head: '💻 голова', ears: '🎧 вуха', body: '🫀 тіло', magic: '🔮 магія' };

const TEMPLATE_TOKENS = {
  date: 'Дата дня (YYYY-MM-DD)',
  weekday: 'Назва дня тижня українською',
  mode: 'Внутрішній код режиму дня (hands|head|ears|body|magic)',
  mode_label: 'Підпис режиму дня з емодзі (напр. "💻 голова") — рахується з mode, якщо не задано явно',
  mode_emoji: 'Лише емодзі режиму дня',
  header_image: 'Картинка-заголовок дня (відносний URL, напр. /day/img/2026-08-06.png) — рендериться як зображення; порожній → шапка й усі image_anchor зникають',
  obligation: 'Зобовʼязання, перенесене з учорашнього "на завтра"',
  tasks: 'Список тем/тасок на день (без ритуалів і зобовʼязання)',
  rituals: 'Список ритуалів на день',
  schedule: 'Розклад дня: справжні зустрічі + згенеровані таски одним списком, позначені окремо',
  meetings: 'Тільки справжні зустрічі з календаря',
  magic: 'Загальний магічний блок (якщо не розбитий на під-токени)',
  magic_card: 'Таро: витягнута карта дня',
  magic_fact: 'Магічний/містичний факт дня',
  magic_prophecy: 'Грайливе передбачення дня',
  magic_absurd: 'Абсурдний магічний мікропромпт-результат',
  space: 'Розширений блок космос/наука',
  news: 'Новини, поки спав',
  joke_diagram: 'Жартівлива діаграма/схема дня',
  spice: 'Ротаційний блок "для смаку" (config/spice.json)',
  moon: 'Фаза місяця',
  stats: 'Короткий підсумок статистики дня/тижня',
  claude_comment: 'Скалярний коментар Клода (легасі/зворотна сумісність — один слот); зазвичай замість нього масив claude_comments',
  claude_comments: 'Масив реплік Клода різної довжини — рушій детерміновано (seed від date) роздає 2-4 РІЗНІ репліки у 2-4 з наявних {? claude_comment ?}-слотів, решту слотів прибирає без сліду',
  image_anchor: 'Можливе місце для картинки дня — рушій сам обирає рівно одне входження і підставляє туди зображення header_image, решту прибирає',
};

const COMMENT_RE = /\{#[\s\S]*?#\}/g;
const COND_RE = /\{\?\s*([\w.]+)\s*\?\}([\s\S]*?)\{\?\/\?\}/;
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const ANCHOR_RE = /\{\{\s*image_anchor\s*\}\}/g;
// A whole {? claude_comment ?}...{?/?} block anchored to its own line, including the
// trailing newline — so a dropped slot leaves no orphan blank line behind. Non-greedy,
// and these blocks never nest another {?/?}, so it stops at its own closer.
const CLAUDE_BLOCK_RE = /^[ \t]*\{\?\s*claude_comment\s*\?\}[\s\S]*?\{\?\/\?\}[ \t]*(\r?\n|$)/gm;

const SCHEDULE_CSS = `.ev { list-style:none; padding:.35rem .6rem; margin:.25rem 0; }
.ev.real { border-left:4px solid #4f46e5; background:rgba(79,70,229,0.08); color:inherit; }
.ev.gen { border-left:3px dashed #9ca3af; background:rgba(156,163,175,0.06); color:#6b7280; }
.claude-note { display:block; padding:.4rem .6rem; margin:.5rem 0; border-left:3px solid #f59e0b; background:rgba(245,158,11,0.08); font-style:italic; }
.image-anchor { padding:.5rem; margin:.5rem 0; text-align:center; color:#6b7280; }
.day-img{max-width:100%;height:auto;display:block;border-radius:6px;margin:12px 0}`;

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Same seeded PRNG the generator prompt uses (FNV-1a hash → mulberry32) — keeps the
// engine's slot picks deterministic-per-date and reproducible.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded Fisher-Yates — deterministic permutation of [0..n).
function seededOrder(n, rand) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Day image as real markup in both formats. In html the `<img>` starts with `<`, so
// proseLinesToHtml passes the line through untouched — no sentinel round-trip needed.
function imageMarkup(src, format) {
  return format === 'html'
    ? `<img class="day-img" src="${escapeHtml(src)}" loading="lazy" alt="">`
    : `![](${src})`;
}

function isTruthy(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return Boolean(v);
}

function get(data, tokenPath) {
  return tokenPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), data);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function itemLabel(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') return [item.time, item.title].filter(Boolean).join(' ');
  return String(item);
}

function listToMd(list) {
  return list.map((i) => `- ${itemLabel(i)}`).join('\n');
}

function scheduleToMd(list) {
  return list.map((i) => `- ${itemLabel(i)}${i.real ? ' 📅' : ''}`).join('\n');
}

function scheduleToHtml(list) {
  const lis = list.map((i) => `<li class="ev ${i.real ? 'real' : 'gen'}">${i.real ? '📅 ' : ''}${escapeHtml(itemLabel(i))}</li>`).join('');
  return `<ul class="schedule">${lis}</ul>`;
}

function listToHtml(list) {
  const lis = list.map((i) => `<li>${escapeHtml(itemLabel(i))}</li>`).join('');
  return `<ul>${lis}</ul>`;
}

function claudeCommentToMd(text) {
  return `> •Коментар клода• ${text}`;
}

function claudeCommentToHtml(text) {
  return `<aside class="claude-note">•Коментар клода• ${escapeHtml(text)}</aside>`;
}

// Composite tokens need format-aware + shape-aware rendering (arrays of {title,time,real}
// vs plain strings vs plain text). Everything not listed here falls through to String(value).
function stringifyToken(token, value, data, format) {
  if (token === 'mode_label' && value == null) value = data.mode ? MODE_LABELS[data.mode] : null;
  if (token === 'mode_emoji' && value == null) {
    const label = data.mode_label || (data.mode ? MODE_LABELS[data.mode] : null);
    value = label ? label.split(' ')[0] : null;
  }
  if (value == null) return '';

  if (token === 'schedule') return format === 'html' ? scheduleToHtml(value) : scheduleToMd(value);
  if (token === 'meetings') {
    const real = value.map((v) => ({ ...v, real: true }));
    return format === 'html' ? scheduleToHtml(real) : scheduleToMd(real);
  }
  // Any stray inline {{header_image}} (own-line ones are consumed earlier by resolveImages)
  // still renders as an image, never as a bare path.
  if (token === 'header_image') return isTruthy(value) ? imageMarkup(String(value).trim(), format) : '';
  if (token === 'claude_comment') return format === 'html' ? claudeCommentToHtml(value) : claudeCommentToMd(value);
  // joke_diagram now carries a markdown image `![alt](url)` (the jokediagram-whimsical
  // subagent renders a PNG to the CDN, not a whimsical.com link). In md it passes through
  // verbatim; in html the raw prose pass would escape it into literal text, so render a
  // real <img> here (same treatment header_image gets). Non-image text still falls through.
  if (token === 'joke_diagram' && isTruthy(value)) {
    const m = String(value).trim().match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
    if (m) return format === 'html'
      ? `<img class="day-img" src="${escapeHtml(m[2])}" loading="lazy" alt="${escapeHtml(m[1])}">`
      : String(value).trim();
  }
  if (Array.isArray(value)) return format === 'html' ? listToHtml(value) : listToMd(value);
  return String(value);
}

// Resolves {? token ?}...{?/?} blocks. Single-level (no nesting) — matches this project's
// actual template shape; iterating the same regex handles multiple sequential blocks.
function resolveConditionals(md, data) {
  let out = md;
  let guard = 0;
  while (COND_RE.test(out) && guard++ < 200) {
    out = out.replace(COND_RE, (_, token, inner) => (isTruthy(get(data, token)) ? inner : ''));
  }
  return out;
}

// Distributes distinct Claude replies over the {? claude_comment ?} slots. Deterministic
// from `data.date`: pick min(slots, replies, 2..4) slots, drop the rest whole (line +
// newline, no junk blank line). `claude_comments` (array of varied-length strings) is the
// source; falls back to the scalar `claude_comment` (one slot) for backward compat; when
// both are empty every slot vanishes without a trace.
function resolveClaudeComments(md, data, format) {
  const slots = md.match(CLAUDE_BLOCK_RE);
  if (!slots) return md;
  const slotCount = slots.length;

  let replies = [];
  if (Array.isArray(data.claude_comments)) {
    replies = data.claude_comments.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
  }
  if (!replies.length && isTruthy(data.claude_comment)) replies = [String(data.claude_comment).trim()];

  const chosen = new Map(); // slot index -> reply text
  if (replies.length) {
    const seed = hashStr(String(data.date || ''));
    const rand = mulberry32(seed);
    const want = 2 + (seed % 3); // 2..4, deterministic from date
    const count = Math.min(slotCount, replies.length, want);
    const slotOrder = seededOrder(slotCount, rand);
    const replyOrder = seededOrder(replies.length, rand);
    for (let k = 0; k < count; k++) chosen.set(slotOrder[k], replies[replyOrder[k]]);
  }

  let i = -1;
  return md.replace(CLAUDE_BLOCK_RE, (full, nl) => {
    i++;
    if (!chosen.has(i)) return '';
    const text = chosen.get(i);
    const rendered = format === 'html' ? claudeCommentToHtml(text) : claudeCommentToMd(text);
    return `${rendered}${nl}`;
  });
}

// Renders the day image. `{{header_image}}` on its own line and every `{{image_anchor}}`
// occurrence are resolved here (before token substitution). Exactly one anchor gets the
// image (deterministic from `data.date`); the rest are dropped whole — line + newline —
// so no junk blank line remains. With no image (`header_image` empty/absent), the header
// line and ALL anchors vanish and no placeholder is emitted anywhere.
function resolveImages(md, data, format) {
  const hasImage = isTruthy(data.header_image);
  const src = hasImage ? String(data.header_image).trim() : null;

  md = md.replace(/^([ \t]*)\{\{\s*header_image\s*\}\}[ \t]*(\r?\n|$)/gm,
    (full, lead, nl) => (hasImage ? `${lead}${imageMarkup(src, format)}${nl}` : ''));

  const matches = md.match(ANCHOR_RE);
  if (!matches) return md;
  const chosenIdx = hasImage ? hashStr(String(data.date || '')) % matches.length : -1;
  let i = 0;
  md = md.replace(/^([ \t]*)\{\{\s*image_anchor\s*\}\}[ \t]*(\r?\n|$)/gm, (full, lead, nl) =>
    (i++ === chosenIdx ? `${lead}${imageMarkup(src, format)}${nl}` : ''));
  return md;
}

function substituteTokens(md, data, format, warnings, usedTokens) {
  return md.replace(TOKEN_RE, (full, token) => {
    if (!(token in TEMPLATE_TOKENS)) {
      warnings.push(`unknown token: {{${token}}}`);
      return full;
    }
    usedTokens.push(token);
    return stringifyToken(token, get(data, token), data, format);
  });
}

function renderCore(templateMd, data, format) {
  const warnings = [];
  const usedTokens = [];
  let out = templateMd.replace(COMMENT_RE, '');
  out = resolveClaudeComments(out, data, format);
  out = resolveConditionals(out, data);
  out = resolveImages(out, data, format);
  out = substituteTokens(out, data, format, warnings, usedTokens);
  out = out.replace(/\n{3,}/g, '\n\n'); // collapse blank-line junk left by dropped blocks
  return { output: out, warnings, usedTokens };
}

function render(templateMd, data) {
  const { output, warnings, usedTokens } = renderCore(templateMd, data, 'md');
  return { md: output, warnings, usedTokens };
}

// Minimal markdown→HTML line pass for the prose around composite-token HTML fragments
// (headings, bullet lists) — composite tokens (schedule/tasks/etc.) already emit their
// own HTML during substituteTokens and are left untouched here (they start with '<').
function proseLinesToHtml(md) {
  const lines = md.split('\n');
  const htmlLines = [];
  let inList = false;
  const closeList = () => { if (inList) { htmlLines.push('</ul>'); inList = false; } };
  for (const line of lines) {
    if (/^</.test(line.trim()) || line.trim() === '') { closeList(); if (line.trim()) htmlLines.push(line); continue; }
    const h3 = line.match(/^###\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h1 = line.match(/^#\s+(.*)/);
    const li = line.match(/^-\s+(.*)/);
    if (h3) { closeList(); htmlLines.push(`<h3>${escapeHtml(h3[1])}</h3>`); }
    else if (h2) { closeList(); htmlLines.push(`<h2>${escapeHtml(h2[1])}</h2>`); }
    else if (h1) { closeList(); htmlLines.push(`<h1>${escapeHtml(h1[1])}</h1>`); }
    else if (li) { if (!inList) { htmlLines.push('<ul>'); inList = true; } htmlLines.push(`<li>${escapeHtml(li[1])}</li>`); }
    else { closeList(); htmlLines.push(`<p>${escapeHtml(line)}</p>`); }
  }
  closeList();
  return htmlLines.join('\n');
}

// `input` is template text (tokens/{? ?}/{{image_anchor}} unresolved) by default — the
// same thing `render()` takes. Pass `{isTemplate: false}` when `input` is already a
// rendered markdown string (e.g. the `md` from a prior `render()` call, tokens already
// gone) and you just want the prose→HTML pass, not a second token-substitution pass
// against it. Two-arg calls keep behaving exactly as before (isTemplate defaults true).
function renderHtml(input, data, { isTemplate = true } = {}) {
  if (!isTemplate) {
    return `<style>${SCHEDULE_CSS}</style>\n${proseLinesToHtml(input)}`;
  }
  const { output } = renderCore(input, data, 'html');
  return `<style>${SCHEDULE_CSS}</style>\n${proseLinesToHtml(output)}`;
}

module.exports = { render, renderHtml, TEMPLATE_TOKENS, MODE_LABELS, SCHEDULE_CSS };
