// The Analytics page: chart figures, SVG charts, the activity log filter, and the page contract in public/app.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  stackedBars, lineChart, heatGrid, outcomeBars, stripBars, foldSeries, niceMax, spendSeries, claudeSpend, quotaSeries,
  denialGrid, firstTimeRate, activityFilter, activityChoices, eventLevel, dayLabel, usd,
  DENIAL_RANGES, DEFAULT_DENIAL_RANGE, denialRange, denialSeries, denialMarkers, denialDetailsHtml, denialLegendHtml,
  lockWaitSeries, lockWaitDetailsHtml, memorySeries, memoryDetailsHtml, hourLabel,
} from '../public/analytics.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const guide = fs.readFileSync(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
const cli = fs.readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');

const spend = {
  days: [
    { day: '2026-09-29', roles: [{ role: 'worker', costUsd: 10, harnesses: { claude: { costUsd: 6 }, codex: { costUsd: 4 } } }, { role: 'boss', costUsd: 2, harnesses: { claude: { costUsd: 2 } } }] },
    { day: '2026-09-28', roles: [{ role: 'worker', costUsd: 5, harnesses: { claude: { costUsd: 5 } } }] },
  ],
};

test('spendSeries puts the days oldest first and splits by role or by harness', () => {
  const byRole = spendSeries(spend, 'role');
  assert.deepEqual(byRole.days, ['2026-09-28', '2026-09-29']);
  assert.deepEqual(byRole.series.map((s) => [s.label, s.values]), [['Boss', [0, 2]], ['Workers', [5, 10]]]);
  // A role keeps its color slot when another role has no spend.
  assert.deepEqual(byRole.series.map((s) => s.cls), ['s1', 's3']);
  const byHarness = spendSeries(spend, 'harness');
  assert.deepEqual(byHarness.series.map((s) => [s.label, s.values]), [['Claude', [5, 8]], ['Codex', [0, 4]]]);
  const claude = claudeSpend(spend);
  assert.equal(claude.mean, 6.5);
  assert.equal(claude.roleMean.worker, 5.5);
});

test('stackedBars draws one hit column with a tooltip for each day, and an axis with round ticks', () => {
  const { days, series } = spendSeries(spend, 'role');
  const svg = stackedBars({ cats: days.map((d) => ({ label: dayLabel(d), tip: dayLabel(d, true) })), series, fmt: usd, label: 'Spend' });
  assert.equal((svg.match(/class="viz-hit"/g) || []).length, 2);
  assert.match(svg, /data-tip="Tue 29 Sep\nBoss: \$2.00\nWorkers: \$10.00\nTotal: \$12.00"/);
  assert.match(svg, />\$12.00</);
  assert.match(svg, /role="img" aria-label="Spend"/);
  assert.match(svg, /tabindex="0"/);
  assert.equal(niceMax(12), 12);
  assert.equal(niceMax(56), 60);
  assert.equal(niceMax(0), 1);
});

test('foldSeries keeps five slots and folds the rest into Other', () => {
  const series = Array.from({ length: 7 }, (_, i) => ({ label: `p${i}`, values: [i, 1] }));
  const folded = foldSeries(series);
  assert.equal(folded.length, 6);
  assert.deepEqual(folded.at(-1), { key: 'other', label: 'Other', cls: 's-other', values: [11, 2] });
});

test('quotaSeries gives a used line and a dashed pace line per provider in hourly columns', () => {
  const trend = { claude: [
    { at: '2026-09-30T10:05:00Z', usedPercent: 40, expectedPercent: 35 },
    { at: '2026-09-30T10:35:00Z', usedPercent: 42, expectedPercent: 36 },
    { at: '2026-09-30T12:05:00Z', usedPercent: 50, expectedPercent: 40 },
  ] };
  const q = quotaSeries(trend, (p) => p.toUpperCase());
  assert.equal(q.cols.length, 2);
  assert.deepEqual(q.series.map((s) => [s.label, s.values, !!s.dashed]), [['CLAUDE used', [42, 50], false], ['CLAUDE pace', [36, 40], true]]);
  assert.equal(q.series[0].lastUsed, 50);
  assert.equal(q.series[0].lastPace, 40);
  const svg = lineChart({ points: q.cols, series: q.series, tips: ['a', 'b'] });
  assert.match(svg, /class="viz-line s1 dashed"/);
  assert.equal((svg.match(/class="viz-hit"/g) || []).length, 2);
});

test('lineChart leaves a gap at a missing value and shades a held column', () => {
  const svg = lineChart({ points: [1, 2, 3, 4], series: [{ cls: 's1', values: [10, null, 30, 40] }], bands: [{ i: 2, alpha: 1 }] });
  const d = /d="([^"]+)"/.exec(svg)[1];
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.match(svg, /class="viz-band"/);
  assert.match(stripBars({ values: [0, 3], max: 3, tips: ['', 'x'] }), /class="viz-fill s-wait"/);
});

