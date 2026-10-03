import test from 'node:test';
import { readUserGuide } from './helpers/user-guide.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-agent-chat-view-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.HOME = path.join(root, 'home');
process.env.HERDR_BOSS_DIR = dataDir;
fs.mkdirSync(process.env.HOME, { recursive: true });

const view = await import('../public/agent-chat.js');
const store = await import('../src/agent-messages.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const guide = readUserGuide();
const cli = fs.readFileSync(new URL('../docs/cli.md', import.meta.url), 'utf8');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const deps = { esc, markdown: (text) => `<p>${esc(text)}</p>`, clock: () => '10:00', time: () => '10:00' };

const orch = { role: 'orch', project: 'alpha', name: null, pane: 'wA:p1' };
const worker = { role: 'worker', project: 'alpha', name: 'build', pane: 'wA:p2' };
const boss = { role: 'boss', project: null, name: null, pane: 'wB:p1' };
const otherOrch = { role: 'orch', project: 'beta', name: null, pane: 'wC:p1' };

// An invented store in a temporary data folder.
function fixture() {
  const dir = fs.mkdtempSync(path.join(dataDir, 'store-'));
  store.recordAgentMessage({ from: orch, to: worker, text: 'Build the **parser**.', kind: 'task' }, { dir, now: 1000 });
  store.recordAgentMessage({ from: worker, to: orch, text: 'Parser done.', kind: 'reply', status: 'failed' }, { dir, now: 2000 });
  store.recordAgentMessage({ from: boss, to: otherOrch, text: 'Status request', kind: 'nudge', status: 'delivered' }, { dir, now: 3000 });
  return dir;
}

test('a pair row shows both agent labels, the count, and the time, and no unread badge', () => {
  const dir = fixture();
  const directory = view.buildDirectory(store.readAgentMessages({ dir }));
  const [pair] = store.listAgentPairs({ dir, project: 'alpha' });
  const html = view.agentPairRowHtml(pair, { ...deps, directory });
  assert.match(html, /Orchestrator alpha/);
  assert.match(html, /Worker build \(alpha\)/);
  assert.match(html, /2 messages/);
  assert.match(html, /data-agent-open="orch:alpha\+worker:build"/);
  assert.doesNotMatch(html, /unread/);
});

test('the pairs list newest activity first and the project filter uses the route', () => {
  const dir = fixture();
  const pairs = store.listAgentPairs({ dir });
  assert.deepEqual(pairs.map((pair) => pair.pairKey), ['boss+orch:beta', 'orch:alpha+worker:build']);
  assert.deepEqual(store.listAgentPairs({ dir, project: 'beta' }).map((pair) => pair.pairKey), ['boss+orch:beta']);
  const directory = view.buildDirectory(store.readAgentMessages({ dir }));
  assert.deepEqual(view.projectOptions(pairs, directory), ['alpha', 'beta']);
});

test('a pair key without a directory entry still gives role and name labels', () => {
  assert.equal(view.pairTitle('orch:alpha+worker:build', null), 'Orchestrator alpha and Worker build');
  assert.equal(view.pairTitle('boss+orch:beta', new Map()), 'Boss and Orchestrator beta');
});

test('a message shows the failed and recorded badges, the kind, and the rendered Markdown', () => {
  const dir = fixture();
  const [failed, recorded] = store.readAgentMessages({ dir, pair: 'orch:alpha+worker:build' });
  const failedHtml = view.agentBubbleHtml(failed, { ...deps, firstEnd: 'orch:alpha' });
  assert.match(failedHtml, /agent-status">failed</);
  assert.match(failedHtml, /agent-kind">reply</);
  assert.match(failedHtml, /from-owner/, 'the second end of the pair sits on the right');
  const recordedHtml = view.agentBubbleHtml(recorded, { ...deps, firstEnd: 'orch:alpha' });
  assert.match(recordedHtml, /agent-status">recorded</);
  assert.match(recordedHtml, /from-agent/);
  assert.match(recordedHtml, /Build the \*\*parser\*\*/, 'the caller renders the Markdown');
  const delivered = view.agentBubbleHtml({ ...recorded, status: 'delivered' }, deps);
  assert.doesNotMatch(delivered, /agent-status/);
});

test('a message escapes its text through the caller', () => {
  const html = view.agentBubbleHtml({ id: 'm1', from: orch, to: worker, text: '<img src=x onerror=alert(1)>', createdAt: '2026-10-01T10:00:00Z', agentKind: 'task', status: 'delivered' }, { ...deps, markdown: (text) => esc(text) });
  assert.doesNotMatch(html, /<img/);
});

test('the conversation shows the newest message at the bottom and an older page goes above', () => {
  const dir = fixture();
  const newest = store.readAgentMessages({ dir, pair: 'orch:alpha+worker:build', limit: 1 });
  const page = view.conversationOrder(newest);
  assert.deepEqual(page.map((record) => record.text), ['Parser done.']);
  const older = store.readAgentMessages({ dir, pair: 'orch:alpha+worker:build', limit: 5, before: newest[0].id });
  const merged = view.mergeOlder(page, older);
  assert.deepEqual(merged.map((record) => record.text), ['Build the **parser**.', 'Parser done.']);
  assert.deepEqual(view.mergeOlder(merged, older).map((record) => record.id), merged.map((record) => record.id));
});

test('the queries leave out empty values and the search keeps the pairs with a match', () => {
  assert.equal(view.agentQuery({}), '');
  assert.equal(view.agentQuery({ project: 'alpha', pair: 'boss+orch:alpha', q: ' parser ', before: 'm-1', limit: 50 }), '?project=alpha&pair=boss%2Borch%3Aalpha&q=parser&before=m-1&limit=50');
  assert.equal(view.agentsUrl({ project: 'alpha' }), '/chat?tab=agents&project=alpha');
  const dir = fixture();
  const pairs = store.listAgentPairs({ dir });
  assert.equal(view.filterPairs(pairs, null).length, 2);
  const matching = store.readAgentMessages({ dir, q: 'parser' });
  assert.deepEqual(view.filterPairs(pairs, matching).map((pair) => pair.pairKey), ['orch:alpha+worker:build']);
  assert.deepEqual(view.filterPairs(pairs, []), []);
});

test('an empty conversation shows a plain line', () => {
  assert.match(view.agentMessagesHtml([], { ...deps, emptyText: 'No agent messages.' }), /No agent messages\./);
});

test('the Chat page has an Agents tab and the project page has a collapsed Messages section', () => {
  assert.match(app, /from '\.\/agent-chat\.js'/);
  assert.match(app, /tab\('owner', 'Owner'/);
  assert.match(app, /tab\('agents', 'Agents'/);
  assert.match(app, /\/api\/agent-pairs/);
  assert.match(app, /\/api\/agent-messages/);
  assert.match(app, /key: 'agent-messages'[^\n]*title: 'Messages'/);
  assert.match(app, /Load older/);
  assert.match(app, /data-agent-back/);
  assert.match(app, /data-agent-q/);
  assert.match(app, /data-agent-project/);
});

test('the Agents tab shows no unread badge and sends nothing', () => {
  const start = app.indexOf('// ---------- Agent messages ----------');
  const end = app.indexOf('// ---------- End agent messages ----------');
  assert.ok(start > 0 && end > start);
  const block = app.slice(start, end).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(block, /chat-unread|\bunread\b/);
  assert.doesNotMatch(block, /method: 'POST'|method: 'DELETE'|method: 'PUT'/);
});

test('the phone layout has two steps with a Back button', () => {
  assert.match(css, /\.agent-layout\.thread-open \.chat-list-pane/);
  assert.match(css, /\.agent-layout:not\(\.thread-open\) \.chat-conversation-pane/);
});

test('the help text and the guide describe both pages and the retention', () => {
  const help = app.slice(app.indexOf('const HELP = {'));
  assert.match(help, /Agents tab/);
  assert.match(help, /14 days/);
  assert.match(help, /180 days/);
  assert.match(guide, /### Agents tab/);
  assert.match(guide, /### Messages section/);
  assert.match(guide, /14 days/);
  assert.match(guide, /180 days/);
  assert.match(cli, /agentMessages\.retentionDays/);
});
