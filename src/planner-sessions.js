// The planner session registry: a small local file in the data dir. See docs/cli.md, section Planner sessions.
// A record has the session id, the project slug, the pane id, the kind, the input path, and the start time.
// A pane with an active session may run `review publish` for its own project. The module has no Herdr or Mailbox code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { SLUG } from './projects.js';

export const PLANNER_LABEL = 'planner';
const FILE = 'planner-sessions.json';
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const PANE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const INPUT_MAX = 512;

export const sessionsFile = (dir = DATA_DIR) => path.join(dir, FILE);

function read(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(sessionsFile(dir), 'utf8'));
    return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.id === 'string') : [];
  } catch { return []; }
}

// Write through a temporary file, so a crash never leaves half a registry.
function write(dir, list) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = sessionsFile(dir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
}

const stamp = (now) => new Date(now).toISOString();

// Start a session. `input` is the path of the document that the planner works from. It is text only; Herdr Boss never reads it.
export function startSession({ dir = DATA_DIR, now = Date.now(), kind, project, pane, input } = {}) {
  if (typeof project !== 'string' || !SLUG.test(project)) throw new Error('The project slug must match [a-z0-9][a-z0-9-]* and have at most 64 characters.');
  if (typeof kind !== 'string' || !KIND.test(kind)) throw new Error('The kind must match [a-z][a-z0-9-]* and have at most 32 characters.');
  if (typeof pane !== 'string' || !PANE.test(pane)) throw new Error('The pane must be a Herdr pane ID.');
  if (typeof input !== 'string' || !input.trim() || input.length > INPUT_MAX || input.includes('\0')) throw new Error(`The input path must be 1 to ${INPUT_MAX} characters.`);
  const list = read(dir);
  const active = list.find((entry) => entry.pane === pane && !entry.endedAt);
  if (active) throw new Error(`The pane ${pane} already has the active planner session ${active.id}. Run herdr-boss plan end ${active.id} first.`);
  const id = `ps-${crypto.randomBytes(4).toString('hex')}`;
  const session = { id, project, pane, kind, input, startedAt: stamp(now), round: 0, endedAt: null };
  write(dir, [...list, session]);
  return session;
}

export const getSession = ({ dir = DATA_DIR, id } = {}) => read(dir).find((entry) => entry.id === id) ?? null;

// The sessions that are active, or all of them. `project` limits the list to one project.
export function listSessions({ dir = DATA_DIR, project, all = false } = {}) {
  return read(dir).filter((entry) => (all || !entry.endedAt) && (project === undefined || entry.project === project));
}

export const activeSessionForPane = ({ dir = DATA_DIR, pane } = {}) => read(dir).find((entry) => entry.pane === pane && !entry.endedAt) ?? null;

export function endSession({ dir = DATA_DIR, now = Date.now(), id } = {}) {
  const list = read(dir);
  const session = list.find((entry) => entry.id === id);
  if (!session) return null;
  if (!session.endedAt) {
    session.endedAt = stamp(now);
    write(dir, list);
  }
  return session;
}

// The round counts the packs that the session published. It moves forward only.
export function setRound({ dir = DATA_DIR, id, round } = {}) {
  const list = read(dir);
  const session = list.find((entry) => entry.id === id);
  if (!session) throw new Error(`No planner session ${id}.`);
  if (!Number.isInteger(round) || round <= session.round) throw new Error(`The round must be a whole number above ${session.round}.`);
  session.round = round;
  write(dir, list);
  return session;
}
