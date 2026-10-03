// The explainer page of the Docs section: a stepped walkthrough of the parts of one factory and how they work together.
// The text of the steps is the array STEPS below. Edit the text there. Each claim must match docs/ or the code.
// The module builds HTML strings and takes the page root as an argument, so the Node tests run it against a fake root.
import { esc } from './markdown.js';

// A box of the diagram. The group places the box in the diagram.
export const PARTS = [
  { id: 'owner', label: 'You', group: 'top' },
  { id: 'dashboard', label: 'Dashboard', group: 'top' },
  { id: 'mailbox', label: 'Mailbox', group: 'top' },
  { id: 'packs', label: 'Review packs', group: 'top' },
  { id: 'service', label: 'Service', group: 'control' },
  { id: 'quota', label: 'Quota lanes', group: 'control' },
  { id: 'policy', label: 'Policy', group: 'control' },
  { id: 'locks', label: 'Locks', group: 'control' },
  { id: 'boss', label: 'Boss', group: 'panes' },
  { id: 'lead', label: 'Project lead', group: 'panes' },
  { id: 'workers', label: 'Workers', group: 'panes' },
  { id: 'kit', label: 'Kit', group: 'shared' },
  { id: 'handover', label: 'Handover', group: 'shared' },
];
// Outer frames. `panes` is the dashed frame around the three agents. `factory` is the frame around the whole factory.
export const FRAMES = ['panes', 'factory'];
export const PART_IDS = [...PARTS.map((p) => p.id), ...FRAMES];

