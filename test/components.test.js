import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const docs = fs.readFileSync(new URL('../docs/reference/dashboard-shell.md', import.meta.url), 'utf8');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

test('Overview uses the shared row and status chip for project records', async () => {
  const { listRowHtml, statusChipHtml } = await import('../public/components.js');
  const row = listRowHtml([
    { label: 'Project', render: (escape) => `<a href="${escape('/projects/example')}"><strong>${escape('Example')}</strong></a><small>${escape('SampleWorkspace')}</small>` },
    { label: 'Project lead', render: () => statusChipHtml({ state: 'running', label: 'Codex · running' }, escapeHtml) },
    { label: 'Workers', className: 'mono', text: '1 / 2' },
  ], escapeHtml);

  assert.equal(row, '<tr><td data-label="Project"><a href="/projects/example"><strong>Example</strong></a><small>SampleWorkspace</small></td><td data-label="Project lead"><span class="status-inline"><span class="st running"></span>Codex · running</span></td><td class="mono" data-label="Workers">1 / 2</td></tr>');
  assert.match(app, /listRowHtml\(/);
  assert.match(app, /statusChipHtml\(/);
});

test('the shared row and chip escape hostile labels and states', async () => {
  const { listRowHtml, statusChipHtml } = await import('../public/components.js');
  const row = listRowHtml([
    { label: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>' },
  ], escapeHtml);
  const chip = statusChipHtml({ state: '" onclick="alert(1)', label: '<svg onload=alert(1)>' }, escapeHtml);

  assert.equal(row, '<tr><td data-label="&lt;img src=x onerror=alert(1)&gt;">&lt;script&gt;alert(1)&lt;/script&gt;</td></tr>');
  assert.equal(chip, '<span class="status-inline"><span class="st &quot; onclick=&quot;alert(1)"></span>&lt;svg onload=alert(1)&gt;</span>');
  assert.doesNotMatch(`${row}${chip}`, /<script|<img|<svg/);
});

test('Overview project rows keep a native focusable link as the keyboard action', () => {
  const start = app.indexOf('function fleetBlock(');
  const end = app.indexOf('\nfunction decisionSummary(', start);
  const block = app.slice(start, end);

  assert.match(block, /listRowHtml\(/);
  assert.match(block, /href="\$\{escapeText\(detail\)\}"/);
  assert.doesNotMatch(block, /<tr[^>]*(?:role="button"|tabindex=)/);
  assert.match(css, /a:focus-visible[^}]*outline: var\(--focus-width\)/);
});

test('the token sheet defines light and dark color, spacing, type, border, and focus tokens', () => {
  const tokens = fs.readFileSync(new URL('../public/theme.css', import.meta.url), 'utf8');

  assert.match(index, /href="\/tokens\.css"/);
  assert.match(tokens, /:root\s*\{/);
  assert.match(tokens, /:root\[data-theme="dark"\]/);
  for (const name of ['--bg', '--space-', '--type-', '--border-width', '--focus-color']) {
    assert.ok(tokens.includes(name), `token sheet includes ${name}`);
  }
});

test('dashboard shell docs name the shared component module and token sheet', () => {
  assert.match(docs, /public\/components\.js/);
  assert.match(docs, /public\/tokens\.css/);
});
