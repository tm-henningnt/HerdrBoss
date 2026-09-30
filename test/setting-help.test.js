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
  'orchestratorLadder', // the succession list editor on Allocation
  'allowedKinds', // the Available switch of each harness: harness.available
  'excludedModels', 'disabledModels', 'extraModels', 'preferredModels', 'modelProviders', 'harnessRoutes', // the harness model rows: harness.model, harness.provider, harness.preferredModel, harness.addModel
  'providerModes', // quota.mode
  'pacingGoals', // quota.goalPercent and quota.goalEnd
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

test('every service setting has an explanation', () => {
  for (const { setting } of serviceSettingsView({})) assert.ok(SETTING_HELP[setting], `${setting} has no explanation`);
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
  assert.deepEqual(advanced, ['prices', 'avatars', 'service', 'readiness']);
  const first = SETTING_GROUPS.slice(0, 3).map((group) => group.id);
  assert.deepEqual(first, ['harnesses', 'quotas', 'machine']);
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
  assert.match(SETTING_HELP.alertCooldownSeconds.what, /unused legacy value/);
  for (const id of ['alertCooldownSeconds', 'port', 'host', 'providerKinds', 'orchestratorLabel']) assert.equal(SETTING_HELP[id].apply, 'restart', `${id} stays in config.json`);
});
