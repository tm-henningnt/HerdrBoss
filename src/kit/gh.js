import fs from 'node:fs';
import path from 'node:path';
import { scanText } from '../secret-scan.js';
import { KIT_ROOT } from './config.js';

const COMMANDS = new Map([
  ['create', ['issue', 'create']],
  ['comment', ['issue', 'comment']],
  ['edit', ['issue', 'edit']],
]);

export function buildGhArgs(command, args) {
  const prefix = COMMANDS.get(command);
  if (!prefix) throw new Error(`unsupported safe GitHub command: ${String(command)}.`);
  if (args.some((arg) => arg === '--body' || arg.startsWith('--body='))) throw new Error('inline --body is not allowed; use --body-file.');
  const indices = args.flatMap((arg, index) => arg === '--body-file' ? [index] : []);
  if (indices.length !== 1) throw new Error('exactly one --body-file argument is required.');
  const bodyIndex = indices[0];
  const bodyPath = args[bodyIndex + 1];
  if (!bodyPath || bodyPath.startsWith('--')) throw new Error('--body-file needs a file path.');
  if ((command === 'comment' || command === 'edit') && !/^\d+$/.test(args[0] ?? '')) throw new Error(`${command} needs a numeric issue number first.`);
  if (bodyIndex === 0 && command !== 'create') throw new Error(`${command} needs an issue number before --body-file.`);
  return [...prefix, ...args];
}

// Labels and milestones. Every value is checked before any gh call. The argument arrays hold each value as one element.
// A name goes after `--` and a flag value joins its flag with `=`, so gh cannot read a value as a flag.
const LABEL_NAME_MAX = 50;
const LABEL_DESCRIPTION_MAX = 100;
const MILESTONE_TITLE_MAX = 255;
const MILESTONE_DESCRIPTION_MAX = 1000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

function checkRepo(repo) {
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new Error('A gh label or milestone command needs the repository OWNER/REPO of origin.');
  return repo;
}

function checkText(label, value, { min = 0, max }) {
  if (typeof value !== 'string') throw new Error(`The ${label} needs a value.`);
  if (CONTROL.test(value)) throw new Error(`The ${label} must not hold control characters.`);
  if (value.startsWith('-')) throw new Error(`The ${label} must not start with a dash.`);
  if (value.length < min || value.length > max) throw new Error(`The ${label} must have ${min ? `${min} to ${max}` : `at most ${max}`} characters.`);
  const classes = scanText('value', value);
  if (classes.length) throw new Error(`The ${label} holds a secret (${classes.join(', ')}). Remove it.`);
  return value;
}

export function checkLabelName(value) {
  if (typeof value === 'string' && value !== value.trim()) throw new Error('The label name must not start or end with a space.');
  return checkText('label name', value, { min: 1, max: LABEL_NAME_MAX });
}
export function checkLabelColor(value) {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{6}$/.test(value)) throw new Error('The label color must be 6 hex digits, for example 0E8A16, without #.');
  return value;
}
export function checkLabelDescription(value) { return checkText('label description', value, { max: LABEL_DESCRIPTION_MAX }); }

// Split arguments into positional values and options. An option is --name VALUE or --name=VALUE.
function parseOptions(args, allowed, booleans = []) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token.slice(2) : token.slice(2, equals);
    if (booleans.includes(name)) {
      if (equals >= 0 || name in options) throw new Error(`Option --${name} is not valid here.`);
      options[name] = true;
      continue;
    }
    if (!allowed.includes(name)) throw new Error(`Unknown option: --${name}.`);
    if (name in options) throw new Error(`--${name} may be used only once.`);
    const value = equals < 0 ? args[++index] : token.slice(equals + 1);
    if (value === undefined) throw new Error(`--${name} needs a value.`);
    options[name] = value;
  }
  return { positional, options };
}

const refuseAction = (group, action) => new Error(`This action is not supported: ${group} ${action}. Herdr Boss never deletes a ${group}.`);

