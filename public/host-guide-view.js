// The HTML of the "Add a host" page. Pure functions: no DOM use, so the Node tests import them.
// The model: { screen, list, hosts, guide: { label, type, values, done, checks, terminate, reboot }, local, message, answers }.
import { esc } from './markdown.js';
import { COPY_ICON_HTML } from './copy.js';
import { HOST_TYPES, STEPS, HOST_CHECKS, GLOSSARY } from './host-guide-data.js';
import { FIELDS, PLACEHOLDERS, checkField, fieldsFor, substitute, missingPlaceholders, missingForEntry, registryEntry, summaryTable } from './host-guide-fields.js';

export const HOST_GUIDE_PATH = '/fleet/add-host';
export const typeOf = (id) => HOST_TYPES.find((type) => type.id === id);
export const stepsOf = (id) => STEPS[id] || [];

const SHELL = { powershell: 'PowerShell as administrator', ubuntu: 'Ubuntu', mac: 'Terminal on the Mac', policy: 'Tailscale policy file', arguments: 'Task Scheduler, Add arguments' };
const shellLabel = (shell) => (shell.startsWith('file ') ? `File ${shell.slice(5)}` : SHELL[shell] || shell);
const TOKEN = /<([A-Z][A-Z_]*)>/g;
const copyButton = (text, label = 'Copy') => `<button type="button" class="copy-btn copy-inline copy-field" data-copy-text="${esc(text)}" aria-label="${esc(label)}">${COPY_ICON_HTML}</button>`;

