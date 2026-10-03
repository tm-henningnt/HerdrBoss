import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHtml, chooserHtml, guideHtml, stepHtml, commandHtml, termsHtml, testPanelHtml, answersHtml, checkRowHtml, commandCodeHtml } from '../public/host-guide-view.js';
import { createHostGuide, failureMessage, SAVE_DELAY_MS, NETWORK_MESSAGE } from '../public/host-guide.js';
import { STEPS, HOST_TYPES } from '../public/host-guide-data.js';

const FINGERPRINT = `SHA256:${'C'.repeat(43)}`;
const values = { label: 'build-box', user: 'factory', distro: 'Ubuntu', tailnetName: 'build-box.example-tailnet.ts.net', keyName: 'build-box-key', tailscaleAccount: 'owner@example.com', memoryGb: '48', cpuCount: '16', fingerprint: FINGERPRINT };
const guide = (extra = {}) => ({ label: 'build-box', type: 'windows-wsl2', values: { ...values }, done: {}, checks: {}, terminate: null, reboot: null, ...extra });
const CHECKS = [{ id: 'registered', title: 'Host in the registry' }, { id: 'answers', title: 'Host answers on the tailnet name' }, { id: 'key-login', title: 'Key login works' }, { id: 'architecture', title: 'Architecture is x86_64', types: ['windows-wsl2'] }, { id: 'docker', title: 'Docker answers over the context' }, { id: 'systemd', title: 'systemd state' }, { id: 'docker-memory', title: 'Docker memory limit' }, { id: 'sshd-password', title: 'SSH password login is off' }, { id: 'terminate', title: 'Terminate and wait', types: ['windows-wsl2'] }, { id: 'reboot', title: 'Reboot test' }];
const model = (extra = {}) => ({ screen: 'guide', guide: guide(), hosts: [], checks: CHECKS, local: false, message: '', answers: false, busy: '', ...extra });

test('the chooser offers Windows with WSL2 first, then Linux, then Mac with OrbStack, and the label field', () => {
  const html = chooserHtml({ list: [], draft: { type: 'windows-wsl2', label: '' } });
  const order = ['Windows with WSL2', 'Linux', 'Mac with OrbStack'].map((name) => html.indexOf(name));
  assert.ok(order.every((at) => at > 0) && order[0] < order[1] && order[1] < order[2]);
  assert.match(html, /value="windows-wsl2" data-hg-type checked/);
  assert.match(html, /data-hg-start-label/);
  assert.match(html, /\b25 steps\b/);
  assert.equal((html.match(/data-hg-type/g) || []).length, 3);
});

test('the chooser lists saved guides with their progress and a Continue button', () => {
  const html = chooserHtml({ list: [{ label: 'build-box', type: 'linux', done: 3, total: 18 }], draft: {} });
  assert.match(html, /build-box<\/strong> · Linux · 3 of 18 steps done/);
  assert.match(html, /data-hg-open="build-box"/);
});

test('an invalid label shows its message while the user types', () => {
  const html = chooserHtml({ list: [], draft: { type: 'linux', label: 'Bad Label' } });
  assert.match(html, /data-state="bad"/);
  assert.match(html, /lower case letters, digits, or hyphens/);
});

test('each Windows step shows what, why, commands with a copy button, the expected result, a done checkbox, and three errors', () => {
  const html = guideHtml(model());
  assert.equal((html.match(/class="hg-step"/g) || []).length, 25);
  for (const [index, step] of STEPS['windows-wsl2'].entries()) {
    const start = html.indexOf(`id="step-${index + 1}"`);
    const end = html.indexOf(`id="step-${index + 2}"`);
    const block = html.slice(start, end === -1 ? undefined : end);
    assert.ok(block.includes(`<h3>${step.name}</h3>`) || block.includes(`<h3>${step.name.replace(/&/g, '&amp;')}</h3>`), step.id);
    assert.match(block, /hg-what/);
    assert.match(block, /<strong>Why:<\/strong>/);
    assert.match(block, /What you should see:/);
    assert.match(block, new RegExp(`data-hg-done="${step.id}"`));
    assert.equal((block.match(/class="hg-fix"/g) || []).length, 3, `${step.id} errors`);
    assert.match(block, /<summary>Something went wrong<\/summary>/);
    const commands = (step.commands || []).filter((command) => !command.types || command.types.includes('windows-wsl2')).length;
    assert.equal((block.match(/data-hg-cmd /g) || []).length, commands + (step.terminateTest ? 1 : 0) + (step.id === 'answers' ? 0 : 0), `${step.id} commands`);
    assert.ok((block.match(/data-copy-text=/g) || []).length >= commands, `${step.id} copy buttons`);
  }
});