// One step: a title, the ids of the highlighted parts, and 2 to 4 short sentences.
export const STEPS = [
  { id: 'factory', title: 'One factory', parts: ['factory'], text: [
    'A factory is one complete Herdr Boss setup on one computer or container.',
    'This walkthrough shows one factory. Each box is one part of it.',
    'The highlighted boxes are the topic of the step.',
  ] },
  { id: 'dashboard', title: 'You and the dashboard', parts: ['owner', 'dashboard'], text: [
    'You are the Owner. You use the dashboard in a web browser to see all projects and to control them.',
    'The dashboard also holds these Docs.',
    'A phone can reach the dashboard through Tailscale.',
  ] },
  { id: 'service', title: 'The service', parts: ['service', 'dashboard'], text: [
    'The service is a program that runs in the background on your computer. It serves the dashboard.',
    'Every 30 seconds, it reads the Herdr workspaces and agents.',
    'It uses no AI model and no tokens.',
  ] },
  { id: 'panes', title: 'Panes', parts: ['panes', 'service'], text: [
    'Herdr shows each agent in a pane. A pane is one terminal window.',
    'A workspace is the group of panes of one project.',
    'The service finds an agent by the label of its pane.',
  ] },
  { id: 'boss', title: 'The Boss', parts: ['boss', 'owner'], text: [
    'The Boss is the one agent that watches all projects. Its pane has the label boss.',
    'You talk with the Boss on the Chat page.',
    'A project lead reports finished work and questions to the Boss.',
  ] },
  { id: 'lead', title: 'The project lead', parts: ['lead', 'boss'], text: [
    'Each project has one project lead. Its pane has the label orch. The commands call this agent the orchestrator.',
    'The project lead plans the work of the project and gives tasks to workers.',
    'It publishes a status file that holds the backlog and the progress.',
  ] },
  { id: 'workers', title: 'Workers', parts: ['workers', 'lead', 'panes'], text: [
    'A worker does one task for a project lead.',
    'The command herdr-boss worker start puts the worker in a pane of a worker tab. A worker tab holds 3 worker panes by default.',
    'Each worker has its own worktree and branch, and it reads a written brief.',
  ] },
  { id: 'locks', title: 'Locks', parts: ['locks', 'workers', 'lead'], text: [
    'A lock lets only one agent do an exclusive job at a time.',
    'The lock full-suite is machine-wide: one full test suite runs on the computer at a time. The other locks belong to one Git repository.',
    'An agent that waits for a lock takes a ticket. The tickets go in first-in, first-out order inside each lane.',
  ] },
  { id: 'quota', title: 'Usage limits and lanes', parts: ['quota', 'service', 'workers'], text: [
    'Every 5 minutes, the service reads the usage limit of each provider.',
    'It gives each provider a lane: open, ahead of pace, near exhaustion, or exhausted.',
    'The command worker start refuses a lane that is not open, unless the agent uses --force.',
  ] },
  { id: 'policy', title: 'Policy and the bulletin', parts: ['policy', 'quota', 'service'], text: [
    'You set the policy on the Settings and Allocation pages. The policy has, for example, the global cap of working agents and the shares of the projects.',
    'The service applies the policy and the lanes. It writes the files bulletin.md and rules.json.',
    'A project lead reads the bulletin before each dispatch. The command worker start reads the rules.',
  ] },
  { id: 'mailbox', title: 'The Mailbox and review packs', parts: ['mailbox', 'packs', 'owner', 'lead'], text: [
    'Agents leave messages for you in the Mailbox. The folder Needs you lists the items that wait for your answer.',
    'A review pack is a set of items with evidence.',
    'You accept, reject, or comment on each item. A live check opens the real result.',
  ] },
  { id: 'kit', title: 'The kit', parts: ['kit', 'lead', 'workers', 'boss'], text: [
    'The kit is the set of shared files and rules that Herdr Boss gives to each project.',
    'The command herdr-boss kit install writes the kit file, a stub in AGENTS.md, and a session start hook in the project.',
    'When a required kit change exists, the service sends a Kit updated notice to each project lead.',
  ] },
  { id: 'handover', title: 'Handovers', parts: ['handover', 'lead', 'quota'], text: [
    'A handover replaces a project lead with a fresh agent. Herdr Boss recommends one when the usage limit of the project lead comes near its reserve.',
    'The successor starts in a new tab and only reads and reports. Inspect its answer, then confirm the activation.',
    'The successor pane gets the label orch. The old pane gets the label orch previous.',
  ] },
  { id: 'factories', title: 'Factories and the Fleet', parts: ['factory', 'boss'], text: [
    'A host is a computer that runs one or more factories.',
    'Each factory has its own service, Boss, projects, and data.',
    'The Fleet page shows all factories that you manage. A transfer moves one project to another factory.',
  ] },
  { id: 'together', title: 'How the parts work together', parts: ['owner', 'dashboard', 'service', 'boss', 'lead', 'workers', 'quota', 'policy', 'locks', 'mailbox'], text: [
    'You set the goals and the policy in the dashboard.',
    'The service reads the state and writes the rules. The project leads follow the rules and give tasks to workers.',
    'The workers do the tasks. The Mailbox brings the questions back to you.',
  ] },
];

export const clampStep = (n) => Math.min(STEPS.length - 1, Math.max(0, Number.isInteger(n) ? n : 0));

const box = (part, active) => `<div class="ex-box${active.has(part.id) ? ' is-active' : ''}" data-part="${part.id}">${esc(part.label)}</div>`;
const group = (name, active) => PARTS.filter((p) => p.group === name).map((p) => box(p, active)).join('');

// The diagram of one step. The boxes of the step have the class is-active. The other boxes are dim.
export function diagramHtml(index) {
  const active = new Set(STEPS[clampStep(index)].parts);
  const frame = (id) => (active.has(id) ? ' is-active' : '');
  return `<div class="ex-factory${frame('factory')}" data-part="factory"><span class="ex-frame-label">Factory</span>`
    + `<div class="ex-row">${group('top', active)}</div>`
    + `<div class="ex-row">${group('control', active)}</div>`
    + `<div class="ex-panes${frame('panes')}" data-part="panes"><span class="ex-frame-label">Panes</span><div class="ex-row ex-row-3">${group('panes', active)}</div></div>`
    + `<div class="ex-row">${group('shared', active)}</div></div>`
    + `<div class="ex-fleet${frame('factory')}" aria-hidden="true"><div class="ex-box">Another factory</div><div class="ex-box">Another factory</div></div>`;
}

