import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { POLICY_DEFAULTS } from '../src/control.js';
import { serviceSettingsView } from '../src/config.js';
import { APPLY, SETTING_GROUPS, SETTING_HELP, SETTING_FIELDS, DOCS_BEGIN, DOCS_END, settingsDocsMarkdown, settingsGuideHtml, settingPopupHtml } from '../public/setting-help.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const docsPath = new URL('../docs/cli.md', import.meta.url);

// Policy keys that have no single setting control. Each one has its own editor with its own help text, or holds a list that the page edits by other means.
const POLICY_KEYS_WITHOUT_CONTROL = new Set([
  'machine', // the machine.* keys are checked one by one below
  'attachments', // the attachments.retentionDays key has its own explanation below
  'agentMessages', // the retention and prompt timeout controls have their own explanations below
  'locks', // the locks.* keys are checked one by one below
  'orchestratorLadder', // the succession list editor on Allocation
  'allowedKinds', // the Available switch of each harness: harness.available
  'excludedModels', 'disabledModels', 'extraModels', 'preferredModels', 'modelProviders', 'harnessRoutes', // the harness model rows: harness.model, harness.provider, harness.preferredModel, harness.addModel
  'providerModes', // quota.mode
  'pacingGoals', // quota.goalPercent (goal and goal end)
  'quotaProbe', // the quotaProbe.* controls on Quotas have their own explanations
  'goals', // the goals.autoCommand switch on Allocation
  'handoff', // the handoff.autoCooldownHours control on Allocation
  'opus', // the opus.* keys are checked one by one below
  'excludedWorkspaces', 'projects', // the workspace switches and project shares on Allocation
]);

test('every policy machine key and top-level policy setting has an explanation', () => {
  const machineKeys = Object.keys(POLICY_DEFAULTS.machine).filter((key) => key !== 'guardPausedUntil');
  for (const key of machineKeys) assert.ok(SETTING_HELP[`machine.${key}`], `machine.${key} has no explanation`);
  assert.ok(SETTING_HELP['machine.guardPause'], 'the pause control has an explanation');
  const noControl = POLICY_KEYS_WITHOUT_CONTROL;
  for (const key of Object.keys(POLICY_DEFAULTS)) {
    if (noControl.has(key)) continue;
    assert.ok(SETTING_HELP[key], `policy key ${key} has no explanation. Add one, or list the key in POLICY_KEYS_WITHOUT_CONTROL with its reason.`);
  }
  for (const key of noControl) assert.ok(key in POLICY_DEFAULTS, `${key} is listed as without a control but is not a policy key`);
});

test('every lock lane policy key has a Locks group explanation', () => {
  const keys = [
    'locks.slots', 'locks.shortLimitMinutes', 'locks.guard.enabled',
    'locks.guard.maxLoadPercent', 'locks.guard.maxSwapPercent', 'locks.guard.minFreeMemPercent',
  ];
  assert.ok(SETTING_GROUPS.some((group) => group.id === 'locks' && group.title === 'Locks'));
  for (const key of keys) assert.equal(SETTING_HELP[key]?.group, 'locks', `${key} has a Locks explanation`);
});

test('every service setting has an explanation', () => {
  for (const { setting } of serviceSettingsView({})) assert.ok(SETTING_HELP[setting], `${setting} has no explanation`);
});

test('the release repository setting explains the approval rule in Settings and Help', () => {
  const item = SETTING_HELP['releases.repos'];
  assert.ok(item, 'releases.repos has a help row');
  assert.equal(item.group, 'service');
  assert.match(item.what, /release request.*release publish/i);
  assert.match(item.what, /Owner.*approve.*Mailbox/i);
  const help = app.slice(app.indexOf('const HELP ='));
  const settingsStart = help.indexOf("settings: ['Settings',");
  const nextPage = help.indexOf("\n  agents: ['Agents',", settingsStart);
  assert.ok(settingsStart >= 0 && nextPage > settingsStart, 'the Settings Help entry is present');
  const settingsHelp = help.slice(settingsStart, nextPage);
  assert.match(settingsHelp, /In <b>Releases<\/b>, list the GitHub repositories that may request a release; the Owner must approve each request in the Mailbox before publish\./);
  assert.doesNotMatch(help, /release-approvals/);
});

