// A small YAML reader for the GitHub Actions fields used by project check and push.
// It reads only the workflow triggers, concurrency, job names, runners, and matrices.
const KNOWN_EVENTS = new Set(['push', 'pull_request', 'schedule', 'workflow_dispatch', 'release']);
const QUICK_WORD = /quick|changed|affected|lint/i;
const DOCS_DIRS = ['docs', '.orchestration'];

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"' && char === '"' && !escaped) quote = null;
    else if (quote === "'" && char === "'") {
      if (line[index + 1] === "'") index += 1;
      else quote = null;
    } else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  return line;
}

function yamlLines(text) {
  return String(text ?? '').split(/\r?\n/u).map((raw) => {
    const line = stripComment(raw);
    if (!line.trim()) return null;
    const indent = line.match(/^ */u)[0].length;
    return { indent, text: line.slice(indent).trimEnd() };
  }).filter(Boolean);
}

function splitFlow(value) {
  const parts = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && char === '"' && !escaped) quote = null;
    else if (quote === "'" && char === "'") {
      if (value[index + 1] === "'") index += 1;
      else quote = null;
    } else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && (char === '[' || char === '{')) depth += 1;
    else if (!quote && (char === ']' || char === '}')) depth -= 1;
    else if (!quote && depth === 0 && char === ',') {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function flowColon(value) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && char === '"') quote = null;
    else if (quote === "'" && char === "'") quote = null;
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && (char === '[' || char === '{')) depth += 1;
    else if (!quote && (char === ']' || char === '}')) depth -= 1;
    else if (!quote && depth === 0 && char === ':') return index;
  }
  return -1;
}

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'") return text.slice(1, -1).replaceAll("''", "'");
  if (text.length >= 2 && text[0] === '"' && text.at(-1) === '"') {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  return text;
}

function parseInline(value) {
  const text = value.trim();
  if (text.startsWith('[') && text.endsWith(']')) return splitFlow(text.slice(1, -1)).map(parseInline);
  if (text.startsWith('{') && text.endsWith('}')) {
    const result = {};
    for (const part of splitFlow(text.slice(1, -1))) {
      const colon = flowColon(part);
      if (colon < 0) continue;
      result[unquote(part.slice(0, colon))] = parseInline(part.slice(colon + 1));
    }
    return result;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~' || text === '') return null;
  return unquote(text);
}

function keyValue(line) {
  const colon = flowColon(line);
  if (colon < 0) return null;
  return { key: unquote(line.slice(0, colon)), value: line.slice(colon + 1).trim() };
}

function asList(value) {
  if (Array.isArray(value)) return value.flatMap(asList);
  if (value === null || value === undefined || value === false) return [];
  return [value];
}

function addEvent(events, name, config = {}) {
  const event = unquote(String(name)).toLowerCase();
  if (!KNOWN_EVENTS.has(event)) return;
  const normalized = {};
  for (const key of ['branches', 'branches-ignore', 'paths-ignore', 'paths']) {
    if (Object.hasOwn(config ?? {}, key)) normalized[key] = asList(config[key]).map((value) => unquote(String(value)));
  }
  events.set(event, normalized);
}

function parseEventBlock(lines, start, eventIndent, config = {}) {
  const event = { ...config };
  let index = start;
  while (index < lines.length && lines[index].indent > eventIndent) {
    const line = lines[index];
    const pair = keyValue(line.text);
    if (!pair || !['branches', 'branches-ignore', 'paths-ignore', 'paths'].includes(pair.key)) {
      index += 1;
      continue;
    }
    if (pair.value) {
      event[pair.key] = parseInline(pair.value);
      index += 1;
      continue;
    }
    const list = [];
    let next = index + 1;
    while (next < lines.length && lines[next].indent > line.indent) {
      const item = lines[next];
      if (item.text.startsWith('- ')) list.push(parseInline(item.text.slice(2)));
      next += 1;
    }
    event[pair.key] = list;
    index = next;
  }
  return event;
}

function parseTriggers(lines) {
  const events = new Map();
  const start = lines.findIndex((line) => line.indent === 0 && /^(?:on|['"]on['"]):(?:\s|$)/u.test(line.text));
  if (start < 0) return events;
  const root = keyValue(lines[start].text);
  const inline = root?.value ? parseInline(root.value) : null;
  if (typeof inline === 'string') addEvent(events, inline);
  else if (Array.isArray(inline)) for (const event of inline) addEvent(events, event);
  else if (inline && typeof inline === 'object') {
    for (const [name, config] of Object.entries(inline)) addEvent(events, name, config && typeof config === 'object' ? config : {});
  }
  if (inline !== null) return events;

  let end = start + 1;
  while (end < lines.length && lines[end].indent > lines[start].indent) end += 1;
  if (end === start + 1) return events;
  const body = lines.slice(start + 1, end);
  const baseIndent = Math.min(...body.map((line) => line.indent));
  if (body[0].indent === baseIndent && body[0].text.startsWith('- ')) {
    for (const item of body) if (item.indent === baseIndent && item.text.startsWith('- ')) addEvent(events, parseInline(item.text.slice(2)));
    return events;
  }
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    if (line.indent !== baseIndent) continue;
    const pair = keyValue(line.text);
    if (!pair) continue;
    if (pair.value) {
      const config = parseInline(pair.value);
      addEvent(events, pair.key, config && typeof config === 'object' ? config : {});
      continue;
    }
    addEvent(events, pair.key, parseEventBlock(body, index + 1, baseIndent));
  }
  return events;
}

function globMatches(pattern, value) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*');
  try { return new RegExp(`^${escaped}$`, 'u').test(value); } catch { return pattern === value; }
}

function branchIncluded(config, branch) {
  const patterns = asList(config.branches).map((value) => String(value));
  let included = patterns.length === 0;
  for (const raw of patterns) {
    const exclude = raw.startsWith('!');
    const pattern = exclude ? raw.slice(1) : raw;
    if (globMatches(pattern, branch)) included = !exclude;
  }
  const ignored = asList(config['branches-ignore']).some((pattern) => globMatches(String(pattern), branch));
  return included && !ignored;
}

function runsOnMain(events) {
  const push = events.get('push');
  return Boolean(push && ['main', 'master'].some((branch) => branchIncluded(push, branch)));
}

function coversDirectory(patterns, directory) {
  const accepted = new Set([
    `${directory}/**`,
    `${directory}/**/*`,
    `**/${directory}/**`,
    `**/${directory}/**/*`,
  ]);
  return asList(patterns).some((pattern) => accepted.has(String(pattern).replace(/^!/, '')) || String(pattern) === '**');
}

function hasDocsPathFilter(events) {
  const relevant = ['push', 'pull_request'].filter((name) => events.has(name));
  return relevant.length > 0 && relevant.every((name) => DOCS_DIRS.every((directory) => {
    const config = events.get(name);
    return coversDirectory(config['paths-ignore'], directory) || coversDirectory(config.paths, directory);
  }));
}

function hasCancelConcurrency(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const pair = keyValue(line.text);
    if (pair?.key !== 'concurrency') continue;
    if (pair.value) {
      const block = parseInline(pair.value);
      if (block && typeof block === 'object' && block['cancel-in-progress'] === true) return true;
    }
    let next = index + 1;
    while (next < lines.length && lines[next].indent > line.indent) {
      const item = keyValue(lines[next].text);
      if (item?.key === 'cancel-in-progress' && parseInline(item.value) === true) return true;
      next += 1;
    }
  }
  return false;
}

function jobNames(lines) {
  const names = [];
  for (let index = 0; index < lines.length; index += 1) {
    const jobs = lines[index];
    if (jobs.indent !== 0 || keyValue(jobs.text)?.key !== 'jobs') continue;
    let end = index + 1;
    while (end < lines.length && lines[end].indent > jobs.indent) end += 1;
    const body = lines.slice(index + 1, end);
    const jobIndent = Math.min(...body.map((line) => line.indent));
    for (const line of body) {
      const pair = keyValue(line.text);
      if (!pair) continue;
      if (line.indent === jobIndent) names.push(pair.key);
      else if (line.indent === jobIndent + 2 && pair.key === 'name' && pair.value) names.push(String(parseInline(pair.value)));
    }
    index = end - 1;
  }
  return names;
}

function hasMatrix(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (keyValue(line.text)?.key !== 'strategy') continue;
    let next = index + 1;
    while (next < lines.length && lines[next].indent > line.indent) {
      if (keyValue(lines[next].text)?.key === 'matrix') return true;
      next += 1;
    }
  }
  return false;
}

