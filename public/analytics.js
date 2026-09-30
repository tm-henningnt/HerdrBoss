// Pure view logic of the Analytics page: the chart figures, the SVG charts, the headline strip, and the activity log filter.
// A chart uses the series classes s1 to s5 and s-other. style.css defines one color set for light and one for dark,
// checked with the dataviz palette validator. Text never takes a series color.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const SERIES_CLASSES = ['s1', 's2', 's3', 's4', 's5'];
const DAY_MS = 86400000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A day key YYYY-MM-DD as a short label: 'Tue 29'. The long form 'Tue 29 Sep' goes into a tooltip.
export function dayLabel(day, long = false) {
  const [y, m, d] = String(day).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return long ? `${WEEKDAY[date.getDay()]} ${d} ${MONTH[date.getMonth()]}` : `${WEEKDAY[date.getDay()]} ${d}`;
}
export function usd(n) {
  if (!Number.isFinite(n)) return '–';
  return n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}
export function minutes(ms) {
  if (!Number.isFinite(ms)) return '–';
  const m = ms / 60000;
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`;
}
export function compact(n) {
  if (!Number.isFinite(n)) return '–';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
}

// A round top for an axis at or above the value. The half of each step is round too, for the middle tick.
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  for (const f of [1, 1.2, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (f * p >= value) return f * p;
  return 10 * p;
}

// The first limit series keep their own slot. The rest fold into one 'Other' series in the neutral color.
export function foldSeries(series, limit = SERIES_CLASSES.length) {
  const kept = series.slice(0, limit).map((s, i) => ({ ...s, cls: s.cls || SERIES_CLASSES[i] }));
  const rest = series.slice(limit);
  if (!rest.length) return kept;
  const values = rest[0].values.map((_, i) => rest.reduce((sum, s) => sum + (s.values[i] || 0), 0));
  return [...kept, { key: 'other', label: 'Other', cls: 's-other', values }];
}

export function legendHtml(series, extra = '') {
  return `<ul class="viz-legend">${series.map((s) => `<li><i class="viz-key ${esc(s.cls)}${s.dashed ? ' dashed' : ''}" aria-hidden="true"></i>${esc(s.label)}</li>`).join('')}${extra}</ul>`;
}

// The chart keeps its drawn size between min and 1.35 times its width. Below min it scrolls sideways in its box.
const sizeStyle = (width, min, grow = 1.35) => `min-width:${Math.round(Math.min(width, min))}px;max-width:${Math.round(width * grow)}px`;
// One tab stop for each chart: the first hit area has tabindex 0 and the others -1. The arrow keys move the stop (public/app.js).
// data-keep-attrs keeps the moved stop when a refresh patches the chart.
const rovingTips = () => {
  let first = true;
  return (text) => {
    const index = first ? 0 : -1;
    first = false;
    return `data-tip="${esc(text)}" tabindex="${index}" data-keep-attrs="tabindex"`;
  };
};

// Stacked bars, one column for each category. The hit column over each bar holds the tooltip text for hover, focus, and touch.
export function stackedBars({ cats, series, fmt = (n) => String(n), label = '', height = 190 }) {
  const n = cats.length;
  const left = 46, right = 8, top = 10, bottom = 26;
  const plotH = height - top - bottom;
  const step = Math.max(24, Math.min(56, 500 / Math.max(1, n)));
  const width = left + right + n * step;
  const barW = Math.min(30, Math.round(step * 0.62));
  const totals = cats.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const y = (v) => top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max].map((v) => `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" class="viz-grid${v === 0 ? ' base' : ''}"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end" class="viz-tick">${esc(fmt(v))}</text>`).join('');
  const every = Math.ceil(44 / step);
  const tipAttr = rovingTips();
  const cols = cats.map((cat, i) => {
    const x0 = left + i * step + (step - barW) / 2;
    let base = top + plotH;
    const rects = series.map((s) => {
      const v = s.values[i] || 0;
      if (v <= 0) return '';
      const h = (v / max) * plotH;
      const gap = h > 3 ? 1 : 0;
      base -= h;
      return `<rect x="${x0}" y="${base + gap}" width="${barW}" height="${Math.max(0.5, h - gap)}" rx="2" class="viz-fill ${esc(s.cls)}"/>`;
    }).join('');
    const tick = (n - 1 - i) % every === 0 ? `<text x="${left + i * step + step / 2}" y="${top + plotH + 17}" text-anchor="middle" class="viz-tick">${esc(cat.label)}</text>` : '';
    const lines = series.filter((s) => s.values[i]).map((s) => `${s.label}: ${fmt(s.values[i])}`);
    const tip = [cat.tip || cat.label, ...lines, `Total: ${fmt(totals[i])}`].join('\n');
    return `<g>${rects}${tick}<rect x="${left + i * step}" y="${top}" width="${step}" height="${plotH}" class="viz-hit" ${tipAttr(tip)}/></g>`;
  }).join('');
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, left + right + n * 22)}" role="img" aria-label="${esc(label)}">${ticks}${cols}</svg>`;
}