test('denialGrid sums the causes for a harness and sorts them by total', () => {
  const denials = { days: ['d1', 'd2'], rows: [
    { harness: 'claude', cause: 'sandbox', project: 'secret-client', counts: [1, 2] },
    { harness: 'claude', cause: 'classifier', project: 'x', counts: [4, 0] },
    { harness: 'codex', cause: 'sandbox', project: 'x', counts: [0, 5] },
  ] };
  assert.deepEqual(denialGrid(denials).causes.map((c) => [c.cause, c.counts]), [['sandbox', [1, 7]], ['classifier', [4, 0]]]);
  assert.deepEqual(denialGrid(denials, 'codex').causes.map((c) => c.cause), ['sandbox']);
  const grid = denialGrid(denials);
  const svg = heatGrid({ rows: grid.causes.map((c) => c.cause), cols: grid.days, values: grid.causes.map((c) => c.counts) });
  assert.doesNotMatch(svg, /secret-client/);
  assert.match(svg, /class="viz-heat q5"/);
});

test('the scorecard chart and the first-time rate count judged runs only', () => {
  const rows = [{ kind: 'claude', model: 'm1', runs: 10, firstTime: 6, rework: 2, failed: 1 }, { kind: 'pi', model: 'm2', runs: 4, firstTime: 1, rework: 0, failed: 0 }];
  assert.deepEqual(firstTimeRate(rows), { rate: 0.7, judged: 10, runs: 14 });
  assert.equal(firstTimeRate([]), null);
  const svg = outcomeBars({ rows: [{ label: 'm1', parts: [{ cls: 'o-first', value: 6 }, { cls: 'o-rework', value: 2 }, { cls: 'o-failed', value: 0 }], right: '10 runs', tip: 't' }] });
  assert.equal((svg.match(/class="viz-fill/g) || []).length, 2);
});

test('activityFilter filters by kind, project, level, time range, and search, newest first', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const events = [
    { at: '2026-09-30T11:30:00Z', type: 'notify', severity: 'warn', text: 'Quota near pace', pane: 'w1:p1' },
    { at: '2026-09-30T11:50:00Z', type: 'error', text: 'Read failed', project: 'orchard' },
    { at: '2026-09-29T08:00:00Z', type: 'handoff', text: 'Prepared', project: 'lantern' },
  ];
  assert.deepEqual(activityFilter(events, {}, now).map((e) => e.type), ['error', 'notify', 'handoff']);
  assert.deepEqual(activityFilter(events, { kind: 'notify' }, now).map((e) => e.type), ['notify']);
  assert.deepEqual(activityFilter(events, { project: 'lantern' }, now).map((e) => e.type), ['handoff']);
  assert.deepEqual(activityFilter(events, { level: 'error' }, now).map((e) => e.type), ['error']);
  assert.deepEqual(activityFilter(events, { range: '1h' }, now).map((e) => e.type), ['error', 'notify']);
  assert.deepEqual(activityFilter(events, { q: 'W1:P1' }, now).map((e) => e.type), ['notify']);
  assert.equal(eventLevel(events[0]), 'warn');
  assert.deepEqual(activityChoices(events), { kinds: ['error', 'handoff', 'notify'], projects: ['lantern', 'orchard'] });
});

test('the Analytics page leads with questions and charts, each with a Details table', () => {
  const start = app.indexOf('function analyticsView(');
  const view = app.slice(start, app.indexOf('\n}\n', start));
  for (const block of ['analyticsHeadline', 'spendChart', 'quotaChart', 'scorecardChart', 'denialsBlock', 'timelineChart', 'machineHoursBlock', 'noticeChart', 'activitySection']) assert.match(view, new RegExp(`${block}\\(`), block);
  assert.match(app, /function vizCard\(/);
  assert.match(app, /<details class="viz-details" data-viz-detail=/);
  assert.match(app, /<summary>Details<\/summary>/);
  assert.match(app, /'\/api\/spend\?days=14', '\/api\/analytics', '\/api\/machine-hours'\]\.map/);
  assert.match(app, /API-price equivalent/);
  // The page keeps its DOM on refresh, so a chart keeps its sideways scroll and the search keeps its focus.
  assert.match(app, /const KEYED_ROUTES = \[[^\]]*'analytics'/);
});

test('the activity log moves to Analytics and old Logs links keep working', () => {
  const nav = /<nav id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] || '';
  assert.doesNotMatch(nav, /data-nav="logs"/);
  assert.doesNotMatch(app, /\['\/logs', 'Logs'\]/);
  assert.match(app, /location\.pathname === '\/logs'/);
  assert.match(app, /'\/analytics#activity'/);
  assert.doesNotMatch(app, /href="\/logs/);
  assert.match(app, /<select data-activity-filter="\$\{field\}">/);
  for (const field of ['kind', 'project', 'level', 'range']) assert.match(app, new RegExp(`select\\('${field}', `), field);
  assert.match(app, /data-activity-filter="q"/);
  assert.match(app, /analytics: \['Analytics'[\s\S]*Activity log/);
  assert.doesNotMatch(app, /\n  logs: \['Logs'/);
  assert.match(guide, /## Analytics page/);
});

test('one series color set for light and dark', () => {
  for (const hex of ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']) assert.match(css, new RegExp(hex, 'i'));
  assert.match(css, /\.viz-scroll \{[^}]*overflow-x: auto/);
});

test('each chart has one tab stop: the first hit area has tabindex 0, the others -1, and the wait strip has none', () => {
  const bars = stackedBars({ cats: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], series: [{ label: 'x', cls: 's1', values: [1, 2, 3] }] });
  assert.equal((bars.match(/tabindex="0"/g) || []).length, 1);
  assert.equal((bars.match(/tabindex="-1"/g) || []).length, 2);
  const line = lineChart({ points: [1, 2, 3], series: [{ cls: 's1', values: [1, 2, 3] }], tips: ['', 'b', 'c'] });
  assert.equal((line.match(/tabindex="0"/g) || []).length, 1);
  const heat = heatGrid({ rows: ['r1', 'r2'], cols: ['c1', 'c2'], values: [[1, 2], [3, 4]] });
  assert.equal((heat.match(/tabindex="0"/g) || []).length, 1);
  const rows = outcomeBars({ rows: [{ label: 'a', parts: [], tip: 'a' }, { label: 'b', parts: [], tip: 'b' }] });
  assert.equal((rows.match(/tabindex="0"/g) || []).length, 1);
  const strip = stripBars({ values: [1, 2], max: 2, tips: ['a', 'b'] });
  assert.doesNotMatch(strip, /tabindex/);
  // A refresh keeps the roving stop where the arrow keys moved it.
  assert.match(bars, /data-keep-attrs="tabindex"/);
});

test('the arrow keys move the chart focus, and a refresh shows the tooltip of the focused hit again', () => {
  assert.match(app, /function moveVizFocus\(/);
  assert.match(app, /ArrowRight|ArrowLeft/);
  assert.match(app, /'Home'/);
  assert.match(app, /if \(document\.activeElement\?\.classList\?\.contains\('viz-hit'\)\) showVizTip\(document\.activeElement\);/);
});

test('phone controls on Analytics are 16 px text and 44 px high, and the activity tools wrap', () => {
  const phone = css.slice(css.lastIndexOf('@media (max-width: 760px) {'));
  assert.match(phone, /:root \.viz-switch button \{[^}]*height: 44px;[^}]*font-size: 16px/);
  assert.match(phone, /\.activity-tools \.kb-search input, \.activity-tools \.kb-field select \{[^}]*height: 44px/);
  assert.match(css, /\.activity-tools \{[^}]*flex-wrap: wrap/);
});

// ---------- Denials per day with harness change markers ----------

const DAYS = Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`);
const daily = {
  days: DAYS,
  harnesses: {
    all: { refused: DAYS.map((_, i) => (i === 29 ? 2 : 0)), approved: DAYS.map((_, i) => (i === 29 ? 5 : i === 0 ? 40 : 0)), unclassified: DAYS.map((_, i) => (i === 28 ? 1 : 0)) },
    codex: { refused: DAYS.map(() => 1), approved: DAYS.map(() => 2), unclassified: DAYS.map(() => 0) },
  },
};
const changes = [{ date: '2026-03-29', harness: 'codex', label: 'Rule added' }, { date: '2026-02-01', harness: 'pi', label: 'Before the window' }];

test('the denial range is 3 days by default, with 7 and 30 as options', () => {
  assert.deepEqual(DENIAL_RANGES, [3, 7, 30]);
  assert.equal(DEFAULT_DENIAL_RANGE, 3);
  assert.equal(denialRange(undefined), 3);
  assert.equal(denialRange('7'), 7);
  assert.equal(denialRange(30), 30);
  assert.equal(denialRange('5'), 3);
  assert.equal(denialRange('junk'), 3);
  assert.match(app, /denialRange: DEFAULT_DENIAL_RANGE|denialRange: loadDenialRange\(\)/);
});

test('the chosen range is remembered in localStorage inside try/catch', () => {
  assert.match(app, /const DENIAL_RANGE_KEY = 'herdr-boss\.denialRange'/);
  assert.match(app, /try \{[^}]*localStorage\.getItem\(DENIAL_RANGE_KEY\)[^}]*\} catch/);
  assert.match(app, /try \{ localStorage\.setItem\(DENIAL_RANGE_KEY[^}]*\} catch/);
  assert.match(app, /data-denial-range/);
  assert.match(app, /vizSwitch\('denial-range'/);
});

test('denialSeries cuts the last 3, 7, or 30 days and splits refused from approved', () => {
  for (const range of [3, 7, 30]) {
    const w = denialSeries(daily, { range });
    assert.equal(w.days.length, range);
    assert.equal(w.days.at(-1), '2026-03-30');
    assert.deepEqual(w.series.map((s) => s.key), ['refused', 'approved']);
    assert.equal(w.series[0].values.length, range);
  }
  const three = denialSeries(daily, { range: 3 });
  assert.deepEqual(three.series[0].values, [0, 0, 2]);
  assert.deepEqual(three.series[1].values, [0, 0, 5]);
  assert.equal(three.totals.refused, 2);
  assert.equal(three.totals.approved, 5);
  assert.equal(three.unclassified, 1);
  assert.equal(denialSeries(daily, { range: 30 }).totals.approved, 45);
  assert.equal(denialSeries(daily, { range: 7, harness: 'codex' }).totals.refused, 7);
});

test('denialSeries gives a lighter series for approved and the main series for refused', () => {
  const w = denialSeries(daily, { range: 3 });
  assert.match(w.series[0].cls, /^s\d$/);
  assert.match(w.series[1].cls, /^s\d lighter$/);
  assert.equal(w.series[0].cls, w.series[1].cls.split(' ')[0]);
  assert.match(w.series[0].label, /refused|blocked/i);
  assert.match(w.series[1].label, /approved/i);
});

test('denialSeries is empty and safe for missing data, an unknown harness, or a bad range', () => {
  for (const bad of [null, undefined, {}, { days: [] }]) {
    const w = denialSeries(bad, { range: 3 });
    assert.equal(w.days.length, 0);
    assert.equal(w.totals.refused, 0);
  }
  const w = denialSeries(daily, { range: 99, harness: 'nope' });
  assert.equal(w.days.length, 3);
  assert.equal(w.totals.refused + w.totals.approved, 0);
});

test('denialMarkers keeps the markers inside the window and of the chosen harness', () => {
  const w = denialSeries(daily, { range: 3 });
  const m = denialMarkers(changes, w.days, 'all');
  assert.equal(m.length, 1);
  assert.equal(m[0].i, 1);
  assert.equal(m[0].harness, 'codex');
  assert.match(m[0].tip, /Sun 29 Mar|Sat 29 Mar|Mon 29 Mar|Wed 29 Mar|\w{3} 29 Mar/);
  assert.match(m[0].tip, /Codex/);
  assert.match(m[0].tip, /Rule added/);
  assert.equal(denialMarkers(changes, w.days, 'codex').length, 1);
  assert.equal(denialMarkers(changes, w.days, 'pi').length, 0);
  assert.equal(denialMarkers(changes, denialSeries(daily, { range: 30 }).days, 'all').length, 1);
  assert.deepEqual(denialMarkers(null, w.days, 'all'), []);
});

test('stackedBars draws a marker as a thin line with a flag and one hit area in the roving tab order', () => {
  const w = denialSeries(daily, { range: 7 });
  const markers = denialMarkers(changes, w.days, 'all');
  const svg = stackedBars({ cats: w.days.map((d) => ({ label: dayLabel(d), tip: dayLabel(d, true) })), series: w.series, markers, label: 'Denials' });
  assert.equal((svg.match(/class="viz-marker"/g) || []).length, 1);
  assert.match(svg, /class="viz-flag"/);
  assert.match(svg, /class="viz-flag-text"[^>]*>Codex</);
  const hit = /<rect[^>]*class="viz-hit viz-marker-hit"[^>]*>/.exec(svg)?.[0] || '';
  assert.match(hit, /data-tip="[^"]*Codex[^"]*Rule added/);
  assert.match(hit, /tabindex="-1"/);
  assert.match(hit, /data-keep-attrs="tabindex"/);
  assert.equal((svg.match(/tabindex="0"/g) || []).length, 1);
  assert.equal((svg.match(/tabindex="-1"/g) || []).length, 7);
  // The tooltip of the day column names the marker too.
  assert.match(svg, /data-tip="[^"]*Refused[^"]*"/i);
  assert.match(svg, /data-tip="[^"]*Marker: Codex/);
});

test('stackedBars without a marker is unchanged: no marker line and no flag', () => {
  const svg = stackedBars({ cats: [{ label: 'a' }, { label: 'b' }], series: [{ label: 'x', cls: 's1', values: [1, 2] }] });
  assert.doesNotMatch(svg, /viz-marker|viz-flag/);
});

test('a flag label that would overlap the one before it is left out, and the hit area keeps the text in its tooltip', () => {
  const w = denialSeries(daily, { range: 30 });
  const many = [
    { date: '2026-03-28', harness: 'codex', label: 'First fix' },
    { date: '2026-03-29', harness: 'claude', label: 'Second fix' },
    { date: '2026-03-30', harness: 'opencode', label: 'Third fix' },
  ];
  const svg = stackedBars({ cats: w.days.map((d) => ({ label: dayLabel(d) })), series: w.series, markers: denialMarkers(many, w.days, 'all') });
  assert.equal((svg.match(/class="viz-marker"/g) || []).length, 3);
  assert.ok((svg.match(/class="viz-flag-text"/g) || []).length < 3);
  assert.equal((svg.match(/viz-marker-hit/g) || []).length, 3);
  assert.match(svg, /Third fix/);
});

test('the denial details table has one row for each day with both series and a total', () => {
  const w = denialSeries(daily, { range: 3 });
  const html = denialDetailsHtml({ win: w, markers: denialMarkers(changes, w.days, 'all') });
  const head = /<thead>(.*?)<\/thead>/s.exec(html)[1];
  for (const text of ['Date', 'Refused', 'Approved', 'Total']) assert.match(head, new RegExp(text));
  const rows = (html.match(/<tr><td data-label="Date"/g) || []).length;
  assert.equal(rows, 3 + 1);
  assert.match(html, /<td data-label="Refused" class="mono">2<\/td>/);
  assert.match(html, /<td data-label="Approved" class="mono">5<\/td>/);
  assert.match(html, /<td data-label="Total" class="mono">7<\/td>/);
});

test('the denial details table lists the markers and says that unclassified events count as refused', () => {
  const w = denialSeries(daily, { range: 3 });
  const html = denialDetailsHtml({ win: w, markers: denialMarkers(changes, w.days, 'all') });
  assert.match(html, /<th>Harness<\/th>/);
  assert.match(html, /Rule added/);
  assert.match(html, /Codex/);
  assert.match(html, /1 event has no known outcome and counts as refused/);
  const none = denialDetailsHtml({ win: denialSeries(daily, { range: 7, harness: 'codex' }), markers: [] });
  assert.match(none, /No harness changes are recorded in this window/);
  assert.doesNotMatch(none, /no known outcome/);
});

test('the denial details table escapes the label of a marker', () => {
  const w = denialSeries(daily, { range: 3 });
  const html = denialDetailsHtml({ win: w, markers: [{ i: 1, date: '2026-03-29', harness: 'codex', label: '<img src=x onerror=alert(1)>', tip: '' }] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('the Analytics page draws the denials as stacked bars per day from the aggregate', () => {
  const start = app.indexOf('function denialsBlock(');
  const block = app.slice(start, app.indexOf('\n}\n', start));
  assert.match(block, /denialSeries\(/);
  assert.match(block, /denialMarkers\(/);
  assert.match(block, /stackedBars\(/);
  assert.match(block, /denialDetailsHtml\(/);
  assert.doesNotMatch(block, /heatGrid\(/);
  assert.match(app, /function denialScrollToEnd\(/);
  assert.match(app, /if \(route === 'analytics'\) denialScrollToEnd\(\);/);
  assert.match(css, /\.viz-fill\.lighter/);
  assert.match(css, /\.viz-key\.lighter/);
  assert.match(css, /\.viz-marker \{/);
  assert.match(css, /\.viz-flag/);
});

test('the Analytics help and the guide describe the denial chart, the range, the markers, and the file', () => {
  const help = app.slice(app.indexOf("  analytics: ['Analytics'"));
  assert.match(help, /harness-changes\.jsonl/);
  assert.match(help, /3 days/);
  assert.match(help, /approved/i);
  assert.match(guide, /harness-changes\.jsonl/);
  assert.match(guide, /harness change/);
  const cli = fs.readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');
  assert.match(cli, /harness change <harness> <label> \[--date YYYY-MM-DD\]/);
  assert.match(cli, /harness-changes\.jsonl/);
});

test('the legend names the total of each series for the range', () => {
  const w = denialSeries(daily, { range: 30 });
  const html = denialLegendHtml(w, '');
  assert.match(html, /Blocked or refused 2/);
  assert.match(html, /Escalation approved by a rule 45/);
  assert.match(denialLegendHtml({ ...w, totals: { refused: 254, approved: 3357 } }, ''), /Escalation approved by a rule 3,357/);
  assert.match(denialLegendHtml(w, '<li>Extra</li>'), /<li>Extra<\/li>/);
});

test('the approved series is outlined and lighter than the refused series in both themes, and the text says outlined', () => {
  const rule = /\.viz-fill\.lighter \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(rule, /fill: color-mix\(in srgb, var\(--c\) \d+%, #fff\)/);
  assert.match(rule, /stroke: var\(--c\)/);
  assert.match(css, /\.viz-key\.lighter \{[^}]*color-mix\(in srgb, var\(--c\) \d+%, #fff\)/);
  const start = app.indexOf('function denialsBlock(');
  const block = app.slice(start, app.indexOf('\n}\n', start));
  assert.match(block, /outlined part/);
  assert.doesNotMatch(block, /light part/);
  assert.match(block, /denialLegendHtml\(/);
  const help = app.slice(app.indexOf("  analytics: ['Analytics'"));
  assert.match(help, /outlined part/);
  assert.doesNotMatch(help, /The light part/);
  assert.doesNotMatch(guide, /\(light, same color\)/);
});

// ---------- Policy changes (PC2) ----------

test('the policy changes list shows time, caller kind, and changed keys with escaping', async () => {
  const { policyChangesTitle, policyChangesListHtml, policyChangesDetailsHtml, policyWhen, POLICY_LIST_ENTRIES } = await import('../public/analytics.js');
  const at = new Date(2026, 8, 30, 18, 25).toISOString();
  const entries = [
    { at, caller: 'page', changes: [{ key: 'projects.herdrboss.share', old: 20, new: 9 }, { key: 'allowedKinds', old: 'changed', new: 'changed' }, { key: 'note', old: null, new: '<img src=x onerror=1>' }] },
    { at, caller: '<b>odd</b>', changes: Array.from({ length: 9 }, (_, i) => ({ key: `projects.p${i}.share`, old: 1, new: 2 })) },
  ];
  assert.equal(policyWhen(at), 'Wed 30 Sep 18:25');
  assert.equal(policyWhen('nope'), '–');
  assert.equal(policyChangesTitle(entries), 'Last policy write: Page, 3 keys changed, Wed 30 Sep 18:25');
  assert.equal(policyChangesTitle([]), 'Policy changes');
  const list = policyChangesListHtml(entries);
  assert.match(list, /<code>projects\.herdrboss\.share<\/code> <span class="policy-old">20<\/span> → <span class="policy-new">9<\/span>/);
  assert.match(list, /<span class="policy-old">none<\/span> → <span class="policy-new">&lt;img src=x onerror=1&gt;<\/span>/);
  assert.match(list, /policy-caller page">Page</);
  assert.match(list, /policy-caller &lt;b&gt;odd&lt;\/b&gt;">Unknown</);
  assert.ok(!list.includes(`<${'img'}`) && !list.includes(`<${'b'}>odd`), 'untrusted values stay escaped');
  assert.match(list, /and 3 more in Details/);
  const details = policyChangesDetailsHtml(entries);
  assert.equal((details.match(/<tr>/g) || []).length, 1 + 3 + 9, 'a row for each changed key, and the header row');
  assert.match(details, /data-label="Key" class="mono">projects\.herdrboss\.share</);
  assert.doesNotMatch(details, /<img/);
  const many = Array.from({ length: POLICY_LIST_ENTRIES + 5 }, () => entries[0]);
  assert.equal((policyChangesListHtml(many).match(/class="policy-change"/g) || []).length, POLICY_LIST_ENTRIES);
});

test('the Analytics page has the Policy changes section with an empty state, help, and 44 px rows on the phone', () => {
  assert.match(app, /function policyChangesCard\(\)/);
  assert.match(app, /policyChangesCard\(\),\n\s*activitySection\(s\)/);
  assert.match(app, /No policy write is recorded yet\./);
  assert.match(app, /analyticsData\?\.policyChanges/);
  assert.match(app, /<h3>Policy changes<\/h3><p>The list shows the last writes of <code>policy\.json<\/code>/);
  assert.match(css, /\.policy-change \{[^}]*min-height: 44px/);
  const phone = css.slice(css.lastIndexOf('@media (max-width: 760px) {', css.indexOf('.hl-strip { grid-template-columns: repeat(2')));
  assert.match(phone, /\.policy-change \{[^}]*min-height: 44px/);
  assert.match(guide, /^### Policy changes$/m);
  assert.match(guide, /\*\*Policy changes\*\*: a list of the last writes/);
});

const DAY = 86400000;
const lockData = {
  days: ['2026-09-28', '2026-09-29', '2026-09-30'],
  projects: [
    { project: 'alpha', wait: [0, 60000, 120000], hold: [0, 300000, 600000], runs: [0, 1, 2], timeouts: [0, 0, 1], waitTotal: 180000, holdTotal: 900000 },
    { project: 'beta', wait: [0, 0, 60000], hold: [0, 0, 60000], runs: [0, 0, 1], timeouts: [0, 0, 0], waitTotal: 60000, holdTotal: 60000 },
  ],
  totals: { wait: [0, 60000, 180000], hold: [0, 300000, 660000] },
};

test('lockWaitSeries gives wait and hold for all projects or for one, and ignores an unknown project', () => {
  const all = lockWaitSeries(lockData, 'all');
  assert.deepEqual(all.days, lockData.days);
  assert.deepEqual(all.series.map((x) => [x.key, x.values]), [['hold', [0, 300000, 660000]], ['wait', [0, 60000, 180000]]]);
  assert.deepEqual(all.totals, { wait: 240000, hold: 960000, runs: 4, timeouts: 1 });
  const one = lockWaitSeries(lockData, 'beta');
  assert.deepEqual(one.series.find((x) => x.key === 'wait').values, [0, 0, 60000]);
  assert.equal(lockWaitSeries(lockData, 'nope').project, 'all');
  assert.deepEqual(lockWaitSeries(null, 'all').days, []);
  assert.deepEqual(all.projects, ['alpha', 'beta']);
});

test('lockWaitSeries stacked bars keep the roving tab order and name wait and hold in the tooltip', () => {
  const win = lockWaitSeries(lockData, 'all');
  const svg = stackedBars({ cats: win.days.map((d) => ({ label: dayLabel(d), tip: dayLabel(d, true) })), series: win.series, fmt: (v) => `${Math.round(v / 60000)} min`, label: 'x' });
  assert.match(svg, /tabindex="0"/);
  assert.match(svg, /Wait: 3 min/);
  assert.match(svg, /Hold: 11 min/);
});

test('lockWaitDetailsHtml lists each day and each project with its wait, hold, runs, and timeouts', () => {
  const html = lockWaitDetailsHtml(lockWaitSeries(lockData, 'all'), lockData);
  assert.match(html, /2026-09-30/);
  assert.match(html, /alpha/);
  assert.match(html, /<th>Timeouts<\/th>/);
  assert.match(html, /11 min/);
  assert.doesNotMatch(lockWaitDetailsHtml(lockWaitSeries(lockData, 'beta'), lockData), /alpha/);
});

test('the page has the lock wait card, its switch, its help text, and its guide entry', () => {
  assert.match(app, /function lockWaitBlock\(/);
  assert.match(app, /data-lock-project/);
  assert.match(app, /waitByLane/);
  assert.match(app, /medianWaitMsByLane/);
  assert.match(app, /Short lane median wait/);
  assert.match(app, /<h3>Lock wait and hold<\/h3>/);
  assert.match(guide, /\*\*Lock wait and hold by project\*\*/);
  assert.ok(DAY > 0);
});

test('lock lane help and docs describe current admission, display, and analytics behavior', () => {
  const helpSection = (name) => {
    const start = app.indexOf(`  ${name}: [`);
    const next = app.slice(start + 3).search(/\n  [A-Za-z][\w]*: \[/);
    const end = next < 0 ? -1 : start + 3 + next;
    return app.slice(start, end < 0 ? undefined : end);
  };
  assert.match(helpSection('agents'), /<h3>Locks<\/h3>[\s\S]*?long lane[\s\S]*?short lane/i);
  assert.match(helpSection('settings'), /<h3>Locks<\/h3>[\s\S]*?short job limit[\s\S]*?guard/i);
  assert.match(helpSection('allocation'), /<h3>Locks<\/h3>[\s\S]*?long lane[\s\S]*?short lane/i);
  assert.match(helpSection('analytics'), /<h3>Lock wait and hold<\/h3>[\s\S]*?lane[\s\S]*?median wait/i);
  assert.match(guide, /The \*\*Locks\*\* panel on the Agents and Allocation pages[\s\S]*?long lane[\s\S]*?short lane/i);
  assert.match(guide, /Lock wait and hold by project[^\n]*median wait[^\n]*lane/i);
  assert.match(cli, /`lock list`[^\n]*lane[^\n]*predicted duration/i);
  assert.doesNotMatch(cli, /There is no load threshold\./);
  assert.doesNotMatch(guide, /There is no load threshold\./);
});


// ---------- Memory by class ----------

const MEM_NOW = Date.parse('2026-03-30T14:00:00.000Z');
const hourAgo = (n) => new Date(MEM_NOW - n * 3600000).toISOString();
const mem = () => ({ hours: 24, bucketMin: 60, classes: ['claude', 'codex', 'browsers', 'mcp', 'vitest', 'other'],
  points: [
    { at: hourAgo(2), samples: 1, mb: { claude: 6000, codex: 1000, browsers: 4000, mcp: 0, vitest: 0, other: 500 }, total: 11500 },
    { at: hourAgo(1), samples: 12, mb: { claude: 9000, codex: 1000, browsers: 4000, mcp: 500, vitest: 0, other: 500 }, total: 15000 },
  ],
  peak: { claude: 9000, codex: 1000, browsers: 4000, mcp: 500, vitest: 0, other: 500 },
  latest: { at: hourAgo(1), mb: { claude: 750, codex: 250, browsers: 500, mcp: 50, vitest: 0, other: 50 }, total: 1600 } });

test('memorySeries stacks one bar for each hour with a series for every class and a total in the tooltip', () => {
  const win = memorySeries(mem());
  assert.deepEqual(win.classes, ['claude', 'codex', 'browsers', 'mcp', 'vitest', 'other']);
  assert.deepEqual(win.series.map((s) => s.label), ['Claude', 'Codex', 'Browsers', 'MCP servers', 'Vitest', 'Other']);
  // Five named classes keep a color slot; the rest share the neutral one.
  assert.deepEqual(win.series.map((s) => s.cls), ['s1', 's2', 's3', 's4', 's5', 's-other']);
  assert.equal(win.points.length, 2);
  assert.deepEqual(win.series.map((s) => s.values), [[6000, 9000], [1000, 1000], [4000, 4000], [0, 500], [0, 0], [500, 500]]);
  assert.deepEqual(win.totals, { claude: 15000, codex: 2000, browsers: 8000, mcp: 500, vitest: 0, other: 1000 });
  const svg = stackedBars({ cats: win.points.map((p) => ({ label: hourLabel(p.at), tip: hourLabel(p.at, true) })), series: win.series, fmt: win.fmt, label: 'Memory' });
  assert.match(svg, /Claude: 5\.9 GB/);
  assert.match(svg, /Total: 11\.2 GB/);
  assert.match(svg, /Other: 500 MB/);
  assert.equal((svg.match(/class="viz-hit"/g) || []).length, 2);
  assert.equal((svg.match(/tabindex="0"/g) || []).length, 1);
});

test('memorySeries names every class, and reads a missing or empty block as no samples', () => {
  assert.deepEqual(memorySeries(null).series, []);
  assert.deepEqual(memorySeries(null).points, []);
  assert.equal(memorySeries({ points: [] }).points.length, 0);
  assert.equal(memorySeries(mem()).latest.total, 1600);
  // One sample in a bucket shows that bucket once, not 12 times over.
  assert.equal(memorySeries({ ...mem, points: [{ at: hourAgo(1), samples: 1, mb: { claude: 1000 }, total: 1000 }] }).series[0].values[0], 1000);
});

test('memoryDetailsHtml lists each class with its latest sample and its 24-hour peak in MB and GB', () => {
  const html = memoryDetailsHtml(memorySeries(mem()));
  assert.match(html, /<th>Latest<\/th>/);
  assert.match(html, /<th>Peak 24 h<\/th>/);
  for (const label of ['Claude', 'Codex', 'Browsers', 'MCP servers', 'Vitest', 'Other']) assert.match(html, new RegExp(`>${label}<`), label);
  assert.match(html, /8\.8 GB/, 'the peak of Claude');
  assert.match(html, /750 MB/, 'the latest sample of Claude');
  assert.match(html, /500 MB/);
  assert.doesNotMatch(memoryDetailsHtml(memorySeries(null)), /<tr>/);
});

test('the page draws Memory by class from the analytics aggregate, with the classes, the peak, and the empty state', () => {
  const start = app.indexOf('function memoryBlock(');
  const view = app.slice(start, app.indexOf('\n}\n', start));
  assert.ok(start > 0, 'memoryBlock exists');
  for (const part of ['analyticsData?.memoryByClass', 'memorySeries', 'stackedBars', 'memoryDetailsHtml', 'legendHtml']) assert.match(view, new RegExp(part.replace('?', '\\?')), part);
  assert.match(view, /Memory by class/);
  assert.match(view, /No memory samples in the last 24 hours/);
  assert.match(view, /peak/i);
  assert.match(app, /analyticsData = results\[9\]\.value/);
  const startAnalytics = app.indexOf('function analyticsView(');
  assert.match(app.slice(startAnalytics, app.indexOf('\n}\n', startAnalytics)), /memoryBlock\(/);
});

test('the Analytics help and the guide describe the memory chart, the classes, the sample, and the file', () => {
  assert.match(app, /<h3>Memory by class<\/h3>/);
  assert.match(app, /memory-samples\.jsonl/);
  assert.match(app, /every 5 minutes/);
  assert.match(app, /<p>The page answers eight questions/);
  for (const cls of ['Claude', 'Codex', 'Browsers', 'MCP servers', 'Vitest']) assert.match(app, new RegExp(cls), cls);
  assert.match(guide, /## Memory by class/);
  assert.match(guide, /memory-samples\.jsonl/);
  assert.match(guide, /5 minutes/);
  assert.match(guide, /resident memory/i);
  const section = guide.slice(guide.indexOf('## Memory by class'), guide.indexOf('## Memory by class') + 2500);
  assert.match(section, /A line holds no command line/);
  assert.doesNotMatch(section, /\/Users\/|\/private\/|\/var\/folders|node --test| -o pid/);
});

test('the memory chart states the bucket size and the samples behind the latest figure', () => {
  const start = app.indexOf('function memoryBlock(');
  const view = app.slice(start, app.indexOf('\n}\n', start));
  assert.match(view, /columns of \$\{m\.bucketMin\} minutes/);
  assert.match(view, /sample/i);
  assert.match(view, /No command/i);
});

test('LK3 R6 the actual Analytics card renders slot use, predictions, and their scopes', async () => {
  const helpers = await import('../public/analytics.js');
  const admission = { slotLimit: 3, slotsInUse: 2, sampledAt: '2026-10-01T12:00:00.000Z', predictions: [
    { project: 'alpha', kind: 'suite', name: 'full-suite', lane: 'short', predictedMs: 120000, samples: 3 },
    { project: 'beta', kind: 'push', name: 'full-suite', lane: 'long', predictedMs: null, samples: 1 },
  ] };
  const start = app.indexOf('function lockWaitBlock()');
  const body = app.slice(start, app.indexOf('\n}\n', start) + 2);
  const render = (project, projects = lockData.projects) => vm.runInNewContext(`${body}; lockWaitBlock()`, {
    ...helpers, analyticsData: { locks: { ...lockData, projects, admission } }, analyticsUi: { lockProject: project },
    vizCard: (value) => value, vizSwitch: () => '', esc: (s) => String(s),
  });
  for (const projects of [lockData.projects, []]) {
    const card = render('all', projects);
    assert.match(card.chart, /2 of 3 slots/);
    assert.match(card.chart, /alpha/);
    assert.match(card.chart, /suite/);
    assert.match(card.chart, /2 min/);
    assert.match(card.chart, /beta/);
    assert.match(card.chart, /unknown/i);
    assert.match(card.chart, /machine sample/i);
    assert.match(card.chart, /14 days/);
    assert.match(card.chart, /last 10/);
  }
  const selected = render('alpha');
  assert.match(selected.chart, /alpha/);
  assert.doesNotMatch(selected.chart, /beta/);
  assert.match(selected.chart, /2 of 3 slots/, 'machine use keeps its machine scope under a project filter');
});

test('LK3 second review docs describe degraded reloads, legacy ticket expiry, selected re-entry, and effective capacity', () => {
  const plan = fs.readFileSync(new URL('../docs/ideas/lock-lanes.md', import.meta.url), 'utf8');
  for (const document of [cli, guide, plan]) {
    assert.match(document, /last validated settings/);
    assert.match(document, /younger than 30 minutes/);
    assert.match(document, /waiting CLI process/);
    assert.match(document, /re-entry release is a no-op[^\n]*slot selector/);
    assert.match(document, /effective admission capacity[^\n]*saved capacity/);
  }
  assert.match(app, /last validated settings/);
  assert.match(app, /younger than 30 minutes/);
  assert.match(app, /re-entry release is a no-op/);
});

test('the actual Memory by class card renders one bar for each hour with the classes, the totals, and an empty state', async () => {
  const helpers = await import('../public/analytics.js');
  const start = app.indexOf('function memoryBlock()');
  const body = app.slice(start, app.indexOf('\n}\n', start) + 2);
  const run = (memory) => vm.runInNewContext(`${body}; memoryBlock()`, {
    ...helpers,
    analyticsData: { memoryByClass: memory },
    analyticsUi: { open: new Set() },
    vizCard: (value) => value,
    esc: (s) => String(s ?? ''),
    legendHtml: helpers.legendHtml,
    Date,
    Math,
    Object,
  });
  const card = run(mem());
  assert.match(card.title, /Memory of processes peaked at/);
  assert.match(card.title, /the latest sample holds/);
  assert.match(card.sub, /columns of 60 minutes/);
  assert.match(card.sub, /No command line is recorded/);
  for (const cls of ['Claude', 'Codex', 'Browsers', 'MCP servers', 'Vitest', 'Other']) assert.match(card.legend, new RegExp(cls), cls);
  assert.match(card.legend, /Claude 14\.6 GB/, 'the legend gives the total of each series');
  assert.equal((card.chart.match(/class="viz-hit"/g) || []).length, 2);
  assert.match(card.chart, /role="img" aria-label="Memory of processes/);
  assert.match(card.details, /<th>Peak 24 h<\/th>/);
  assert.match(card.details, /750 MB/);
  const empty = run({ points: [], classes: mem().classes, peak: {}, latest: null, bucketMin: 60, hours: 24 });
  assert.match(empty.empty, /No memory samples in the last 24 hours/);
  assert.ok(!empty.chart, 'an empty window draws no chart');
  const none = run(undefined);
  assert.match(none.empty, /No memory samples in the last 24 hours/);
});