test('quota plan settings share the Usage limit plan help group and documented defaults', () => {
  const group = SETTING_GROUPS.find((item) => item.id === 'quota-plan');
  assert.equal(group?.title, 'Usage limit plan');
  assert.match(group?.affects || '', /Mailbox items.*expiry notices/);
  assert.match(SETTING_HELP['quotaPlan.applyThreshold']?.what || '', /ask the Owner/);
  for (const [setting, value, range] of [
    ['quotaPlan.burstPace', '1', '0.1 to 10'],
    ['quotaPlan.applyThreshold', '95', '50 to 100'],
    ['quotaPlan.margin', '0', '0 to 50'],
    ['quotaPlan.horizon', 'last-expiry', 'last-expiry or an ISO time'],
    ['quotaPlan.tolerance', '5', '0 to 50'],
    ['quotaPlan.holdMargin', '1', '0 to 50'],
    ['quotaPlan.slowFactor', '0.5', '0.1 to 1'],
    ['quotaPlan.planMode', 'paced', 'paced or burst'],
  ]) {
    assert.equal(SETTING_HELP[setting]?.group, 'quota-plan');
    assert.equal(SETTING_HELP[setting]?.default, value);
    assert.equal(SETTING_HELP[setting]?.range, range);
  }
  assert.match(app, /<h3>Usage limit plan<\/h3><p>Set the Codex burst pace/);
  const help = app.slice(app.indexOf('const HELP ='));
  assert.match(help, /Mailbox approval item when a credit is due or expires within 48 hours/);
  assert.match(help, /warning in the 24 hours before an available credit expires/);
  assert.match(SETTING_HELP['quotaPlan.tolerance']?.what, /above the planned curve/);
  assert.match(SETTING_HELP['quotaPlan.planMode']?.what, /Paced holds.*Burst/);
  assert.match(help, /In <b>paced<\/b> mode.*In <b>burst<\/b> mode the curve is advice only/);
  assert.match(help, /time at which the recent burn of the last 24 hours reaches the credit threshold/);
  assert.match(app, /the Codex lane compares current use with its planned curve/i);
});