function hasNonLinuxRunner(lines) {
  return lines.some((line) => {
    const pair = keyValue(line.text);
    if (pair?.key !== 'runs-on' || !pair.value) return false;
    const runners = asList(parseInline(pair.value)).map(String);
    return runners.some((runner) => !runner.startsWith('ubuntu-'));
  });
}

function finding(id, file, message, hint) {
  return { id, file, level: 'warn', message, hint };
}

const PUSH_HINT = 'Use a quick check on pull requests and run the full gate by hand or on release.';

export function lintWorkflows(files, { privateRepo } = {}) {
  const findings = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string') continue;
    const lines = yamlLines(file.text);
    const events = parseTriggers(lines);
    const jobs = jobNames(lines);
    const fastName = QUICK_WORD.test(file.path) || jobs.some((name) => QUICK_WORD.test(name));
    if (runsOnMain(events) && !fastName) findings.push(finding('push-main-full', file.path,
      'This workflow runs a full check on each push to main.', PUSH_HINT));
    if (privateRepo === true && events.has('schedule')) findings.push(finding('schedule-private', file.path,
      'This private repository has a scheduled workflow.', 'Remove the schedule and run the full gate by hand or on release.'));
    if (!hasCancelConcurrency(lines)) findings.push(finding('no-concurrency', file.path,
      'This workflow does not cancel an older run when a new run starts.', 'Add a concurrency group and set cancel-in-progress to true.'));
    if ((events.has('push') || events.has('pull_request')) && !hasDocsPathFilter(events)) findings.push(finding('no-paths-ignore', file.path,
      'This workflow can run for docs and .orchestration changes.', 'Add paths-ignore for docs/** and .orchestration/**.'));
    if (hasMatrix(lines) || hasNonLinuxRunner(lines)) findings.push(finding('matrix-or-non-linux', file.path,
      'This workflow uses a matrix or a runner that costs more Actions minutes.', 'Use one ubuntu runner without a matrix.'));
  }
  return findings;
}

export function workflowPushesBranch(files, branch) {
  if (!['main', 'master'].includes(branch)) return false;
  return (Array.isArray(files) ? files : []).some((file) => {
    if (!file || typeof file.text !== 'string') return false;
    const events = parseTriggers(yamlLines(file.text));
    return events.has('push') && branchIncluded(events.get('push'), branch);
  });
}