// The gh arguments for `herdr-boss gh label create|list|edit`.
export function buildGhLabelArgs(action, args, { repo } = {}) {
  const usage = 'Usage: gh label create NAME --color RRGGBB [--description TEXT] | gh label edit NAME [--color RRGGBB] [--description TEXT] [--new-name NAME] | gh label list | gh label sync --preset triage [--dry-run]';
  if (!action) throw new Error(usage);
  if (!['create', 'edit', 'list'].includes(action)) throw refuseAction('label', action);
  if (action === 'list') {
    if (args.length) throw new Error('gh label list takes no argument.');
    return ['label', 'list', `--repo=${checkRepo(repo)}`, '--limit', '1000'];
  }
  const { positional, options } = parseOptions(args, action === 'create' ? ['color', 'description'] : ['color', 'description', 'new-name']);
  if (positional.length !== 1) throw new Error(`gh label ${action} needs one name.`);
  const name = checkLabelName(positional[0]);
  if (action === 'create' && options.color === undefined) throw new Error('gh label create needs --color.');
  if (action === 'edit' && !Object.keys(options).length) throw new Error('gh label edit needs at least one of --color, --description, --new-name.');
  const flags = [`--repo=${checkRepo(repo)}`];
  if (options.color !== undefined) flags.push(`--color=${checkLabelColor(options.color)}`);
  if (options.description !== undefined) flags.push(`--description=${checkLabelDescription(options.description)}`);
  if (options['new-name'] !== undefined) flags.push(`--name=${checkLabelName(options['new-name'])}`);
  return ['label', action, ...flags, '--', name];
}

// The options of `gh label sync`.
export function parseLabelSync(args) {
  const { positional, options } = parseOptions(args, ['preset'], ['dry-run']);
  if (positional.length) throw new Error('gh label sync takes no name.');
  if (!options.preset) throw new Error('gh label sync needs --preset NAME.');
  return { preset: options.preset, dryRun: Boolean(options['dry-run']) };
}

function checkDueDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!date || date.toISOString().slice(0, 10) !== value) throw new Error('The due date must be a real date in the form YYYY-MM-DD.');
  return `${value}T00:00:00Z`;
}

// The gh arguments for `herdr-boss gh milestone create|list`. gh has no milestone command, so the calls use gh api.
export function buildGhMilestoneArgs(action, args, { repo } = {}) {
  if (!action) throw new Error('Usage: gh milestone create TITLE [--description TEXT] [--due YYYY-MM-DD] | gh milestone list');
  if (!['create', 'list'].includes(action)) throw refuseAction('milestone', action);
  const milestones = () => `repos/${checkRepo(repo)}/milestones`;
  if (action === 'list') {
    if (args.length) throw new Error('gh milestone list takes no argument.');
    return ['api', milestones(), '--method', 'GET', '-f', 'state=open', '--jq', '.[] | "\\(.number)\\t\\(.title)\\t\\(.due_on // "no due date")"'];
  }
  const { positional, options } = parseOptions(args, ['description', 'due']);
  if (positional.length !== 1) throw new Error('gh milestone create needs one title.');
  const title = checkText('milestone title', positional[0], { min: 1, max: MILESTONE_TITLE_MAX });
  const fields = [`title=${title}`];
  if (options.description !== undefined) fields.push(`description=${checkText('milestone description', options.description, { max: MILESTONE_DESCRIPTION_MAX })}`);
  if (options.due !== undefined) fields.push(`due_on=${checkDueDate(options.due)}`);
  return ['api', '--method', 'POST', milestones(), ...fields.flatMap((field) => ['-f', field])];
}

// The label presets are data in the kit folder: { preset: [{ name, color, description }] }.
export function loadLabelPreset(name, root = KIT_ROOT) {
  const presets = JSON.parse(fs.readFileSync(path.join(root, 'kit', 'label-presets.json'), 'utf8'));
  if (!Object.hasOwn(presets, name)) throw new Error(`Unknown label preset: ${String(name)}. Known presets: ${Object.keys(presets).join(', ')}.`);
  return presets[name].map((label) => ({ name: checkLabelName(label.name), color: checkLabelColor(label.color), description: checkLabelDescription(label.description) }));
}

// The plan of a sync: one step for each preset label. existing is the output of `gh label list --json name,color,description`.
// GitHub names are not case sensitive, and a color is compared without case.
export function planLabelSync(preset, existing) {
  const byName = new Map(existing.map((label) => [String(label.name).toLowerCase(), label]));
  return preset.map((label) => {
    const found = byName.get(label.name.toLowerCase());
    if (!found) return { action: 'create', label };
    const same = String(found.color ?? '').toLowerCase() === label.color.toLowerCase() && (found.description ?? '') === label.description;
    return { action: same ? 'ok' : 'edit', label, existing: found };
  });
}