// Lines over time on one axis. A null value leaves a gap. bands shade the columns where a lock holder held the lock.
export function lineChart({ points, series, yMax = 100, fmt = (n) => `${n}%`, label = '', height = 200, tips = [], xLabels = [], bands = [] }) {
  const n = points.length;
  const left = 40, right = 8, top = 10, bottom = 26;
  const plotH = height - top - bottom;
  const step = Math.max(3, Math.min(40, 520 / Math.max(1, n)));
  const width = left + right + n * step;
  const max = niceMax(yMax);
  const y = (v) => top + plotH - (Math.min(v, max) / max) * plotH;
  const x = (i) => left + i * step + step / 2;
  const ticks = [0, max / 2, max].map((v) => `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" class="viz-grid${v === 0 ? ' base' : ''}"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end" class="viz-tick">${esc(fmt(v))}</text>`).join('');
  const shade = bands.map((b) => (b.alpha > 0 ? `<rect x="${left + b.i * step}" y="${top}" width="${step}" height="${plotH}" class="viz-band" style="opacity:${(0.25 + 0.55 * Math.min(1, b.alpha)).toFixed(2)}"/>` : '')).join('');
  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined || !Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d ? `<path d="${d}" class="viz-line ${esc(s.cls)}${s.dashed ? ' dashed' : ''}"/>` : '';
  }).join('');
  const labels = xLabels.map((l) => `<text x="${x(l.i)}" y="${top + plotH + 17}" text-anchor="middle" class="viz-tick">${esc(l.label)}</text>`).join('');
  const tipAttr = rovingTips();
  const hits = points.map((_, i) => (tips[i] ? `<rect x="${left + i * step}" y="${top}" width="${step}" height="${plotH}" class="viz-hit" ${tipAttr(tips[i])}/>` : '')).join('');
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, 380)}" role="img" aria-label="${esc(label)}">${ticks}${shade}${paths}${labels}${hits}</svg>`;
}

// A small strip of bars under a timeline, with its own short axis: the minutes a suite request waited in each column.
export function stripBars({ values, max, label = '', height = 56, tips = [], unit = 'min' }) {
  const n = values.length;
  const left = 40, right = 8, top = 6, bottom = 6;
  const plotH = height - top - bottom;
  const step = Math.max(3, Math.min(40, 520 / Math.max(1, n)));
  const width = left + right + n * step;
  const top1 = Math.max(1, max);
  const bars = values.map((v, i) => (v > 0 ? `<rect x="${left + i * step + 0.5}" y="${top + plotH - (v / top1) * plotH}" width="${Math.max(1, step - 1)}" height="${(v / top1) * plotH}" class="viz-fill s-wait"/>` : '')).join('');
  // The strip repeats the tooltips of the chart above it, so it takes no tab stop. Hover and touch still open a tooltip.
  const hits = values.map((_, i) => (tips[i] ? `<rect x="${left + i * step}" y="${top}" width="${step}" height="${plotH}" class="viz-hit" data-tip="${esc(tips[i])}"/>` : '')).join('');
  return `<svg class="viz viz-strip" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, 380)}" role="img" aria-label="${esc(label)}"><line x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" class="viz-grid base"/><text x="${left - 6}" y="${top + 8}" text-anchor="end" class="viz-tick">${top1}</text><text x="${left - 6}" y="${top + plotH}" text-anchor="end" class="viz-tick">${esc(unit)}</text>${bars}${hits}</svg>`;
}

// A heat map: rows by columns, one blue step for each fifth of the largest value. Zero stays the empty cell color.
export function heatGrid({ rows, cols, values, label = '', tip = () => '' }) {
  const left = 124, top = 6, cell = 36, rowH = 28, bottom = 22;
  const width = left + cols.length * cell + 4;
  const height = top + rows.length * rowH + bottom;
  const max = Math.max(0, ...values.flat());
  const tipAttr = rovingTips();
  const cells = rows.map((_, r) => cols.map((__, c) => {
    const v = values[r][c] || 0;
    const q = v && max ? Math.min(5, Math.ceil((v / max) * 5)) : 0;
    const x = left + c * cell, yy = top + r * rowH;
    return `<rect x="${x + 1}" y="${yy + 1}" width="${cell - 2}" height="${rowH - 2}" rx="3" class="viz-heat q${q}"/>${v ? `<text x="${x + cell / 2}" y="${yy + rowH / 2 + 4}" text-anchor="middle" class="viz-cell${q >= 4 ? ' on-dark' : ''}">${v}</text>` : ''}<rect x="${x}" y="${yy}" width="${cell}" height="${rowH}" class="viz-hit" ${tipAttr(tip(r, c))}/>`;
  }).join('')).join('');
  const rowLabels = rows.map((row, r) => `<text x="${left - 8}" y="${top + r * rowH + rowH / 2 + 4}" text-anchor="end" class="viz-label">${esc(row)}</text>`).join('');
  const colLabels = cols.map((col, c) => `<text x="${left + c * cell + cell / 2}" y="${height - 6}" text-anchor="middle" class="viz-tick">${esc(col)}</text>`).join('');
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, width, 1.1)}" role="img" aria-label="${esc(label)}">${rowLabels}${cells}${colLabels}</svg>`;
}

