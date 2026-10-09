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

const COMMUNICATION_KINDS = ['task', 'nudge', 'report', 'reminder', 'reply', 'other'];
const COMMUNICATION_LABELS = ['Task', 'Nudge', 'Report', 'Reminder', 'Reply', 'Other'];
const countValue = (value) => Number.isFinite(value) && value > 0 ? value : 0;

// Aggregate projects into six fixed series. The chart size depends on days, not project count.
export function communicationSeries(data, project = 'all') {
  const days = data?.days || [];
  const projects = (data?.projects || []).filter((row) => project === 'all' || row.project === project);
  const series = COMMUNICATION_KINDS.map((kind, i) => ({ key: kind, label: COMMUNICATION_LABELS[i], cls: SERIES_CLASSES[i] || 's-other',
    values: days.map((_, day) => projects.reduce((sum, row) => sum + countValue(row.counts?.[kind]?.[day]), 0)),
  }));
  return { days, projects, series, total: series.reduce((sum, row) => sum + row.values.reduce((a, b) => a + b, 0), 0) };
}

// GitHub Actions minutes by repository and ISO week. Five repositories keep separate colors; the rest share Other.
export function actionsMinutesSeries(data) {
  const weeks = Array.isArray(data?.weeks) ? data.weeks.slice(-12) : [];
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  const raw = repos.map((row, i) => ({
    key: row.repo,
    label: row.repo,
    cls: SERIES_CLASSES[i] || 's-other',
    values: weeks.map((_, week) => {
      const value = Number(row.minutes?.[week]);
      return Number.isFinite(value) && value > 0 ? value : 0;
    }),
  }));
  const series = foldSeries(raw, SERIES_CLASSES.length);
  return { weeks, series, total: series.reduce((sum, row) => sum + row.values.reduce((a, b) => a + b, 0), 0) };
}

export function actionsMinutesScope(data) {
  const truncated = data?.truncated ? ' Some repositories reached the 500-run limit. Their older weeks may be incomplete.' : '';
  const updated = data?.updatedAt ? ` Updated ${new Date(data.updatedAt).toLocaleString()}.` : '';
  return `Last 12 ISO weeks. Minutes are estimated from run times.${truncated} The service uses its GitHub token. It skips repositories when that token has no access.${updated}`;
}

export function actionsMinutesDetailsHtml(data) {
  const weeks = Array.isArray(data?.weeks) ? data.weeks : [];
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  if (!weeks.length || !repos.length) return '<div class="calm-state">No GitHub Actions runs are recorded in the last 12 weeks.</div>';
  const thisWeek = weeks.length - 1;
  const lastWeek = thisWeek - 1;
  const amount = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0';
  const rows = repos.slice(0, 200).map((row) => [
    row.repo,
    `${amount(row.minutes?.[thisWeek])} min`,
    lastWeek >= 0 ? `${amount(row.minutes?.[lastWeek])} min` : '–',
    amount(row.runs?.[thisWeek]),
  ]);
  return communicationTable(['Repository', 'This week', 'Last week', 'Runs this week'], rows);
}