export function textHtml(index) {
  const step = STEPS[clampStep(index)];
  return `<h3 class="ex-title">${esc(step.title)}</h3><p>${step.text.map(esc).join(' ')}</p>`;
}

export function controlsHtml(index) {
  const i = clampStep(index);
  const last = STEPS.length - 1;
  return `<div class="ex-progress"><span class="ex-count">Step ${i + 1} of ${STEPS.length}</span>`
    + `<div class="ex-bar" role="progressbar" aria-label="Progress" aria-valuemin="1" aria-valuemax="${STEPS.length}" aria-valuenow="${i + 1}"><span style="width:${Math.round(((i + 1) / STEPS.length) * 100)}%"></span></div></div>`
    + `<div class="ex-buttons"><button type="button" data-ex-go="prev"${i === 0 ? ' disabled' : ''}>Back</button><button type="button" data-ex-go="next"${i === last ? ' disabled' : ''}>Next</button></div>`;
}

export function listHtml(index) {
  const i = clampStep(index);
  return `<ol class="ex-steps">${STEPS.map((s, n) => `<li><button type="button" data-ex-go="${n}" aria-label="Step ${n + 1}: ${esc(s.title)}"${n === i ? ' aria-current="step"' : ''}>${n + 1}</button></li>`).join('')}</ol>`;
}

// The first render of the root. The text block stays in place and keeps aria-live, so a screen reader reads each new step.
export const shellHtml = () => '<div class="ex-diagram" data-ex-diagram aria-hidden="true"></div>'
  + '<div class="ex-panel"><div class="ex-text" data-ex-text aria-live="polite" aria-atomic="true"></div>'
  + '<div class="ex-controls" data-ex-controls></div>'
  + '<nav class="ex-list" data-ex-list aria-label="Steps"></nav>'
  + '<p class="ex-hint">Use the Back and Next buttons, or the left and right arrow keys.</p></div>';

// The step that the reader last saw. A render of the dashboard that replaces the root starts the root again at this step.
let current = 0;
export const currentStep = () => current;

export function mountExplainer(root, { start = current } = {}) {
  let index = clampStep(start);
  root.innerHTML = shellHtml();
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Interactive explainer');
  root.setAttribute('tabindex', '0');
  const part = (name) => root.querySelector(`[data-ex-${name}]`);

  // focusSelector names the element that takes the focus after the render, because the render replaces the buttons.
  function show(n, focusSelector = '') {
    index = clampStep(n);
    current = index;
    part('diagram').innerHTML = diagramHtml(index);
    part('text').innerHTML = textHtml(index);
    part('controls').innerHTML = controlsHtml(index);
    part('list').innerHTML = listHtml(index);
    if (!focusSelector) return;
    // A disabled button cannot keep the focus. The chip of the step takes it.
    const target = root.querySelector(`${focusSelector}:not(:disabled)`) || root.querySelector('[aria-current="step"]');
    target?.focus?.();
  }

  // The element that a render replaces and that has the focus now: the same button comes back, or the chip of the new step.
  const refocus = (e) => {
    const go = e.target?.closest?.('[data-ex-go]');
    if (!go) return '';
    const value = go.getAttribute?.('data-ex-go');
    return /^\d+$/.test(value) ? '[aria-current="step"]' : `[data-ex-go="${value}"]`;
  };
  root.addEventListener('click', (e) => {
    const button = e.target?.closest?.('[data-ex-go]');
    if (!button || button.disabled) return;
    const go = button.getAttribute('data-ex-go');
    if (go === 'prev') show(index - 1, refocus(e));
    else if (go === 'next') show(index + 1, refocus(e));
    else if (/^\d+$/.test(go)) show(Number(go), refocus(e));
  });
  root.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: STEPS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault?.();
    if (clampStep(to) !== index) show(to, refocus(e));
  });
  show(index);
  return { go: show, index: () => index };
}