// Horizontal bars of 100%, one row for each model: first-time, rework, and failed runs. The run count and the median time stand at the right.
export function outcomeBars({ rows, label = '' }) {
  const left = 150, barW = 200, right = 112, rowH = 30, top = 4;
  const width = left + barW + right;
  const height = top + rows.length * rowH + 4;
  const tipAttr = rovingTips();
  const body = rows.map((r, i) => {
    const yy = top + i * rowH;
    const total = r.parts.reduce((a, p) => a + p.value, 0) || 1;
    let x = left;
    const segs = r.parts.map((p) => {
      if (!p.value) return '';
      const w = (p.value / total) * barW;
      const rect = `<rect x="${x + 0.5}" y="${yy + 7}" width="${Math.max(1, w - 1)}" height="14" rx="2" class="viz-fill ${esc(p.cls)}"/>`;
      x += w;
      return rect;
    }).join('');
    return `<g><text x="${left - 8}" y="${yy + 15}" text-anchor="end" class="viz-label">${esc(r.label)}</text><text x="${left - 8}" y="${yy + 26}" text-anchor="end" class="viz-tick">${esc(r.sub || '')}</text>`
      + `<rect x="${left}" y="${yy + 7}" width="${barW}" height="14" rx="2" class="viz-track"/>${segs}`
      + `<text x="${left + barW + 8}" y="${yy + 18}" class="viz-label">${esc(r.right || '')}</text><rect x="0" y="${yy}" width="${width}" height="${rowH}" class="viz-hit" ${tipAttr(r.tip || '')}/></g>`;
  }).join('');
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, width)}" role="img" aria-label="${esc(label)}">${body}</svg>`;
}

// ---------- Figures ----------

const ROLE_LABEL = { boss: 'Boss', orchestrator: 'Orchestrators', worker: 'Workers', other: 'Other' };
const HARNESS_LABEL = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };

// Spend per day, oldest first, split by role or by harness. The value is USD at API prices; a day without prices counts 0 USD.
// metric 'tokens' counts tokens instead, for a window without prices.
export function spendSeries(spend, by = 'role', metric = 'costUsd') {
  const days = [...(spend?.days || [])].sort((a, b) => a.day.localeCompare(b.day));
  const keys = by === 'role' ? ['boss', 'orchestrator', 'worker', 'other'] : ['claude', 'codex', 'opencode', 'pi'];
  const labels = by === 'role' ? ROLE_LABEL : HARNESS_LABEL;
  const valueOf = (day, key) => {
    if (by === 'role') return day.roles.find((r) => r.role === key)?.[metric] || 0;
    return day.roles.reduce((sum, r) => sum + (r.harnesses?.[key]?.[metric] || 0), 0);
  };
  const series = keys.map((key, i) => ({ key, label: labels[key], cls: SERIES_CLASSES[i], values: days.map((d) => valueOf(d, key)) }))
    .filter((s) => s.values.some((v) => v > 0));
  return { days: days.map((d) => d.day), series };
}

// Claude spend per day for each role, with the mean of the last 7 days and of the 7 days before.
export function claudeSpend(spend) {
  const days = [...(spend?.days || [])].sort((a, b) => a.day.localeCompare(b.day));
  const perDay = days.map((d) => ({ day: d.day, roles: Object.fromEntries(d.roles.map((r) => [r.role, r.harnesses?.claude?.costUsd || 0])) }));
  const total = (d) => Object.values(d.roles).reduce((a, b) => a + b, 0);
  const last = perDay.slice(-7), before = perDay.slice(-14, -7);
  const mean = (list) => (list.length ? list.reduce((a, d) => a + total(d), 0) / list.length : null);
  const roleMean = {};
  for (const d of last) for (const [role, v] of Object.entries(d.roles)) roleMean[role] = (roleMean[role] || 0) + v / last.length;
  return { mean: mean(last), before: mean(before), roleMean, days: perDay.length };
}

