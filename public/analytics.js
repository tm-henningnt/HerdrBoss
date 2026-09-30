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
// A timeline keeps 86 percent of its view width, so a 10.5 px tick renders at 9 px or more. A narrow screen scrolls the chart in its box.
const timelineMin = (width) => Math.max(380, Math.round(width * 0.86));
const sizeStyle = (width, min, grow = 1.35) => `min-width:${Math.round(Math.min(width, min))}px;max-width:${Math.round(width * grow)}px`;
// One tab stop for each chart: the first hit area has tabindex 0 and the others -1. The arrow keys move the stop (public/app.js).
// data-keep-attrs keeps the moved stop when a refresh patches the chart.
const rovingTips = () => {
  let first = true;
  return (text, forced) => {
    const index = forced ?? (first ? 0 : -1);
    if (forced === undefined) first = false;
    return `data-tip="${esc(text)}" tabindex="${index}" data-keep-attrs="tabindex"`;
  };
};

// The marker lines, the flags, and the hit areas over the flags. A flag opens to the right of its line, or to the left near the right edge.
// A flag text that would overlap a flag text already drawn is left out; its pennant and its hit area stay.
function markerLayer(marks, { left, right, top, plotH, step, width }, tipAttr) {
  if (!marks.length) return '';
  const PENNANT = 9;
  const items = marks.map((m) => {
    const x = left + m.i * step + step / 2;
    const text = String(m.flag || '');
    const textW = Math.round(text.length * 5.6);
    const flip = x + 12 + textW > width - right && x - 12 - textW >= left - 30;
    const span = (w) => (flip ? [x - w, x] : [x, x + w]);
    return { m, x, text, textW, flip, span };
  });
  const clash = (a, b) => a[0] < b[1] + 4 && a[1] > b[0] - 4;
  const taken = [];
  const lines = [];
  const hits = [];
  items.forEach((it, index) => {
    const { m, x, text, textW, flip, span } = it;
    const sign = flip ? -1 : 1;
    // A text shows only when it clears the pennants of the other flags and the texts already drawn.
    const withText = !!text && !items.some((o, j) => j !== index && clash(span(12 + textW), o.span(PENNANT))) && !taken.some((t) => clash(span(12 + textW), t));
    const box = span(withText ? 12 + textW : PENNANT);
    taken.push(box);
    const pennant = `M${x} 4h${PENNANT * sign}l${-3 * sign} 4.5l${3 * sign} 4.5h${-PENNANT * sign}z`;
    lines.push(`<g><line x1="${x}" x2="${x}" y1="4" y2="${top + plotH}" class="viz-marker"/><path d="${pennant}" class="viz-flag"/>${withText ? `<text x="${x + 12 * sign}" y="12.5" text-anchor="${flip ? 'end' : 'start'}" class="viz-flag-text">${esc(text)}</text>` : ''}</g>`);
    const hitX = Math.max(0, Math.min(box[0], x - step / 2));
    const hitW = Math.max(step, box[1] - hitX);
    hits.push(`<rect x="${hitX}" y="0" width="${hitW}" height="${top}" class="viz-hit viz-marker-hit" ${tipAttr(m.tip || '', -1)}/>`);
  });
  return `${lines.join('')}${hits.join('')}`;
}