test('worker and browser maintenance settings have editable rows and help text', () => {
  const expected = {
    'workers.paneCloseDelayMinutes': { range: '0 to 60', default: '2' },
    'workers.uncollectedNoticeMinutes': { range: '1 to 1440', default: '30' },
    'browser.idleCloseMinutes': { range: '0 to 1440', default: '20' },
    'browser.allowVisible': { range: 'On or off', default: 'Off' },
    'worktrees.pruneAtCollect': { range: 'On or off', default: 'On' },
  };
  for (const [setting, values] of Object.entries(expected)) {
    const help = SETTING_HELP[setting];
    assert.ok(help, `${setting} has help text`);
    assert.equal(help.group, 'service');
    assert.equal(help.range, values.range);
    assert.equal(help.default, values.default);
    if (setting === 'worktrees.pruneAtCollect') assert.match(app, /serviceSettingBooleans = new Set\([^\n]*'worktrees\.pruneAtCollect'/);
    else if (setting === 'browser.allowVisible') assert.match(app, /serviceSettingBooleans = new Set\([^\n]*'browser\.allowVisible'/);
    else assert.match(app, new RegExp(`['"]${setting.replaceAll('.', '\\.')}['"]\\s*:\\s*\\[`));
  }
  assert.match(SETTING_HELP['browser.allowVisible']?.what || '', /visible.*project browser/i);
  assert.match(SETTING_HELP['browser.allowVisible']?.what || '', /off by default/i);
});

test('every explanation has all fields, a known group, and an apply mode', () => {
  const groups = new Set(SETTING_GROUPS.map((group) => group.id));
  for (const [id, item] of Object.entries(SETTING_HELP)) {
    assert.ok(groups.has(item.group), `${id} has an unknown group`);
    assert.ok(item.label?.trim(), `${id} has no label`);
    for (const field of SETTING_FIELDS) assert.ok(typeof item[field] === 'string' && item[field].trim(), `${id} has no ${field}`);
    assert.ok(APPLY[item.apply], `${id} has an unknown apply mode`);
  }
  for (const group of SETTING_GROUPS) for (const field of ['title', 'controls', 'affects', 'safe', 'restart']) assert.ok(group[field]?.trim(), `${group.id} has no ${field}`);
});

test('the text follows the Simplified Technical English limits', () => {
  const banned = /\b(leverage|robust|seamless|comprehensive|delve|in order to|it's worth noting)\b/i;
  const texts = [
    ...Object.entries(SETTING_HELP).flatMap(([id, item]) => SETTING_FIELDS.map((field) => [`${id}.${field}`, item[field]])),
    ...SETTING_GROUPS.flatMap((group) => ['controls', 'affects', 'safe', 'restart'].map((field) => [`${group.id}.${field}`, group[field]])),
  ];
  for (const [where, text] of texts) {
    assert.doesNotMatch(text, banned, `${where} has a banned word`);
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      assert.ok(sentence.split(/\s+/).length <= 25, `${where} has a sentence over 25 words: ${sentence}`);
    }
  }
});

// The ids that the page code asks for: literal calls, the Machine rows, the price columns, and the service table rows.
function usedIds() {
  const ids = new Set([...app.matchAll(/helpButton\('([^']+)'/g)].map((match) => match[1]).filter((id) => !id.endsWith('.')));
  for (const match of app.matchAll(/lockInput\('([^']+)'/g)) ids.add(match[1]);
  for (const key of ['attachments.retentionDays', 'agentMessages.retentionDays', 'agentMessages.metaRetentionDays', 'locks.slots', 'locks.shortLimitMinutes', 'locks.guard.enabled', 'locks.guard.maxLoadPercent', 'locks.guard.maxSwapPercent', 'locks.guard.minFreeMemPercent']) ids.add(key);
  for (const match of app.matchAll(/machineNumber\('(\w+)'/g)) ids.add(`machine.${match[1]}`);
  for (const match of app.matchAll(/settingRow\('([^']+)'/g)) ids.add(match[1]);
  if (app.includes("helpButton('prices.' + field)")) for (const match of app.matchAll(/\['(input|output|cacheRead|cacheWrite|cacheWrite1h)', '/g)) ids.add(`prices.${match[1]}`);
  if (app.includes('${helpButton(item.setting)}')) for (const { setting } of serviceSettingsView({})) ids.add(setting);
  return ids;
}

test('the page asks for help only for settings that have a text', () => {
  const ids = usedIds();
  assert.ok(ids.size >= 40, `the page uses ${ids.size} help buttons`);
  for (const id of ids) assert.ok(SETTING_HELP[id], `${id} is used in public/app.js and has no explanation`);
});

test('every explained setting has an info button in the page code', () => {
  const ids = usedIds();
  for (const id of Object.keys(SETTING_HELP)) assert.ok(ids.has(id), `${id} has no info button on a page`);
});

test('the popup and the guide come from the same text', () => {
  const html = settingPopupHtml('machine.swapWarnPercent');
  assert.match(html, /Swap warning|swap warning/);
  assert.match(html, /Default/);
  assert.match(html, /<dd>80<\/dd>/);
  const guide = settingsGuideHtml();
  for (const group of SETTING_GROUPS) assert.ok(guide.includes(group.title), `the guide names ${group.title}`);
  assert.match(guide, /Escape/);
});

test('the Advanced group holds the rarely used groups', () => {
  const advanced = SETTING_GROUPS.filter((group) => group.advanced).map((group) => group.id);
  assert.deepEqual(advanced, ['prices', 'avatars', 'service', 'quota-plan', 'analytics', 'readiness']);
  const first = SETTING_GROUPS.slice(0, 4).map((group) => group.id);
  assert.deepEqual(first, ['harnesses', 'quotas', 'machine', 'locks']);
});

test('docs/cli.md holds the settings reference of the schema', () => {
  const doc = fs.readFileSync(docsPath, 'utf8');
  const begin = doc.indexOf(DOCS_BEGIN);
  const end = doc.indexOf(DOCS_END);
  assert.ok(begin >= 0 && end > begin, 'docs/cli.md has the settings reference markers');
  const block = doc.slice(begin, end + DOCS_END.length);
  if (process.env.UPDATE_SETTINGS_DOCS === '1') fs.writeFileSync(docsPath, doc.replace(block, settingsDocsMarkdown()));
  else assert.equal(block, settingsDocsMarkdown(), 'run UPDATE_SETTINGS_DOCS=1 node --test test/setting-help.test.js');
});

test('the Advanced fold opens for a warning, shows a count, and the popup closes on focus loss', () => {
  assert.match(app, /forceOpen: advancedIssues > 0/);
  assert.match(app, /need\$\{advancedIssues === 1 \? 's' : ''\} attention/);
  assert.match(app, /finding\.status !== 'ok'/);
  assert.match(app, /serviceSettingsMessages\)\.filter/);
  assert.match(app, /addEventListener\('focusout'/);
  assert.match(app, /aria-describedby="setting-popup"/);
});

test('the settable service settings state their range and when they apply', () => {
  const expected = {
    tickSeconds: ['5 to 300', 'service'],
    quotaSeconds: ['30 to 3600', 'service'],
    push: ['On or off', 'saved-restart'],
  };
  for (const [id, [range, apply]] of Object.entries(expected)) {
    assert.ok(SETTING_HELP[id].range.includes(range), `${id} range must say ${range}`);
    assert.equal(SETTING_HELP[id].apply, apply, `${id} apply mode`);
  }
  assert.match(SETTING_HELP.push.what, /HERDR_BOSS_PUSH=0/);
  assert.match(SETTING_HELP.push.what, /restart/i);
  assert.equal(SETTING_HELP['analytics.actionsMinutes'].default, 'On');
  assert.equal(SETTING_HELP['analytics.actionsMinutes'].apply, 'service');
  assert.match(SETTING_HELP['analytics.actionsMinutes'].what, /estimated from run times/i);
  assert.match(SETTING_HELP['analytics.actionsMinutes'].raise, /service uses its GitHub token/i);
  assert.match(SETTING_HELP.alertCooldownSeconds.what, /unused legacy value/);
  for (const id of ['alertCooldownSeconds', 'port', 'host', 'providerKinds', 'orchestratorLabel']) assert.equal(SETTING_HELP[id].apply, 'restart', `${id} stays in config.json`);
});

// A setting that a page shows in more than one row gets one info button on the section or group header.
// A row button repeats the same explanation, so a helpButton call takes no instance argument.
test('no two rows of a section carry the same explanation as row buttons', () => {
  assert.deepEqual([...app.matchAll(/helpButton\('[^']+',[^)]*\)/g)].map((match) => match[0]), [], 'helpButton takes one argument');
  assert.doesNotMatch(app, /settingRow\([^\n]*\{[^}]*field:[^}]*\}\)\}<\/label>[^\n]*helpButton/, 'settingRow adds no instance help');
  const counts = new Map();
  for (const match of app.matchAll(/helpButton\('([^']+)'\)/g)) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  for (const [id, count] of counts) assert.equal(count, 1, `${id} has ${count} info buttons`);
  const settingRows = new Map();
  for (const match of app.matchAll(/settingRow\('([^']+)'/g)) settingRows.set(match[1], (settingRows.get(match[1]) || 0) + 1);
  for (const [id, count] of settingRows) assert.equal(count, 1, `${id} has ${count} row buttons`);
});

test('the repeated per-harness, per-provider, and per-routine settings have one button on the header', () => {
  const settings = app.slice(app.indexOf('function settingsView('));
  assert.match(settings, /<h3>Usage limit mode\$\{helpButton\('quota\.mode'\)\}<\/h3>/);
  assert.match(settings, /Pacing goals\$\{helpButton\('quota\.goalPercent'\)\}<\/h3>/);
  for (const id of ['harness.available', 'harness.preferredModel', 'harness.model', 'harness.provider', 'harness.addModel']) assert.match(settings, new RegExp(`class="help-legend"[^\\n]*helpButton\\('${id.replace('.', '\\.')}'\\)`), `${id} is in the Harnesses legend`);
  for (const id of ['watch.routine.title', 'watch.routine.model', 'watch.routine.schedule', 'watch.routine.prompt']) assert.match(app, new RegExp(`class="help-legend"[^\\n]*helpButton\\('${id.replace(/\./g, '\\.')}'\\)`), `${id} is in the routines legend`);
  const harness = app.slice(app.indexOf('function harnessSection('), app.indexOf('function localDateTime('));
  assert.doesNotMatch(harness, /helpButton\(/);
  const routine = app.slice(app.indexOf('function routineEditor('), app.indexOf('function watchRoutineSettings('));
  assert.doesNotMatch(routine, /helpButton\(/);
});

test('no explanation of the schema repeats inside a group', () => {
  const seen = new Map();
  for (const [id, item] of Object.entries(SETTING_HELP)) {
    const key = `${item.group}|${item.what.trim().toLowerCase()}`;
    assert.ok(!seen.has(key), `${id} repeats the explanation of ${seen.get(key)}`);
    seen.set(key, id);
  }
});

test('the Settings and Allocation pages keep no always-visible explanation that the popups cover', () => {
  const removed = [
    'Apply policy to save this choice', 'Boss prepares a successor at the reserve limit', 'A handover copies the goal',
    'At a task boundary, a Claude orchestrator', 'Automatic handover never runs', 'Automatic handover tries these choices',
    'Clear a workspace switch', 'project shares are advisory', 'drag a boundary', 'Clear a model box', 'Ignore quota turns off pacing',
    'The most percent of a window', 'Quota warning at', 'The Owner is away after the idle period', 'USD per million tokens',
    'Rows without inputs are read-only', 'Run herdr-boss harness sync', 'A routine is a prompt that the service sends', 'Each pool lists its items',
    'Choose <b>Upload image</b>', 'unused legacy value',
  ];
  const pages = app.slice(0, app.indexOf('const HELP = {'));
  for (const text of removed) assert.ok(!pages.includes(text), `"${text}" is still inline`);
  const settings = app.slice(app.indexOf('function settingsView('), app.indexOf('// The handoff records that need the Owner'));
  const paragraphs = [...settings.matchAll(/<p class="setting-help"[^>]*>/g)].length;
  assert.ok(paragraphs <= 5, `the Settings page has ${paragraphs} inline help lines`);
});

test('the schema holds the succession, workspace, and share explanations', () => {
  for (const id of ['succession.ladder', 'workspace.exclusion', 'project.shares']) assert.equal(SETTING_HELP[id]?.group, 'capacity', id);
  for (const id of ['succession.ladder', 'workspace.exclusion', 'project.shares']) assert.match(app, new RegExp(`helpButton\\('${id.replace('.', '\\.')}'\\)`));
});

test('forced context handover has an editable policy setting and clear help', () => {
  const item = SETTING_HELP.autoHandoverForceContextTokens;
  assert.equal(item?.label, 'Force handover at context tokens');
  assert.equal(item?.default, '400000');
  assert.equal(item?.range, '50000 to 2000000');
  assert.match(item?.what || '', /before it prepares a fresh successor/);
  assert.match(app, /settingRow\('autoHandoverForceContextTokens'/);
});

test('automatic Claude goal delivery has a policy control and help text', () => {
  assert.equal(POLICY_DEFAULTS.goals.autoCommand, false);
  assert.equal(SETTING_HELP['goals.autoCommand']?.group, 'capacity');
  assert.match(app, /data-policy-goal-bool="autoCommand"/);
  assert.ok(app.includes("settingRow('goals.autoCommand'"));
});

test('picture retention has a Pictures group explanation', () => {
  assert.equal(SETTING_HELP['attachments.retentionDays']?.group, 'attachments');
  assert.equal(SETTING_HELP['attachments.retentionDays']?.range, '1 to 365');
  assert.ok(SETTING_GROUPS.some(({ id, title }) => id === 'attachments' && title === 'Pictures'));
});

test('agent message text and metadata retention use separate settings', () => {
  assert.equal(SETTING_HELP['agentMessages.retentionDays']?.group, 'attachments');
  assert.equal(SETTING_HELP['agentMessages.retentionDays']?.default, '14');
  assert.equal(SETTING_HELP['agentMessages.retentionDays']?.range, '1 to 90');
  assert.equal(SETTING_HELP['agentMessages.metaRetentionDays']?.default, '180');
  assert.equal(SETTING_HELP['agentMessages.metaRetentionDays']?.range, '7 to 730');
  assert.match(SETTING_HELP['agentMessages.metaRetentionDays'].what, /no message text/);
});

test('agent prompt timeout has complete help and a Settings control', () => {
  assert.equal(SETTING_HELP['agentMessages.promptTimeoutSeconds']?.default, '25');
  assert.equal(SETTING_HELP['agentMessages.promptTimeoutSeconds']?.unit, 'Seconds');
  assert.equal(SETTING_HELP['agentMessages.promptTimeoutSeconds']?.range, '1 to 120');
  assert.match(SETTING_HELP['agentMessages.promptTimeoutSeconds'].what, /submit.*once/i);
  assert.match(SETTING_HELP['agentMessages.promptTimeoutSeconds'].what, /agent is idle/);
  assert.match(app.slice(app.indexOf('const HELP =')), /unsubmitted input while the agent is idle/);
  assert.match(app, /lockInput\('agentMessages.promptTimeoutSeconds'/);
});

test('the Opus policy has defaults, controls, and help text', () => {
  assert.deepEqual(POLICY_DEFAULTS.opus, { allowWithoutForce: false, maxConcurrent: 2 });
  assert.equal(SETTING_HELP['opus.allowWithoutForce']?.group, 'capacity');
  assert.equal(SETTING_HELP['opus.allowWithoutForce']?.default, 'Off');
  assert.equal(SETTING_HELP['opus.maxConcurrent']?.group, 'capacity');
  assert.equal(SETTING_HELP['opus.maxConcurrent']?.default, '2');
  assert.equal(SETTING_HELP['opus.maxConcurrent']?.range, '1 to 8');
  assert.match(SETTING_HELP['opus.allowWithoutForce'].what, /--force/);
  assert.match(app, /data-policy-opus-bool="allowWithoutForce"/);
  assert.match(app, /data-policy-opus="maxConcurrent"/);
  assert.ok(app.includes("settingRow('opus.allowWithoutForce'"));
  assert.ok(app.includes("settingRow('opus.maxConcurrent'"));
});