// Quota use and expected pace for each provider over the recorded window, from the quota trend of /api/usage.
export function quotaSeries(trend, labelOf = (p) => p) {
  const providers = Object.keys(trend || {}).filter((p) => (trend[p] || []).length).sort();
  const times = [...new Set(providers.flatMap((p) => trend[p].map((r) => Date.parse(r.at))))].filter(Number.isFinite).sort((a, b) => a - b);
  // One column for each hour keeps the chart readable over a day or a week.
  const hour = 3600000;
  const cols = [...new Set(times.map((t) => Math.floor(t / hour) * hour))];
  const at = new Map(cols.map((t, i) => [t, i]));
  const series = [];
  providers.forEach((p, k) => {
    const used = Array(cols.length).fill(null), pace = Array(cols.length).fill(null);
    for (const r of trend[p]) {
      const i = at.get(Math.floor(Date.parse(r.at) / hour) * hour);
      if (i === undefined) continue;
      if (Number.isFinite(r.usedPercent)) used[i] = r.usedPercent;
      if (Number.isFinite(r.expectedPercent)) pace[i] = r.expectedPercent;
    }
    const cls = SERIES_CLASSES[k % SERIES_CLASSES.length];
    const lastUsed = [...used].reverse().find((v) => v !== null) ?? null;
    const lastPace = [...pace].reverse().find((v) => v !== null) ?? null;
    series.push({ key: p, label: `${labelOf(p)} used`, cls, values: used, provider: p, lastUsed, lastPace });
    series.push({ key: `${p}-pace`, label: `${labelOf(p)} pace`, cls, values: pace, dashed: true, provider: p });
  });
  return { cols, series };
}

// Denials for one harness or all: one row for each cause, one column for each day.
export function denialGrid(denials, harness = 'all') {
  const days = denials?.days || [];
  const byCause = new Map();
  for (const r of denials?.rows || []) {
    if (harness !== 'all' && r.harness !== harness) continue;
    const counts = byCause.get(r.cause) || Array(days.length).fill(0);
    r.counts.forEach((n, i) => { counts[i] += n || 0; });
    byCause.set(r.cause, counts);
  }
  const causes = [...byCause].map(([cause, counts]) => ({ cause, counts, total: counts.reduce((a, b) => a + b, 0) }))
    .filter((c) => c.total).sort((a, b) => b.total - a.total || a.cause.localeCompare(b.cause));
  return { days, causes, total: causes.reduce((a, c) => a + c.total, 0) };
}

export function firstTimeRate(scorecard) {
  const rows = scorecard || [];
  const judged = rows.reduce((a, r) => a + r.firstTime + r.rework + r.failed, 0);
  const first = rows.reduce((a, r) => a + r.firstTime, 0);
  return judged ? { rate: first / judged, judged, runs: rows.reduce((a, r) => a + r.runs, 0) } : null;
}

// ---------- Activity log ----------

export const ACTIVITY_RANGES = [['1h', 'Last hour', 3600000], ['6h', 'Last 6 hours', 6 * 3600000], ['24h', 'Last 24 hours', DAY_MS], ['7d', 'Last 7 days', 7 * DAY_MS], ['all', 'All kept', Infinity]];
export const ACTIVITY_LEVELS = ['info', 'warn', 'critical', 'error'];

export function eventLevel(e) {
  if (ACTIVITY_LEVELS.includes(e?.severity)) return e.severity;
  return e?.type === 'error' ? 'error' : 'info';
}

// The events that match every filter, newest first. The search matches the text, the kind, the pane, and the project, without case.
export function activityFilter(events, { kind = 'all', project = 'all', level = 'all', range = 'all', q = '' } = {}, now = Date.now()) {
  const span = ACTIVITY_RANGES.find((r) => r[0] === range)?.[2] ?? Infinity;
  const needle = String(q || '').trim().toLowerCase();
  return (events || []).filter((e) => {
    if (kind !== 'all' && e.type !== kind) return false;
    if (project !== 'all' && e.project !== project) return false;
    if (level !== 'all' && eventLevel(e) !== level) return false;
    if (span !== Infinity && !(now - Date.parse(e.at) <= span)) return false;
    if (needle && ![e.text, e.type, e.pane, e.project, ...(e.titles || [])].some((v) => String(v ?? '').toLowerCase().includes(needle))) return false;
    return true;
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// The choices of the kind and project filters, from the events that the state holds.
export function activityChoices(events) {
  const kinds = [...new Set((events || []).map((e) => e.type).filter(Boolean))].sort();
  const projects = [...new Set((events || []).map((e) => e.project).filter(Boolean))].sort();
  return { kinds, projects };
}