// Stacked bars, one column for each category. The hit column over each bar holds the tooltip text for hover, focus, and touch.
// markers: [{ i, flag, tip, note }]. A marker is a thin line at column i with a small flag at the top. The flag text is left out when it
// would overlap another flag. The marker has its own hit area over the flag, and its note joins the tooltip of its column.
export function stackedBars({ cats, series, fmt = (n) => String(n), label = '', height = 190, markers = [] }) {
  const n = cats.length;
  const marks = markers.filter((m) => Number.isInteger(m?.i) && m.i >= 0 && m.i < n);
  const left = 46, right = n > 21 ? 16 : 8, top = marks.length ? 28 : 10, bottom = 26;
  const plotH = height - top - bottom;
  // A chart of more than 21 columns, such as 30 days, uses narrower columns so that it fits a half-width card.
  const step = Math.max(n > 21 ? 16 : 24, Math.min(56, 500 / Math.max(1, n)));
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
    const notes = marks.filter((m) => m.i === i && m.note).map((m) => m.note);
    const tip = [cat.tip || cat.label, ...lines, `Total: ${fmt(totals[i])}`, ...notes].join('\n');
    return `<g>${rects}${tick}<rect x="${left + i * step}" y="${top}" width="${step}" height="${plotH}" class="viz-hit" ${tipAttr(tip)}/></g>`;
  }).join('');
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, left + right + n * (n > 21 ? 15 : 22))}" role="img" aria-label="${esc(label)}">${ticks}${cols}${markerLayer(marks, { left, right, top, plotH, step, width }, tipAttr)}</svg>`;
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
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, timelineMin(width))}" role="img" aria-label="${esc(label)}">${ticks}${shade}${paths}${labels}${hits}</svg>`;
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
  return `<svg class="viz viz-strip" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, timelineMin(width))}" role="img" aria-label="${esc(label)}"><line x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" class="viz-grid base"/><text x="${left - 6}" y="${top + 8}" text-anchor="end" class="viz-tick">${top1}</text><text x="${left - 6}" y="${top + plotH}" text-anchor="end" class="viz-tick">${esc(unit)}</text>${bars}${hits}</svg>`;
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

// ---------- Denials per day ----------

export const DENIAL_RANGES = [3, 7, 30];
export const DEFAULT_DENIAL_RANGE = 3;
export const denialRange = (value) => (DENIAL_RANGES.includes(Number(value)) ? Number(value) : DEFAULT_DENIAL_RANGE);
export const DENIAL_LABEL = { refused: 'Blocked or refused', approved: 'Escalation approved by a rule' };

// The last range days of the daily series of /api/analytics for one harness or for all. Refused holds every block, refusal, and sandbox
// error, and every event with no known outcome. Approved holds the escalations that a rule approved: it is friction, not a failure.
export function denialSeries(daily, { range = DEFAULT_DENIAL_RANGE, harness = 'all' } = {}) {
  const n = denialRange(range);
  const days = Array.isArray(daily?.days) ? daily.days.slice(-n) : [];
  const source = daily?.harnesses && Object.hasOwn(daily.harnesses, harness) ? daily.harnesses[harness] : null;
  const pick = (key) => days.map((_, i) => {
    const list = source?.[key];
    const v = Array.isArray(list) ? list[list.length - days.length + i] : 0;
    return Number.isFinite(v) ? v : 0;
  });
  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const refused = pick('refused'), approved = pick('approved');
  return {
    days,
    series: [
      { key: 'refused', label: DENIAL_LABEL.refused, cls: 's2', values: refused },
      { key: 'approved', label: DENIAL_LABEL.approved, cls: 's2 lighter', values: approved },
    ],
    totals: { refused: sum(refused), approved: sum(approved) },
    unclassified: sum(pick('unclassified')),
  };
}

// The legend of the chart: each series with its total for the range, so the size difference is written and not only drawn.
export function denialLegendHtml(win, extra = '') {
  return legendHtml(win.series.map((s) => ({ ...s, label: `${s.label} ${(win.totals[s.key] || 0).toLocaleString('en-US')}` })), extra);
}

// The harness change markers of the window, for one harness or for all: { i, date, harness, label, flag, tip, note }.
export function denialMarkers(changes, days, harness = 'all') {
  const index = new Map((days || []).map((d, i) => [d, i]));
  return (Array.isArray(changes) ? changes : []).filter((c) => index.has(c?.date) && (harness === 'all' || c.harness === harness)).map((c) => {
    const name = HARNESS_LABEL[c.harness] || c.harness;
    return { i: index.get(c.date), date: c.date, harness: c.harness, label: c.label, flag: name, tip: `${dayLabel(c.date, true)}\n${name}: ${c.label}`, note: `Marker: ${name}: ${c.label}` };
  });
}