const communicationTable = (heads, rows) => {
  const shown = rows.slice(0, 200);
  return `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${shown.map(row => `<tr>${row.map((value, i) => `<td data-label="${esc(heads[i])}"${i ? ' class="mono"' : ''}>${esc(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    + (rows.length > shown.length ? `<p class="viz-note">Showing ${shown.length} of ${rows.length} rows. The figures include all rows.</p>` : '');
};

export function communicationDailyDetailsHtml(win) {
  const rows = [];
  for (const project of win.projects) for (let day = 0; day < win.days.length; day++) {
    const counts = COMMUNICATION_KINDS.map(kind => countValue(project.counts?.[kind]?.[day]));
    if (counts.some(Boolean)) rows.push([project.project, win.days[day], ...counts]);
  }
  return communicationTable(['Project', 'Day', ...COMMUNICATION_LABELS], rows);
}

export function communicationResponseHtml(data) {
  const orchs = data?.orchestrators || [], workers = data?.workers || [];
  if (!orchs.length && !workers.length) return '<div class="calm-state">No response times are recorded yet.</div>';
  const figures = row => [row.messages, row.responses, minutes(row.medianMs), minutes(row.p90Ms)];
  const heads = ['Messages', 'Responses', 'Median', 'p90'];
  return (orchs.length ? `<h4>Per orchestrator</h4>${communicationTable(['Project', 'Agent', ...heads], orchs.map(row => [row.project, row.name || row.pane || 'Unknown', ...figures(row)]))}` : '')
    + (workers.length ? `<h4>Per worker kind and model</h4>${communicationTable(['Kind', 'Model', ...heads], workers.map(row => [row.kind, row.model, ...figures(row)]))}` : '');
}

export function communicationNudgeDetailsHtml(data) {
  const rows = data?.nudgesPerTask || [];
  if (!rows.length) return '<div class="calm-state">No nudges are recorded in this window.</div>';
  return communicationTable(['Project', 'Task', 'Nudges'], rows.map(row => [row.project, row.taskId ?? 'Task not known', row.nudges]));
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
export function lineChart({ points, series, yMax = 100, fmt = (n) => `${n}%`, label = '', height = 200, tips = [], xLabels = [], bands = [], ranges = [], markers = [] }) {
  const n = points.length;
  const marks = markers.filter((m) => Number.isInteger(m?.i) && m.i >= 0 && m.i < n);
  const left = 40, right = 8, top = marks.length ? 28 : 10, bottom = 26;
  const plotH = height - top - bottom;
  const step = Math.max(3, Math.min(40, 520 / Math.max(1, n)));
  const width = left + right + n * step;
  const max = niceMax(yMax);
  const y = (v) => top + plotH - (Math.min(v, max) / max) * plotH;
  const x = (i) => left + i * step + step / 2;
  const ticks = [0, max / 2, max].map((v) => `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" class="viz-grid${v === 0 ? ' base' : ''}"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end" class="viz-tick">${esc(fmt(v))}</text>`).join('');
  const shade = bands.map((b) => (b.alpha > 0 ? `<rect x="${left + b.i * step}" y="${top}" width="${step}" height="${plotH}" class="viz-band" style="opacity:${(0.25 + 0.55 * Math.min(1, b.alpha)).toFixed(2)}"/>` : '')).join('');
  const rangePaths = ranges.map((range) => {
    const quads = [];
    for (let i = 0; i < n - 1; i += 1) {
      const lower = range.lowerValues || [], upper = range.upperValues || [];
      if (![lower[i], lower[i + 1], upper[i], upper[i + 1]].every(Number.isFinite)) continue;
      quads.push(`M${x(i).toFixed(1)} ${y(upper[i]).toFixed(1)}L${x(i + 1).toFixed(1)} ${y(upper[i + 1]).toFixed(1)}L${x(i + 1).toFixed(1)} ${y(lower[i + 1]).toFixed(1)}L${x(i).toFixed(1)} ${y(lower[i]).toFixed(1)}Z`);
    }
    return quads.length ? `<path d="${quads.join('')}" class="viz-range${range.cls ? ` ${esc(range.cls)}` : ''}"/>` : '';
  }).join('');
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
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" style="${sizeStyle(width, timelineMin(width))}" role="img" aria-label="${esc(label)}">${ticks}${shade}${rangePaths}${paths}${labels}${markerLayer(marks, { left, right, top, plotH, step, width }, tipAttr)}${hits}</svg>`;
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

const QUOTA_PLAN_HOUR_MS = 60 * 60 * 1000;
const QUOTA_PLAN_POINT_LIMIT = 3000;
const quotaTime = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

function quotaCurvePoints(curve) {
  return (Array.isArray(curve) ? curve : []).flatMap((point) => {
    const time = quotaTime(point?.at);
    return time !== null && Number.isFinite(point?.usedPercent) ? [{ time, usedPercent: point.usedPercent }] : [];
  }).sort((a, b) => a.time - b.time);
}

function quotaCurveAt(points, requested) {
  if (!points.length) return null;
  let previous = null;
  for (const point of points) {
    if (point.time <= requested) { previous = point; continue; }
    if (!previous) return null;
    const duration = point.time - previous.time;
    return duration > 0 ? previous.usedPercent + (point.usedPercent - previous.usedPercent) * ((requested - previous.time) / duration) : point.usedPercent;
  }
  return previous?.usedPercent ?? null;
}

// Align actual readings and the planner's fast and slow curves on one hourly axis.
export function quotaPlanSeries(data) {
  const plan = data?.plan;
  const windowKey = typeof data?.windowKey === 'string' ? data.windowKey : null;
  const now = quotaTime(data?.now) ?? Date.now();
  const history = (Array.isArray(data?.history) ? data.history : []).flatMap((row) => {
    const time = quotaTime(row?.at);
    if (time === null || time > now || !Number.isFinite(row?.usedPercent) || row.usedPercent < 0 || row.usedPercent > 100) return [];
    if (data?.provider && row.provider && row.provider !== data.provider) return [];
    if (windowKey && row.window && row.window !== windowKey) return [];
    return [{ at: new Date(time).toISOString(), time, usedPercent: row.usedPercent }];
  }).sort((a, b) => a.time - b.time);
  const empty = { windowKey, history, points: [], series: [], ranges: [], markers: [], windows: [], credits: [], now: new Date(now).toISOString(), horizon: null };
  if (!history.length) return empty;

  const fast = plan?.fast || {};
  const slow = plan?.slow || {};
  const fastCurve = quotaCurvePoints(fast.curve);
  const slowCurve = quotaCurvePoints(slow.curve);
  const curveEnd = Math.max(fastCurve.at(-1)?.time ?? now, slowCurve.at(-1)?.time ?? now);
  const horizon = quotaTime(plan?.horizon) ?? quotaTime(fast.horizon) ?? quotaTime(slow.horizon) ?? curveEnd;
  const windows = ['fast', 'slow'].flatMap((key) => (Array.isArray(data?.plan?.[key]?.windows) ? data.plan[key].windows : []).map((window, index) => ({
    scenario: key === 'fast' ? 'Fast' : 'Slow',
    index: index + 1,
    startAt: window.startAt,
    endAt: window.endAt,
    resetsAt: window.resetsAt,
    reason: window.startReason,
  })));
  const fastCredits = Array.isArray(fast.credits) ? fast.credits : [];
  const slowCredits = Array.isArray(slow.credits) ? slow.credits : [];
  const sourceCredits = Array.isArray(data?.credits) ? data.credits : [];
  const ids = [...new Set([...fastCredits, ...slowCredits, ...sourceCredits].map((credit) => credit?.id).filter((id) => typeof id === 'string'))];
  const credits = ids.map((id, index) => {
    const fastCredit = fastCredits.find((credit) => credit.id === id);
    const slowCredit = slowCredits.find((credit) => credit.id === id);
    const source = sourceCredits.find((credit) => credit.id === id);
    return {
      id,
      label: `Credit ${index + 1}`,
      markerLabel: String(index + 1),
      fastApplyAt: fastCredit?.applyAt ?? null,
      slowApplyAt: slowCredit?.applyAt ?? null,
      expiresAt: fastCredit?.expiresAt ?? slowCredit?.expiresAt ?? source?.expiresAt ?? source?.expires_at ?? null,
    };
  });
  const start = Math.min(history[0].time, now);
  const end = Math.max(horizon, now, start);
  const hours = Math.max(1, Math.ceil((end - start) / QUOTA_PLAN_HOUR_MS));
  const stepMs = Math.max(QUOTA_PLAN_HOUR_MS, Math.ceil(hours / QUOTA_PLAN_POINT_LIMIT) * QUOTA_PLAN_HOUR_MS);
  const first = Math.floor(start / stepMs) * stepMs;
  const last = Math.max(first, Math.floor(end / stepMs) * stepMs);
  const times = new Set(Array.from({ length: Math.floor((last - first) / stepMs) + 1 }, (_, i) => first + i * stepMs));
  const eventTimes = [now, end, ...fastCurve.map((point) => point.time), ...slowCurve.map((point) => point.time),
    ...windows.flatMap((window) => [window.startAt, window.endAt, window.resetsAt]),
    ...credits.flatMap((credit) => [credit.fastApplyAt, credit.slowApplyAt, credit.expiresAt])]
    .map(quotaTime).filter((time) => time !== null && time >= first && time <= end);
  eventTimes.forEach((time) => times.add(time));
  const orderedTimes = [...times].sort((a, b) => a - b);
  const indexByTime = new Map(orderedTimes.map((time, index) => [time, index]));
  const actual = Array(orderedTimes.length).fill(null);
  for (const row of history) {
    const bucket = first + Math.floor((row.time - first) / stepMs) * stepMs;
    const index = indexByTime.get(bucket);
    if (index === undefined) continue;
    actual[index] = row.usedPercent;
  }
  const planned = (curve) => orderedTimes.map((time) => time < now || time > horizon ? null : quotaCurveAt(curve, time));
  const fastValues = planned(fastCurve);
  const slowValues = planned(slowCurve);
  const points = orderedTimes.map((time) => ({ at: new Date(time).toISOString(), time }));
  const nearestIndex = (value) => {
    const time = quotaTime(value);
    if (time === null || time < first || time > end) return null;
    let low = 0, high = orderedTimes.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (orderedTimes[mid] < time) low = mid + 1;
      else high = mid;
    }
    return low > 0 && time - orderedTimes[low - 1] < orderedTimes[low] - time ? low - 1 : low;
  };
  const markers = [];
  const windowMarkers = new Map();
  for (const window of windows) {
    if (window.index === 1) continue;
    const index = nearestIndex(window.startAt);
    if (index === null) continue;
    const marker = windowMarkers.get(index) || { i: index, at: window.startAt, kind: 'window', flag: 'Window', tips: [] };
    marker.tips.push(`${window.scenario} window ${window.index} starts ${window.startAt}; next reset ${window.resetsAt || 'unknown'}`);
    windowMarkers.set(index, marker);
  }
  for (const marker of windowMarkers.values()) markers.push({ ...marker, tip: marker.tips.join('\n') });
  for (const credit of credits) {
    const timing = `${credit.label}\nFast apply: ${credit.fastApplyAt || 'not planned'}\nSlow apply: ${credit.slowApplyAt || 'not planned'}\nExpires: ${credit.expiresAt || 'unknown'}`;
    for (const [scenario, at] of [['Fast', credit.fastApplyAt], ['Slow', credit.slowApplyAt]]) {
      const i = nearestIndex(at);
      if (i !== null) markers.push({ i, at, kind: 'credit-apply', flag: `${credit.markerLabel} ${scenario[0]}`, tip: timing });
    }
    const expiryIndex = nearestIndex(credit.expiresAt);
    if (expiryIndex !== null) markers.push({ i: expiryIndex, at: credit.expiresAt, kind: 'credit-expiry', flag: `${credit.markerLabel} exp`, tip: timing });
  }
  return {
    windowKey,
    history,
    points,
    series: [
      { key: 'actual', label: 'Actual usage', cls: 's1', values: actual },
      { key: 'fast', label: 'Fast plan', cls: 's2', values: fastValues },
      { key: 'slow', label: 'Slow plan', cls: 's3', dashed: true, values: slowValues },
    ],
    ranges: [{ lowerValues: fastValues, upperValues: slowValues }],
    markers,
    windows,
    credits,
    now: new Date(now).toISOString(),
    horizon: new Date(horizon).toISOString(),
  };
}

const quotaPoints = (value) => Number(value.toFixed(1));

// Format a time as weekday, day, month and browser local time, for example "Sun 4 Oct 03:00".
function quotaLocalTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
}

// One note for the Codex quota plan card: the plan mode, the distance from the planned curve, and the projection at the recent burn.
export function quotaPlanStandingHtml(data) {
  const difference = data?.guidance?.difference;
  if (!Number.isFinite(difference) || !Number.isFinite(data?.usedPercent) || !Number.isFinite(data?.plannedUsageNow)) return '';
  const points = quotaPoints(Math.abs(difference));
  const deviation = points === 0 ? 'on plan' : `${difference > 0 ? 'ahead of plan' : 'behind plan'} by ${points} points`;
  const [label, rule] = data.planMode === 'burst' ? ['Burst mode', 'the curve is advice only.'] : ['Paced mode', 'the curve holds the lane when use is ahead of it.'];
  const parts = [`${quotaPoints(data.usedPercent)}% used, ${quotaPoints(data.plannedUsageNow)}% planned, ${deviation}.`];
  const projection = data.projection;
  if (projection && Number.isFinite(projection.ratePerHour) && Number.isFinite(projection.targetPercent)) {
    const burn = `Recent burn ${quotaPoints(projection.ratePerHour)} points per hour;`;
    const reach = projection.status === 'reached' ? `already at or above ${projection.targetPercent} percent.`
      : !quotaLocalTime(projection.at) ? ''
        : projection.status === 'after-reset' ? `at this rate: ${projection.targetPercent} percent not before the window reset.`
          : `at this rate: ${projection.targetPercent} percent about ${quotaLocalTime(projection.at)}.`;
    if (reach) parts.push(`${burn} ${reach}`);
  }
  return `<p class="viz-note"><b>${label}</b>: ${rule} ${esc(parts.join(' '))}</p>`;
}

export function quotaPlanDetailsHtml(view) {
  const windows = Array.isArray(view?.windows) ? view.windows : [];
  const credits = Array.isArray(view?.credits) ? view.credits : [];
  const windowTable = windows.length
    ? `<h4>Quota windows</h4>${communicationTable(['Scenario', 'Window', 'Start', 'End', 'Next reset', 'Reason'], windows.map((row) => [row.scenario, row.index, row.startAt, row.endAt, row.resetsAt, row.reason || '–']))}`
    : '<div class="calm-state">No planned quota windows.</div>';
  const creditTable = credits.length
    ? `<h4>Reset credits</h4>${communicationTable(['Credit', 'Fast apply', 'Slow apply', 'Expiry'], credits.map((row) => [row.id, row.fastApplyAt || 'Not planned', row.slowApplyAt || 'Not planned', row.expiresAt || 'Unknown']))}`
    : '<div class="calm-state">No reset credits are available.</div>';
  return `${windowTable}${creditTable}`;
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

// Lane wait and hold by hour. The filter uses one project or all projects.
export function lockLaneHourSeries(hourly, project = 'all') {
  const hours = Array.isArray(hourly?.hours) ? hourly.hours : [];
  const list = Array.isArray(hourly?.projects) ? hourly.projects : [];
  const chosen = project !== 'all' && list.some((row) => row.project === project) ? project : 'all';
  const rows = chosen === 'all' ? list : list.filter((row) => row.project === chosen);
  const values = (key, lane) => hours.map((_, i) => rows.reduce((sum, row) => {
    const value = row[key]?.[lane]?.[i];
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0));
  return {
    hours, project: chosen, projects: list.map((row) => row.project),
    series: [
      { key: 'waitLong', label: 'Long lane wait', cls: 's1', values: values('waitByLane', 'long') },
      { key: 'holdLong', label: 'Long lane hold', cls: 's2', values: values('holdByLane', 'long') },
      { key: 'waitShort', label: 'Short lane wait', cls: 's3', values: values('waitByLane', 'short') },
      { key: 'holdShort', label: 'Short lane hold', cls: 's4', values: values('holdByLane', 'short') },
    ],
  };
}

// The table behind the hourly lane chart.
export function lockLaneHourDetailsHtml(win) {
  const cell = (label, value, mono = true) => `<td data-label="${esc(label)}"${mono ? ' class="mono"' : ''}>${value}</td>`;
  const values = Object.fromEntries((win?.series || []).map((series) => [series.key, series.values]));
  const rows = (win?.hours || []).map((at, i) => `<tr>${cell('Hour', esc(hourLabel(at, true)), false)}${cell('Long lane wait', minutes(values.waitLong?.[i] ?? 0))}${cell('Long lane hold', minutes(values.holdLong?.[i] ?? 0))}${cell('Short lane wait', minutes(values.waitShort?.[i] ?? 0))}${cell('Short lane hold', minutes(values.holdShort?.[i] ?? 0))}</tr>`).join('');
  return `<h3>By lane and hour</h3><div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Hour</th><th>Long wait</th><th>Long hold</th><th>Short wait</th><th>Short hold</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No hourly lock data.</td></tr>'}</tbody></table></div>`;
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

// ---------- Memory by class ----------

export const MEMORY_LABEL = { claude: 'Claude', codex: 'Codex', browsers: 'Browsers', mcp: 'MCP servers', vitest: 'Vitest', other: 'Other' };
const HOUR_MS = 3600000;

// A bucket start as a short label '14:00'. The long form 'Mon 30 Mar 14:00' goes into a tooltip.
export function hourLabel(at, long = false) {
  const d = new Date(Date.parse(at));
  if (Number.isNaN(d.getTime())) return '–';
  const time = `${String(d.getHours()).padStart(2, '0')}:00`;
  if (!long) return time;
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]} ${time}`;
}

// Megabytes as '6.0 GB' above 1024 and '500 MB' below it.
export function mbText(value) {
  if (!Number.isFinite(value)) return '–';
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
}

// One bar for each hour of the last 24 hours, one series for each process class. Each bar is the mean of the samples
// of that hour. The 5 named classes keep a color slot; the rest share the neutral one. A bucket with no sample has no
// bar. Data without points has no series.
export function memorySeries(memory) {
  const points = Array.isArray(memory?.points) ? memory.points.filter((p) => p.samples) : [];
  const classes = Array.isArray(memory?.classes) && memory.classes.length ? memory.classes : Object.keys(MEMORY_LABEL);
  if (!points.length) return { points: [], classes, series: [], windowMean: {}, peak: memory?.peak || {}, latest: memory?.latest || null, bucketMin: memory?.bucketMin || 60, fmt: mbText };
  const named = classes.map((key) => ({ key, label: MEMORY_LABEL[key] || key, values: points.map((p) => (Number.isFinite(p.mb?.[key]) ? p.mb[key] : 0)) }));
  const series = foldSeries(named);
  // The legend holds the mean of the bars of the window. A sum of means would add one hour to another.
  const windowMean = Object.fromEntries(named.map((s) => [s.key, Math.round(s.values.reduce((a, b) => a + b, 0) / s.values.length)]));
  return {
    points,
    classes,
    series,
    windowMean,
    peak: memory?.peak || {},
    latest: memory?.latest || null,
    bucketMin: memory?.bucketMin || 60,
    fmt: mbText,
  };
}

// The table behind Details: one row for each class with its latest sample and its peak in the window.
export function memoryDetailsHtml(win) {
  if (!win?.points?.length) return '<p class="viz-note">No memory samples in the last 24 hours.</p>';
  const cell = (label, value) => `<td data-label="${esc(label)}" class="mono">${value}</td>`;
  const rows = win.classes.map((key) => `<tr>${cell('Class', esc(MEMORY_LABEL[key] || key))}${cell('Latest', mbText(win.latest?.mb?.[key]))}${cell('Peak 24 h', mbText(win.peak?.[key]))}</tr>`).join('');
  return `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Class</th><th>Latest</th><th>Peak 24 h</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- Free disk space ----------

export const DISK_FREE_TITLE = 'Lowest free disk space in each 15 minutes, last 24 hours';

// A time with the minutes, short '14:15' or long 'Mon 30 Mar 14:15'.
function diskClock(at, long = false) {
  const d = new Date(Date.parse(at));
  if (Number.isNaN(d.getTime())) return '–';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return long ? `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]} ${time}` : time;
}

// A GB value with one decimal place.
export const gbText = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} GB` : '–');

// The lowest free GB in each 15-minute bucket of the last 24 hours, from /api/machine-hours.
// floorValues draws the worktrees.minFreeGb line as a second, dashed series.
export function diskFreeSeries(machineHours) {
  const raw = Array.isArray(machineHours?.disk?.points) ? machineHours.disk.points : [];
  const points = raw
    .filter((p) => Number.isFinite(Date.parse(p?.at)) && Number.isFinite(p?.gb))
    .map((p) => ({ at: p.at, gb: +(+p.gb).toFixed(1) }));
  const configured = Number.isFinite(machineHours?.minFreeGb) ? machineHours.minFreeGb : 8;
  const floor = configured > 0 ? configured : 8;
  const minRaw = machineHours?.disk?.min;
  const min = minRaw && Number.isFinite(Date.parse(minRaw.at)) && Number.isFinite(minRaw.gb)
    ? { at: minRaw.at, gb: +(+minRaw.gb).toFixed(1) } : null;
  const values = points.map((p) => p.gb);
  return {
    points,
    values,
    floor,
    floorValues: points.map(() => floor),
    min,
    yMax: niceMax(Math.max(floor, ...values, 1) * 1.1),
    tips: points.map((p) => `${diskClock(p.at, true)} · ${gbText(p.gb)} free`),
  };
}

// The Machine section card for the disk line: the point list, the floor line, and the window minimum.
export function diskFreeCard(machineHours) {
  const win = diskFreeSeries(machineHours);
  const base = { id: 'disk-free', title: DISK_FREE_TITLE, sub: 'The lower free space of the worktree volume and the data-directory volume, in each 15-minute bucket. Local time.' };
  if (!win.points.length) return { ...base, empty: 'No disk samples yet.' };
  const series = [
    { key: 'free', label: 'Free disk space', cls: 's1', values: win.values },
    { key: 'floor', label: `Floor (${win.floor} GB)`, cls: 's-ink', values: win.floorValues, dashed: true },
  ];
  const chart = lineChart({ points: win.points, series, yMax: win.yMax, fmt: (v) => `${Math.round(v)} GB`, label: DISK_FREE_TITLE, tips: win.tips });
  return {
    ...base,
    legend: legendHtml(series),
    chart,
    footer: win.min ? `<p class="viz-note">Lowest free disk space ${gbText(win.min.gb)} at ${diskClock(win.min.at, true)}.</p>` : '',
  };
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


// The machine snapshot keeps its scope when the project filter narrows predictions.
export function lockAdmissionHtml(admission, project = 'all') {
  if (!admission) return '';
  const use = Number.isInteger(admission.slotsInUse) ? `${admission.slotsInUse} of ${admission.slotLimit} slots in use` : `Slot use unknown; capacity ${admission.slotLimit}`;
  const scope = admission.sampledAt ? `Machine sample at ${admission.sampledAt}. Use is unknown after 3 minutes.` : 'No machine sample is available.';
  const rows = (admission.predictions || []).filter((row) => project === 'all' || row.project === project)
    .map((row) => `<tr><td data-label="Project">${esc(row.project)}</td><td data-label="Kind">${esc(row.kind)}</td><td data-label="Lane">${esc(row.lane)}</td><td data-label="Predicted hold">${row.predictedMs === null ? 'Unknown' : esc(minutes(row.predictedMs))}</td></tr>`).join('');
  return `<div class="lock-admission"><p><b>${esc(use)}</b> for the machine-wide full-suite lock. Capacity is the saved policy. ${esc(scope)}</p>`
    + '<p>Predicted hold: median of the last 10 releases for each project, kind, and lock in 14 days. Fewer than 3 qualifying releases means unknown.</p>'
    + (rows ? `<div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th>Project</th><th>Kind</th><th>Lane</th><th>Predicted hold</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No prediction history is recorded.</p>') + '</div>';
}
