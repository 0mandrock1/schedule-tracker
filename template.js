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
  header_image: 'Картинка-заголовок дня (URL або опис), якщо є',
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
  claude_comment: 'Коментар Клода — може зʼявитися в будь-якому блоці',
  image_anchor: 'Можливе місце для картинки дня — рушій сам обирає рівно одне з них',
};

const COMMENT_RE = /\{#[\s\S]*?#\}/g;
const COND_RE = /\{\?\s*([\w.]+)\s*\?\}([\s\S]*?)\{\?\/\?\}/;
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const ANCHOR_RE = /\{\{\s*image_anchor\s*\}\}/g;

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
  if (token === 'claude_comment') return format === 'html' ? claudeCommentToHtml(value) : claudeCommentToMd(value);
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

// Picks exactly one {{image_anchor}} occurrence deterministically from `data.date`,
// replaces it with a placeholder, and blanks out the rest — "the engine chooses where
// the picture goes today," not the template author.
function resolveImageAnchors(md, data, format) {
  const matches = [...md.matchAll(ANCHOR_RE)];
  if (!matches.length) return md;
  const chosenIdx = hashStr(String(data.date || '')) % matches.length;
  const placeholder = format === 'html' ? '<div class="image-anchor">🖼️ [зображення дня]</div>' : '🖼️ [зображення дня]';
  let i = 0;
  return md.replace(ANCHOR_RE, () => (i++ === chosenIdx ? placeholder : ''));
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
  out = resolveConditionals(out, data);
  out = resolveImageAnchors(out, data, format);
  out = substituteTokens(out, data, format, warnings, usedTokens);
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

function renderHtml(templateMd, data) {
  const { output } = renderCore(templateMd, data, 'html');
  return proseLinesToHtml(output);
}

module.exports = { render, renderHtml, TEMPLATE_TOKENS, MODE_LABELS };