// The tables behind Details: one row for each day with both series, and one row for each marker.
export function denialDetailsHtml({ win, markers = [] }) {
  const cell = (label, value, mono = true) => `<td data-label="${esc(label)}"${mono ? ' class="mono"' : ''}>${value}</td>`;
  const total = (a, b) => (a || 0) + (b || 0);
  const [refused, approved] = win.series;
  const dayRows = win.days.map((day, i) => `<tr>${cell('Date', esc(day), false)}${cell('Refused', refused.values[i])}${cell('Approved', approved.values[i])}${cell('Total', total(refused.values[i], approved.values[i]))}</tr>`).join('');
  const sumRow = `<tr class="viz-total">${cell('Date', 'Total', false)}${cell('Refused', win.totals.refused)}${cell('Approved', win.totals.approved)}${cell('Total', total(win.totals.refused, win.totals.approved))}</tr>`;
  const days = `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Date</th><th>Refused</th><th>Approved</th><th>Total</th></tr></thead><tbody>${dayRows}${sumRow}</tbody></table></div>`;
  const note = win.unclassified ? `<p class="viz-note">${win.unclassified.toLocaleString('en-US')} ${win.unclassified === 1 ? 'event has' : 'events have'} no known outcome and ${win.unclassified === 1 ? 'counts' : 'count'} as refused.</p>` : '';
  const marks = markers.length
    ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Date</th><th>Harness</th><th>Change</th></tr></thead><tbody>${markers.map((m) => `<tr>${cell('Date', esc(m.date), false)}${cell('Harness', esc(HARNESS_LABEL[m.harness] || m.harness), false)}${cell('Change', esc(m.label), false)}</tr>`).join('')}</tbody></table></div>`
    : '<p class="viz-note">No harness changes are recorded in this window.</p>';
  return `${days}${note}<h3>Harness changes</h3>${marks}`;
}

// ---------- Lock wait and hold ----------

// The daily lock figures of /api/analytics for one project or for all. A project that is not in the data counts as all.
// The hold is the bottom part of a bar and the wait is the part above it: the wait is the cost of the queue.
export function lockWaitSeries(locks, project = 'all') {
  const days = Array.isArray(locks?.days) ? locks.days : [];
  const list = Array.isArray(locks?.projects) ? locks.projects : [];
  const chosen = project !== 'all' && list.some((p) => p.project === project) ? project : 'all';
  const rows = chosen === 'all' ? list : list.filter((p) => p.project === chosen);
  const pick = (key) => days.map((_, i) => rows.reduce((sum, p) => sum + (Number.isFinite(p[key]?.[i]) ? p[key][i] : 0), 0));
  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const wait = pick('wait'), hold = pick('hold');
  return {
    days,
    project: chosen,
    projects: list.map((p) => p.project),
    series: [
      { key: 'hold', label: 'Hold', cls: 's1', values: hold },
      { key: 'wait', label: 'Wait', cls: 's2', values: wait },
    ],
    totals: { wait: sum(wait), hold: sum(hold), runs: sum(pick('runs')), timeouts: sum(pick('timeouts')) },
  };
}

// The tables behind Details: one row for each day, and one row for each project of the window.
export function lockWaitDetailsHtml(win, locks) {
  const cell = (label, value, mono = true) => `<td data-label="${esc(label)}"${mono ? ' class="mono"' : ''}>${value}</td>`;
  const dayRows = win.days.map((day, i) => `<tr>${cell('Date', esc(day), false)}${cell('Wait', minutes(win.series[1].values[i]))}${cell('Hold', minutes(win.series[0].values[i]))}</tr>`).join('');
  const days = `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Date</th><th>Wait</th><th>Hold</th></tr></thead><tbody>${dayRows}<tr class="viz-total">${cell('Date', 'Total', false)}${cell('Wait', minutes(win.totals.wait))}${cell('Hold', minutes(win.totals.hold))}</tr></tbody></table></div>`;
  const rows = (Array.isArray(locks?.projects) ? locks.projects : []).filter((p) => win.project === 'all' || p.project === win.project);
  const projects = rows.length
    ? `<h3>By project</h3><div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Project</th><th>Runs</th><th>Wait</th><th>Hold</th><th>Timeouts</th></tr></thead><tbody>${rows.map((p) => {
      const sum = (values) => values.reduce((a, b) => a + b, 0);
      return `<tr>${cell('Project', esc(p.project), false)}${cell('Runs', sum(p.runs))}${cell('Wait', minutes(p.waitTotal))}${cell('Hold', minutes(p.holdTotal))}${cell('Timeouts', sum(p.timeouts))}</tr>`;
    }).join('')}</tbody></table></div>`
    : '<p class="viz-note">No lock use is recorded in this window.</p>';
  return `${days}${projects}`;
}

// ---------- Policy changes ----------

export const POLICY_CALLER_LABEL = { page: 'Page', cli: 'CLI', 'project-new': 'Project new', unknown: 'Unknown' };
export const POLICY_LIST_ENTRIES = 20;
export const POLICY_LIST_KEYS = 6;
const pad2 = (n) => String(n).padStart(2, '0');

// The local date and time of an entry, for example `Wed 30 Sep 18:25`.
export function policyWhen(at) {
  const d = new Date(Date.parse(at));
  if (Number.isNaN(d.getTime())) return '–';
  return `${dayLabel(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, true)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export const policyValue = (value) => (value === null || value === undefined ? 'none' : String(value));
const callerBadge = (caller) => `<span class="policy-caller ${esc(caller)}">${esc(POLICY_CALLER_LABEL[caller] || POLICY_CALLER_LABEL.unknown)}</span>`;

// The title: what the newest write was.
export function policyChangesTitle(entries) {
  if (!entries?.length) return 'Policy changes';
  const [last] = entries;
  const count = last.changes.length;
  return `Last policy write: ${POLICY_CALLER_LABEL[last.caller] || 'Unknown'}, ${count} ${count === 1 ? 'key' : 'keys'} changed, ${policyWhen(last.at)}`;
}

// The list of the newest writes. A row holds the time, the caller kind, and the first changed keys with the old and the new value.
export function policyChangesListHtml(entries) {
  const rows = (entries || []).slice(0, POLICY_LIST_ENTRIES).map((entry) => {
    const shown = entry.changes.slice(0, POLICY_LIST_KEYS);
    const more = entry.changes.length - shown.length;
    const keys = shown.map((c) => `<li><code>${esc(c.key)}</code> <span class="policy-old">${esc(policyValue(c.old))}</span> → <span class="policy-new">${esc(policyValue(c.new))}</span></li>`).join('');
    return `<li class="policy-change"><div class="policy-head"><time datetime="${esc(entry.at)}">${esc(policyWhen(entry.at))}</time>${callerBadge(entry.caller)}</div><ul class="policy-keys">${keys}${more > 0 ? `<li class="policy-more">and ${more} more in Details</li>` : ''}</ul></li>`;
  }).join('');
  return `<ul class="policy-changes">${rows}</ul>`;
}

// The table behind Details: one row for each changed key of each kept write, newest first.
export function policyChangesDetailsHtml(entries) {
  const head = ['Time', 'Caller', 'Key', 'Old', 'New'];
  const cell = (label, value, mono = true) => `<td data-label="${esc(label)}"${mono ? ' class="mono"' : ''}>${value}</td>`;
  const rows = (entries || []).flatMap((entry) => entry.changes.map((c) => `<tr>${cell('Time', esc(policyWhen(entry.at)), false)}${cell('Caller', esc(POLICY_CALLER_LABEL[entry.caller] || 'Unknown'), false)}${cell('Key', esc(c.key))}${cell('Old', esc(policyValue(c.old)))}${cell('New', esc(policyValue(c.new)))}</tr>`)).join('');
  return `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