test('a command shows the typed values and copies the same text', () => {
  const html = commandHtml(STEPS['windows-wsl2'].find((step) => step.id === 'boot-task').commands[0], values);
  assert.match(html, /-d Ubuntu -u root --exec \/bin\/sh -lc &quot;systemctl start docker ssh tailscaled &amp;&amp; exec \/usr\/bin\/sleep infinity&quot;/);
  assert.match(html, /data-copy-text="-d Ubuntu -u root --exec \/bin\/sh -lc &quot;systemctl start docker ssh tailscaled &amp;&amp; exec \/usr\/bin\/sleep infinity&quot;"/);
  assert.match(html, /data-template="-d &lt;DISTRO&gt; -u root/);
  assert.match(html, /<p class="hg-ph-note" hidden>/);
});

test('a placeholder without a value is marked, and the note asks for the value', () => {
  const html = commandHtml({ shell: 'mac', text: 'ping -c 1 <HOST_FQDN>' }, {});
  assert.match(html, /<mark class="hg-ph">&lt;HOST_FQDN&gt;<\/mark>/);
  assert.doesNotMatch(html, /hg-ph-note" hidden/);
  assert.equal(commandCodeHtml('x <NOT_A_FIELD>', {}), 'x &lt;NOT_A_FIELD&gt;');
});

test('a value with HTML never reaches the page as HTML', () => {
  const hostile = { label: 'build-box', user: '<img src=x onerror=alert(1)>' };
  const html = guideHtml(model({ guide: guide({ values: hostile }) }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-state="bad"/);
});

test('a warning stands before the commands in each hard step', () => {
  const html = guideHtml(model());
  for (const id of ['never-sleep', 'access-policy', 'ubuntu-tailscale', 'ssh-key', 'ssh-server', 'boot-task', 'reboot-test', 'docker-repository', 'install-docker']) {
    const at = html.indexOf(`data-step="${id}"`);
    const block = html.slice(at, html.indexOf('</li>', at));
    const warning = block.indexOf('class="hg-warning"');
    const command = block.indexOf('data-hg-cmd');
    assert.ok(warning > 0, `${id} has a warning`);
    assert.ok(command === -1 || warning < command, `${id}: the warning comes first`);
  }
});

test('the Docker safety warning names the commands that a shared daemon must not get', () => {
  const html = guideHtml(model());
  const at = html.indexOf('data-step="docker-repository"');
  assert.match(html.slice(at, at + 3000), /docker system prune.*docker volume rm/s);
});

test('H1 to H15 are visible and link to their steps', () => {
  const html = guideHtml(model());
  for (let n = 1; n <= 15; n += 1) assert.match(html, new RegExp(`<li id="h${n}"><strong>H${n}</strong>`));
  assert.match(html, /<a href="#step-8">Step 8: Limit memory and CPU<\/a>/);
  assert.match(html, /<a class="hg-h" href="#h1" title="Host check H1">H1<\/a>/);
});

test('the glossary tooltips mark the first use of WSL, systemd, Tailscale, SSH key, and Docker context in a step', () => {
  const html = termsHtml('WSL and WSL. Use systemd with Tailscale and an SSH key. Make a Docker context. `WSL` stays code.');
  assert.equal((html.match(/class="hg-term"/g) || []).length, 5);
  for (const term of ['WSL', 'systemd', 'Tailscale', 'SSH key', 'Docker context']) assert.match(html, new RegExp(`class="hg-term" tabindex="0">${term}<span class="hg-tip" role="tooltip">`));
  assert.match(html, /<code>WSL<\/code>/);
  assert.equal((guideHtml(model()).match(/hg-tip/g) || []).length > 5, true);
});

test('a step is blocked until the steps before it are done, and the page offers the next step', () => {
  const none = guideHtml(model());
  assert.match(none, /data-hg-done="bios"(?![^>]*disabled)/);
  assert.match(none, /data-hg-done="update-windows"[^>]*disabled/);
  const one = guideHtml(model({ guide: guide({ done: { bios: true } }) }));
  assert.match(one, /data-hg-done="bios" checked/);
  assert.match(one, /data-hg-done="update-windows"(?![^>]*disabled)/);
  assert.match(one, /data-hg-done="never-sleep"[^>]*disabled/);
  assert.match(one, /1 of 25 steps done/);
});

test('the preview shows the text and the commands and disables saving and testing', () => {
  const html = guideHtml(model({ local: true }));
  assert.match(html, /read-only preview/);
  assert.match(html, /data-hg-run="all" disabled/);
  assert.match(html, /data-hg-done="bios" disabled/);
  assert.doesNotMatch(html, /data-hg-delete/);
  assert.match(html, /class="hg-step"/);
});

test('the test panel shows a green mark, a red mark, the failing command, the masked output, and the next step', () => {
  const checks = {
    answers: { id: 'answers', status: 'pass', output: 'The host answered on port 22.', command: 'herdr-boss factory ssh build-box -- uname -m', next: '' },
    docker: { id: 'docker', status: 'fail', output: 'error during connect: <endpoint>', command: "herdr-boss factory docker build-box -- ps --format '{{.ID}} {{.Status}}'", next: 'Run `docker --context CONTEXT ps` on the Mac.' },
    systemd: { id: 'systemd', status: 'skipped', output: 'The host does not answer.', command: '', next: '' },
  };
  const html = testPanelHtml(model({ guide: guide({ checks }), hosts: ['build-box'] }));
  assert.match(html, /data-check="answers" data-status="pass"><span class="hg-check-mark" aria-hidden="true">✓/);
  assert.match(html, /data-check="docker" data-status="fail"><span class="hg-check-mark" aria-hidden="true">✗/);
  assert.match(html, /Failing command: <code>herdr-boss factory docker build-box -- ps/);
  assert.match(html, /error during connect: &lt;endpoint&gt;/);
  assert.match(html, /<strong>Next step:<\/strong> Run <code>docker --context CONTEXT ps<\/code> on the Mac\./);
  assert.match(html, /data-check="systemd" data-status="skipped"/);
  assert.match(html, /The host is in the registry\./);
  assert.match(html, /data-hg-run="all">Test from this machine/);
  assert.doesNotMatch(html, /data-check="terminate"/);
  assert.match(testPanelHtml(model()), /factory host add build-box --from-file -/);
});

test('the terminate and reboot widgets show a warning, the command, and the state', () => {
  const idle = guideHtml(model());
  assert.match(idle, /data-hg-timed="terminate"/);
  assert.match(idle, /wsl --terminate Ubuntu/);
  assert.match(idle, /data-hg-action="terminate-start"/);
  assert.match(idle, /data-hg-action="reboot-start"/);
  const waiting = guideHtml(model({ guide: guide({ terminate: { status: 'waiting', startedAt: '2026-10-04T10:00:00Z' }, checks: { terminate: { id: 'terminate', status: 'pending', output: 'The host is down. Waiting for the repeating trigger to start it again.', next: '' } } }) }));
  assert.match(waiting, /data-hg-run="terminate"/);
  assert.match(waiting, /data-hg-action="terminate-reset"/);
  assert.match(waiting, /The host is down\. Waiting/);
});

test('the answers panel builds the registry entry and the table and posts nothing', () => {
  const closed = answersHtml(model());
  assert.match(closed, /data-hg-show-answers>Show the registry entry/);
  assert.doesNotMatch(closed, /factory host add/);
  const open = answersHtml(model({ answers: true }));
  assert.match(open, /herdr-boss factory host add build-box --from-file -/);
  assert.match(open, /&quot;address&quot;: &quot;build-box\.example-tailnet\.ts\.net&quot;/);
  assert.match(open, /&quot;runtime&quot;: &quot;docker-engine-wsl2&quot;/);
  assert.match(open, /\| Tailnet name \| build-box\.example-tailnet\.ts\.net \|/);
  assert.match(open, /This page sends nothing/);
  assert.doesNotMatch(open, /<form|fetch\(/);
  assert.match(answersHtml(model({ guide: guide({ values: { label: 'build-box' } }), answers: true })), /Missing:<\/strong> .*Tailnet name of the host/);
});

test('Linux and Mac have their own checklists with H1 to H15 and the same sections', () => {
  for (const type of HOST_TYPES.slice(1)) {
    const html = guideHtml(model({ guide: guide({ type: type.id, values: { label: 'build-box' } }) }));
    assert.equal((html.match(/class="hg-step"/g) || []).length, STEPS[type.id].length);
    assert.match(html, /<li id="h15">/);
    assert.doesNotMatch(html, /\.wslconfig|wsl --(install|terminate|shutdown)/, type.id);
    assert.match(html, /Something went wrong/);
  }
  assert.match(guideHtml(model({ guide: guide({ type: 'mac-orbstack', values: { label: 'build-box' } }) })), /orbctl config set memory_mib 4096/);
  assert.doesNotMatch(guideHtml(model({ guide: guide({ type: 'linux', values: { label: 'build-box' } }) })), /data-hg-timed="terminate"/);
});

test('pageHtml shows the loading state, the chooser, or the guide', () => {
  assert.match(pageHtml({ loading: true }), /Loading/);
  assert.match(pageHtml({ screen: 'chooser', list: [], draft: {} }), /Choose the host type/);
  assert.match(pageHtml(model()), /Add a host<\/h1>/);
  assert.equal(stepHtml(STEPS['windows-wsl2'][0], 0, model(), new Set()).startsWith('<li class="hg-step" id="step-1"'), true);
  assert.match(checkRowHtml({ id: 'x', title: 'X' }, undefined), /Not run/);
});

// The controller with a fake service.
function fakeService(options = {}) {
  const calls = [];
  const saved = new Map();
  const fetchJson = async (method, url, body) => {
    calls.push({ method, url, body });
    if (options.network) throw new Error('boom');
    if (options.preview) return { status: 403, json: { error: 'This read-only preview does not allow changes.' } };
    if (url === '/api/host-guide') return { status: 200, json: { guides: [...saved.values()].map((g) => ({ label: g.label, type: g.type, done: Object.keys(g.done).length, total: 25 })), hosts: ['build-box'], checks: CHECKS } };
    const match = /^\/api\/host-guide\/([^/]+)(?:\/(check|action))?$/.exec(url);
    const label = match[1];
    if (method === 'GET') return saved.has(label) ? { status: 200, json: { state: saved.get(label), progress: {} } } : { status: 404, json: { error: 'No guide has this label.' } };
    if (method === 'DELETE') { saved.delete(label); return { status: 200, json: { ok: true } }; }
    if (options.fail?.(method, url, body)) return { status: 409, json: { error: 'Finish the step "BIOS" first.' } };
    const state = saved.get(label) || { label, type: body.type, values: { label }, done: {}, checks: {}, terminate: null, reboot: null };
    if (body.values) state.values = { ...state.values, ...body.values };
    if (body.done) for (const [id, flag] of Object.entries(body.done)) { if (flag) state.done[id] = true; else delete state.done[id]; }
    if (match[2] === 'check') state.checks = { answers: { id: 'answers', status: 'pass', output: '', command: '', next: '' } };
    if (match[2] === 'action') state.terminate = { status: 'waiting', startedAt: '2026-10-04T10:00:00Z' };
    saved.set(label, state);
    return { status: 200, json: { state, progress: {} } };
  };
  return { fetchJson, calls, saved };
}
function timers() {
  const queue = [];
  return { setTimer: (fn, ms) => { queue.push({ fn, ms }); return queue.length; }, clearTimer: (id) => { if (queue[id - 1]) queue[id - 1].fn = null; }, fire: () => { for (const item of queue.splice(0)) item.fn?.(); }, queue };
}

test('the controller loads the list, starts a guide, and saves a valid value after a pause', async () => {
  const service = fakeService();
  const t = timers();
  const changes = [];
  const c = createHostGuide({ fetchJson: service.fetchJson, ...t, onChange: (kind) => changes.push(kind) });
  await c.load();
  assert.equal(c.state.loading, false);
  assert.deepEqual(c.state.hosts, ['build-box']);
  c.selectType('windows-wsl2');
  assert.deepEqual(c.setStartLabel('Bad Label').ok, false);
  await c.start();
  assert.equal(c.state.screen, 'chooser');
  assert.match(c.state.message, /lower case/);
  c.setStartLabel('build-box');
  await c.start();
  assert.equal(c.state.screen, 'guide');
  assert.deepEqual(service.calls.at(-2), { method: 'PUT', url: '/api/host-guide/build-box', body: { type: 'windows-wsl2' } });
  assert.equal(c.setValue('memoryGb', '4').ok, true);
  assert.equal(c.setValue('memoryGb', '48').ok, true);
  assert.equal(c.setValue('cpuCount', 'x').ok, false);
  assert.equal(c.state.guide.values.cpuCount, 'x', 'an invalid value stays on the page');
  const before = service.calls.length;
  assert.equal(service.calls.length, before, 'nothing is sent before the pause');
  assert.equal(t.queue.at(-1).ms, SAVE_DELAY_MS);
  await c.flush();
  const put = service.calls.at(-1);
  assert.deepEqual(put.body, { values: { memoryGb: '48' } }, 'only the valid value is sent');
  assert.equal(service.saved.get('build-box').values.memoryGb, '48');
});

test('a fingerprint line is saved as the SHA256 part only', async () => {
  const service = fakeService();
  const c = createHostGuide({ fetchJson: service.fetchJson, ...timers() });
  await c.load();
  c.setStartLabel('build-box'); await c.start();
  c.setValue('fingerprint', `256 ${FINGERPRINT} herdr-factory-build-box (ED25519)`);
  await c.flush();
  assert.deepEqual(service.calls.at(-1).body, { values: { fingerprint: FINGERPRINT } });
  assert.equal(c.state.guide.values.fingerprint, FINGERPRINT);
});

test('a step that the service refuses shows the message and reports failure', async () => {
  const service = fakeService({ fail: (method, url, body) => body.done });
  const changes = [];
  const c = createHostGuide({ fetchJson: service.fetchJson, ...timers(), onChange: (kind) => changes.push(kind) });
  await c.load();
  c.setStartLabel('build-box'); await c.start();
  assert.equal(await c.setDone('update-windows', true), false);
  assert.equal(c.state.message, 'Finish the step "BIOS" first.');
  assert.ok(changes.includes('done-failed'));
});

test('the preview answer turns the controller local: it saves and tests nothing', async () => {
  const service = fakeService({ preview: true });
  const c = createHostGuide({ fetchJson: service.fetchJson, ...timers() });
  await c.load();
  assert.equal(c.state.local, true);
  c.selectType('linux'); c.setStartLabel('build-box');
  await c.start();
  assert.equal(c.state.screen, 'guide');
  c.setValue('user', 'factory');
  assert.equal(c.state.guide.values.user, 'factory');
  const calls = service.calls.length;
  await c.flush(); await c.run(); await c.action('terminate-start'); assert.equal(await c.setDone('linux-update', true), false);
  assert.equal(service.calls.length, calls, 'no request after the first refusal');
});

test('run and action update the guide, and the controller names the timed test that waits', async () => {
  const service = fakeService();
  const c = createHostGuide({ fetchJson: service.fetchJson, ...timers() });
  await c.load();
  c.setStartLabel('build-box'); await c.start();
  assert.equal(c.waiting(), null);
  await c.run('all');
  assert.equal(c.state.guide.checks.answers.status, 'pass');
  assert.deepEqual(service.calls.at(-1), { method: 'POST', url: '/api/host-guide/build-box/check', body: { check: 'all' } });
  assert.equal(c.state.busy, '');
  await c.action('terminate-start');
  assert.equal(c.waiting(), 'terminate');
});

test('a network error becomes one fixed sentence', async () => {
  const c = createHostGuide({ fetchJson: fakeService({ network: true }).fetchJson, ...timers() });
  await c.load();
  assert.equal(c.state.message, NETWORK_MESSAGE);
  assert.equal(failureMessage(500, 'secret detail'), 'The service reported an error.');
  assert.equal(failureMessage(403, 'The host guide needs the Owner session.'), 'The host guide needs the Owner session. Open the dashboard on the machine that runs Herdr Boss, or sign in.');
  assert.equal(failureMessage(409, 'Undo the step "X" first.'), 'Undo the step "X" first.');
});

test('the address of the wizard link opens the saved guide of that host or fills the label', async () => {
  const service = fakeService();
  service.saved.set('build-box', { label: 'build-box', type: 'linux', values: { label: 'build-box' }, done: {}, checks: {}, terminate: null, reboot: null });
  const known = createHostGuide({ fetchJson: service.fetchJson, ...timers(), search: '?host=build-box' });
  await known.load();
  assert.equal(known.state.screen, 'guide');
  const unknown = createHostGuide({ fetchJson: service.fetchJson, ...timers(), search: '?host=other-box' });
  await unknown.load();
  assert.equal(unknown.state.screen, 'chooser');
  assert.equal(unknown.state.draft.label, 'other-box');
  const bad = createHostGuide({ fetchJson: service.fetchJson, ...timers(), search: '?host=../x' });
  await bad.load();
  assert.equal(bad.state.draft.label, '');
});

test('delete removes the guide and returns to the chooser', async () => {
  const service = fakeService();
  const c = createHostGuide({ fetchJson: service.fetchJson, ...timers() });
  await c.load();
  c.setStartLabel('build-box'); await c.start();
  await c.remove();
  assert.equal(c.state.screen, 'chooser');
  assert.equal(service.saved.size, 0);
});

test('in the preview a link with a host and a type opens a guide in memory', async () => {
  const service = fakeService({ preview: true });
  const c = createHostGuide({ fetchJson: service.fetchJson, ...timers(), search: '?host=build-box&type=linux' });
  await c.load();
  assert.equal(c.state.local, true);
  assert.equal(c.state.screen, 'guide');
  assert.equal(c.state.guide.type, 'linux');
  assert.equal(c.state.guide.label, 'build-box');
  const other = createHostGuide({ fetchJson: service.fetchJson, ...timers(), search: '?host=build-box&type=amiga' });
  await other.load();
  assert.equal(other.state.screen, 'chooser');
  assert.equal(other.state.draft.type, 'windows-wsl2');
});

test('the footer lists the commands that the Owner has not checked, for the shown host type', () => {
  const mac = guideHtml(model({ guide: guide({ type: 'mac-orbstack', values: { label: 'build-box' } }) }));
  assert.match(mac, /<footer class="hg-unchecked"><p>Not yet checked by the Owner:<\/p>/);
  assert.match(mac, /<code>orbctl config set memory_mib 4096<\/code>/);
  assert.match(mac, /<code>sudo shutdown -r now<\/code>/);
  const linux = guideHtml(model({ guide: guide({ type: 'linux', values: { label: 'build-box' } }) }));
  assert.match(linux, /sudo systemctl mask sleep\.target/);
  assert.doesNotMatch(linux, /orbctl/);
  assert.match(guideHtml(model()), /Restart-Computer/);
});