// Text with `code` spans and a tooltip on the first use of each glossary term.
export function termsHtml(text, used = new Set()) {
  const words = GLOSSARY.map((entry) => entry.term).join('|');
  const regex = new RegExp(`\\b(${words})\\b`, 'g');
  return String(text).split(/(`[^`]+`)/).map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part).replace(regex, (term) => {
      if (used.has(term)) return term;
      used.add(term);
      const entry = GLOSSARY.find((item) => item.term === term);
      return `<span class="hg-term" tabindex="0">${term}<span class="hg-tip" role="tooltip">${esc(entry.text)}</span></span>`;
    });
  }).join('');
}

// The text of a command with the placeholders that have no value marked.
export function commandCodeHtml(template, values) {
  const text = substitute(template, values);
  let html = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (!PLACEHOLDERS[match[1]]) continue;
    html += esc(text.slice(last, match.index)) + `<mark class="hg-ph">${esc(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return html + esc(text.slice(last));
}

export function commandHtml(command, values) {
  const text = substitute(command.text, values);
  const missing = missingPlaceholders(command.text, values);
  return `<div class="hg-cmd" data-hg-cmd data-template="${esc(command.text)}"><div class="hg-cmd-head"><span class="hg-shell">${esc(shellLabel(command.shell))}</span>${copyButton(text, 'Copy command')}</div><pre><code>${commandCodeHtml(command.text, values)}</code></pre><p class="hg-ph-note"${missing.length ? '' : ' hidden'}>Type the marked values in the fields above. The command then fills itself.</p></div>`;
}

export function fieldHtml(id, values) {
  const field = FIELDS[id];
  const value = values[id] ?? '';
  const result = checkField(id, value);
  const state = value === '' ? 'empty' : result.ok ? 'ok' : 'bad';
  const numeric = ['memoryGb', 'cpuCount', 'swapGb'].includes(id);
  return `<div class="hg-field" data-hg-wrap="${id}" data-state="${state}"><label for="hg-${id}">${esc(field.name)}</label><div class="hg-input"><input id="hg-${id}" type="text" data-hg-field="${id}" value="${esc(value)}" placeholder="${esc(field.example)}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="300"${numeric ? ' inputmode="numeric"' : ''} aria-describedby="hg-${id}-msg"><span class="hg-mark" aria-hidden="true"></span></div><p class="hg-hint">${termsHtml(field.hint, new Set(GLOSSARY.map((entry) => entry.term)))}</p><p class="hg-msg" id="hg-${id}-msg" role="status" aria-live="polite">${esc(result.message)}</p></div>`;
}

const MARK = { pass: '✓', fail: '✗', skipped: '–', pending: '…' };
const STATUS_WORD = { pass: 'Passed', fail: 'Failed', skipped: 'Skipped', pending: 'Waiting' };

export function checkRowHtml(check, result) {
  const status = result?.status || 'none';
  const detail = result ? `${result.output ? `<pre class="hg-out">${esc(result.output)}</pre>` : ''}${result.status === 'fail' && result.command ? `<p class="hg-failcmd">Failing command: <code>${esc(result.command)}</code>${copyButton(result.command, 'Copy the failing command')}</p>` : ''}${result.next ? `<p class="hg-next"><strong>Next step:</strong> ${termsHtml(result.next)}</p>` : ''}` : '';
  return `<li class="hg-check" data-check="${check.id}" data-status="${status}"><span class="hg-check-mark" aria-hidden="true">${MARK[status] || '·'}</span><div><p class="hg-check-title"><strong>${esc(check.title)}</strong> <span class="hg-status">${esc(STATUS_WORD[status] || 'Not run')}</span></p>${detail}</div></li>`;
}

export function testPanelHtml(model) {
  const { guide, hosts = [], checks = [], local } = model;
  const registered = hosts.includes(guide.label);
  const rows = checks.filter((check) => (!check.types || check.types.includes(guide.type)) && (!['terminate', 'reboot'].includes(check.id) || guide.checks?.[check.id]));
  const register = registered ? '<p class="hg-note">The host is in the registry.</p>' : `<div class="hg-note"><p>The host is not in the registry yet. Run this command on the Mac. Type the fields address, user, and keyFile as JSON on the private input. End with Ctrl+D.</p>${commandHtml({ shell: 'mac', text: 'herdr-boss factory host add <HOST> --from-file -' }, guide.values)}</div>`;
  const disabled = local || model.busy ? ' disabled' : '';
  return `<section class="panel hg-panel" id="hg-tests" data-hg-tests><h2>Test from this machine</h2><p>The test runs the checks that the factory wizard runs, from this machine. It uses the registry entry and the host tool. It asks for no password.</p>${register}<p><button type="button" class="primary" data-hg-run="all"${disabled}>${model.busy === 'check' ? 'Testing…' : 'Test from this machine'}</button>${local ? ' <span class="hg-note">The preview cannot run tests.</span>' : ''}</p><ul class="hg-checks">${rows.map((check) => checkRowHtml(check, guide.checks?.[check.id])).join('')}</ul></section>`;
}


function timedHtml(kind, model) {
  const { guide, local } = model;
  const record = guide[kind];
  const disabled = local || model.busy ? ' disabled' : '';
  const result = guide.checks?.[kind];
  const line = result ? `<p class="hg-timed-result" data-status="${result.status}"><span aria-hidden="true">${MARK[result.status]}</span> ${esc(result.output)}${result.next ? ` <span class="hg-next">${esc(result.next)}</span>` : ''}</p>` : '';
  const start = kind === 'terminate'
    ? { go: 'I ran the command: start the wait', again: 'Check now', cancel: 'Cancel the test', intro: 'Stop WSL on purpose. The repeating trigger of the boot task starts it again within 5 minutes. The test shows when it did.', warning: 'This stops all WSL work on the host, also the work of other factories. Do it when no work runs.', command: { shell: 'powershell', text: 'wsl --terminate <DISTRO>' } }
    : { go: 'I am restarting the host now', again: 'Check now', cancel: 'Cancel the test', intro: 'Restart the host and do not sign in. The test checks that the host starts the services without you.', warning: 'A restart stops all work on the host. Do it with the host operator when no factory works.' };
  const when = record?.startedAt ? `<p class="hg-note">Started at ${esc(new Date(record.startedAt).toLocaleTimeString())}.</p>` : '';
  const buttons = record?.status === 'waiting'
    ? `<button type="button" data-hg-run="${kind}"${disabled}>${start.again}</button> <button type="button" class="quiet" data-hg-action="${kind}-reset"${disabled}>${start.cancel}</button>`
    : record ? `<button type="button" class="quiet" data-hg-action="${kind}-reset"${disabled}>Run the test again</button>`
      : `<button type="button" data-hg-action="${kind}-start"${disabled}>${start.go}</button>`;
  return `<div class="hg-timed" data-hg-timed="${kind}"><h3>${kind === 'terminate' ? 'Terminate and wait' : 'Restart and wait'}</h3><p>${esc(start.intro)}</p><p class="hg-warning" role="note"><strong>Warning.</strong> ${esc(start.warning)}</p>${start.command ? commandHtml(start.command, guide.values) : ''}<p>${buttons}</p>${when}${line}</div>`;
}

export function answersHtml(model) {
  const { guide, answers } = model;
  const type = typeOf(guide.type);
  const missing = missingForEntry(guide.values);
  const names = missing.map((id) => FIELDS[id].name);
  const shown = answers ? (() => {
    const entry = registryEntry(guide.values, type.runtime);
    return `<div class="hg-answers"><h3>Registry entry</h3><p>Run this command on the Mac. Type the JSON below on the private input. End with Ctrl+D. This page sends nothing.</p><div class="hg-cmd"><div class="hg-cmd-head"><span class="hg-shell">Terminal on the Mac</span>${copyButton(entry.command, 'Copy command')}</div><pre><code>${esc(entry.command)}</code></pre></div><div class="hg-cmd"><div class="hg-cmd-head"><span class="hg-shell">JSON for the private input</span>${copyButton(entry.json, 'Copy JSON')}</div><pre><code>${esc(entry.json)}</code></pre></div>${entry.complete ? '' : `<p class="hg-warning" role="note"><strong>Missing:</strong> ${esc(names.join(', '))}.</p>`}<h3>Summary table</h3><p class="hg-note">The table holds private values. Keep it in your private notes. Do not commit it.</p><div class="hg-cmd"><div class="hg-cmd-head"><span class="hg-shell">Markdown</span>${copyButton(summaryTable(guide.values, guide.type), 'Copy table')}</div><pre><code>${esc(summaryTable(guide.values, guide.type))}</code></pre></div><h3>Next</h3><p>Create the factory on this host. Replace NAME with the name of the factory.</p>${commandHtml({ shell: 'mac', text: entry.next }, guide.values)}<p>H13, H14, and H15 are in the chapter <a href="/docs/guide/factory">Add a factory</a>.</p></div>`;
  })() : '';
  return `<div class="hg-answers-wrap" data-hg-answers><p>${missing.length ? `Missing for the registry entry: ${esc(names.join(', '))}.` : 'Each value that the registry entry needs is set.'}</p><p><button type="button" data-hg-show-answers>${answers ? 'Hide the entry and the table' : 'Show the registry entry and the table'}</button></p>${shown}</div>`;
}

export function hostChecksHtml(type) {
  const steps = stepsOf(type);
  const rows = HOST_CHECKS.map((check) => {
    const index = steps.findIndex((step) => step.id === check.step || step.id === `${check.step}-unix`);
    const where = index < 0 ? '<span class="hg-note">Not part of this list.</span>' : `<a href="#step-${index + 1}">Step ${index + 1}: ${esc(steps[index].name)}</a>`;
    return `<li id="${check.id.toLowerCase()}"><strong>${check.id}</strong> ${termsHtml(check.text)} ${where}</li>`;
  });
  return `<details class="panel hg-panel hg-hchecks"><summary>The 15 host checks (H1 to H15)</summary><ol class="hg-hlist">${rows.join('')}</ol></details>`;
}

export function stepHtml(step, index, model, shownFields) {
  const { guide, local } = model;
  const used = new Set();
  const done = !!guide.done?.[step.id];
  const doneCount = Object.keys(guide.done || {}).length;
  const blocked = !done && index > doneCount;
  const fields = (step.fields || []).filter((id) => fieldsFor(guide.type).some((field) => field.id === id) && !shownFields.has(id));
  fields.forEach((id) => shownFields.add(id));
  const tags = (step.h || []).map((h) => `<a class="hg-h" href="#${h.toLowerCase()}" title="Host check ${h}">${h}</a>`).join('');
  const commands = (step.commands || []).filter((command) => !command.types || command.types.includes(guide.type));
  const body = [
    step.warning ? `<p class="hg-warning" role="note"><strong>Warning.</strong> ${termsHtml(step.warning, used)}</p>` : '',
    `<p class="hg-what">${termsHtml(step.what, used)}</p>`,
    `<p class="hg-why"><strong>Why:</strong> ${termsHtml(step.why, used)}</p>`,
    step.list ? `<ol class="hg-list">${step.list.map((item) => `<li>${termsHtml(item, used)}</li>`).join('')}</ol>` : '',
    fields.length ? `<div class="hg-fields">${fields.map((id) => fieldHtml(id, guide.values)).join('')}</div>` : '',
    commands.map((command) => commandHtml(command, guide.values)).join(''),
    step.testPanel ? '<p class="hg-note">Use the panel <a href="#hg-tests">Test from this machine</a> at the top of the page.</p>' : '',
    step.terminateTest ? timedHtml('terminate', model) : '',
    step.reboot ? timedHtml('reboot', model) : '',
    step.answersPanel ? answersHtml(model) : '',
    `<p class="hg-expected"><strong>What you should see:</strong> ${termsHtml(step.expected, used)}</p>`,
    `<details class="hg-wrong"><summary>Something went wrong</summary><ol>${step.errors.map((e) => `<li><p class="hg-problem">${termsHtml(e.problem, used)}</p><p class="hg-fix"><strong>Fix:</strong> ${termsHtml(e.fix, used)}</p></li>`).join('')}</ol></details>`,
    `<label class="hg-done"><input type="checkbox" data-hg-done="${step.id}"${done ? ' checked' : ''}${blocked || local ? ' disabled' : ''}> <span>Step ${index + 1} is done</span></label><p class="hg-done-msg" role="status" aria-live="polite"></p>`,
  ].join('');
  return `<li class="hg-step" id="step-${index + 1}" data-step="${step.id}" data-done="${done}"><div class="hg-step-head"><span class="hg-num">${index + 1}</span><h3>${esc(step.name)}</h3>${tags}<span class="hg-where">${esc(step.where)}</span></div>${body}</li>`;
}

// The commands that the Owner has not checked yet. Their text is not in the repository docs.
export function uncheckedHtml(type) {
  const rows = stepsOf(type).flatMap((step, index) => (step.commands || []).filter((c) => c.own && (!c.types || c.types.includes(type))).map((c) => `<li>Step ${index + 1}, ${esc(step.name)}: <code>${esc(c.text.split('\n')[0])}</code></li>`));
  return rows.length ? `<footer class="hg-unchecked"><p>Not yet checked by the Owner:</p><ul>${rows.join('')}</ul></footer>` : '';
}

export function guideHtml(model) {
  const { guide } = model;
  const type = typeOf(guide.type);
  const steps = stepsOf(guide.type);
  const shown = new Set();
  const done = Object.keys(guide.done || {}).length;
  return `<header class="page-head"><h1>Add a host</h1><p class="muted"><strong>${esc(guide.label)}</strong> · ${esc(type.title)} · <span data-hg-progress>${done} of ${steps.length} steps done</span></p></header>
    ${model.local ? '<p class="hg-banner" role="note">This is the read-only preview. The guide does not save your progress and cannot run tests. The text and the commands work.</p>' : '<p class="hg-note">The page saves your progress on this machine. Close it and come back later. It sends nothing to the host or to any service.</p>'}
    <p class="hg-message" role="status" aria-live="polite" data-hg-message>${esc(model.message || '')}</p>
    <p><button type="button" class="quiet" data-hg-back>Choose another host</button></p>
    ${testPanelHtml(model)}
    ${hostChecksHtml(guide.type)}
    <ol class="hg-steps">${steps.map((step, index) => stepHtml(step, index, model, shown)).join('')}</ol>
    ${model.local ? '' : '<p><button type="button" class="quiet" data-hg-delete>Delete this guide and its saved values</button></p>'}
    ${uncheckedHtml(guide.type)}`;
}

const stepCount = (id) => stepsOf(id).length;

export function chooserHtml(model) {
  const { list = [], local, message = '', draft = {} } = model;
  const cards = HOST_TYPES.map((type, index) => `<label class="hg-type"><input type="radio" name="hg-type" value="${type.id}" data-hg-type${(draft.type || HOST_TYPES[0].id) === type.id ? ' checked' : ''}><span class="hg-type-body"><strong>${esc(type.title)}</strong>${index === 0 ? ' <span class="tag">first choice</span>' : ''}<span>${esc(type.summary)} ${stepCount(type.id)} steps.</span></span></label>`).join('');
  const saved = list.length ? `<section class="panel hg-panel"><h2>Continue a saved guide</h2><ul class="hg-saved">${list.map((row) => `<li><span><strong>${esc(row.label)}</strong> · ${esc(typeOf(row.type)?.title || row.type)} · ${row.done} of ${row.total} steps done</span> <button type="button" data-hg-open="${esc(row.label)}">Continue</button></li>`).join('')}</ul></section>` : '';
  const label = draft.label || '';
  const labelCheck = checkField('label', label);
  return `<header class="page-head"><h1>Add a host</h1><p class="muted">Prepare a computer that runs factories. The guide has the steps, the commands, and the checks.</p></header>
    ${local ? '<p class="hg-banner" role="note">This is the read-only preview. The guide does not save your progress and cannot run tests.</p>' : ''}
    <p class="hg-message" role="status" aria-live="polite" data-hg-message>${esc(message)}</p>
    <section class="panel hg-panel"><h2>1. Choose the host type</h2><div class="hg-types" role="radiogroup" aria-label="Host type">${cards}</div></section>
    <section class="panel hg-panel"><h2>2. Name the host</h2><div class="hg-field" data-hg-wrap="label" data-state="${label === '' ? 'empty' : labelCheck.ok ? 'ok' : 'bad'}"><label for="hg-start-label">Machine label</label><div class="hg-input"><input id="hg-start-label" type="text" data-hg-start-label value="${esc(label)}" placeholder="${esc(FIELDS.label.example)}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="31" aria-describedby="hg-start-label-msg"><span class="hg-mark" aria-hidden="true"></span></div><p class="hg-hint">${esc(FIELDS.label.hint)}</p><p class="hg-msg" id="hg-start-label-msg" role="status" aria-live="polite">${esc(labelCheck.message)}</p></div><p><button type="button" class="primary" data-hg-start>Start the guide</button></p></section>
    ${saved}`;
}

export function pageHtml(model) {
  if (model.loading) return '<header class="page-head"><h1>Add a host</h1></header><p role="status">Loading…</p>';
  return model.screen === 'guide' && model.guide ? guideHtml(model) : chooserHtml(model);
}
