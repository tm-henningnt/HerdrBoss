#!/usr/bin/env node
// Seed invented Mailbox and Chat messages into a temporary data directory for a dashboard preview.
// Usage: HERDR_BOSS_DIR=$(mktemp -d) HOME=$(mktemp -d) node scripts/seed-preview.js
import { pathToFileURL } from 'node:url';
import { assertTempDataDir } from '../src/data-dir-guard.js';
import { DATA_DIR } from '../src/config.js';
import { openMessageStore } from '../src/message-store.js';

const MINUTE = 60 * 1000;

const SAMPLES = [
  { thread: 'demo', from: 'owner', to: 'orch', kind: 'message', text: 'Sample: start the next task.', status: 'sent' },
  { thread: 'demo', from: 'orch', to: 'owner', kind: 'reply', text: 'Sample: the task is running.', status: 'new' },
  { thread: 'demo', from: 'orch', to: 'owner', kind: 'reply', text: 'Sample: approve the merge?', action: 'approve', status: 'new' },
  { thread: 'demo', from: 'orch', to: 'owner', kind: 'report', text: 'Sample report: all sample tests pass.', action: 'read', status: 'new' },
  { thread: 'boss', from: 'owner', to: 'boss', kind: 'message', text: 'Sample: show the project status.', status: 'sent' },
  { thread: 'boss', from: 'boss', to: 'owner', kind: 'reply', text: 'Sample: two sample projects are active.', status: 'new' },
];

// Write the sample records into dir and return the number of records written.
export function seedPreview(dir, { now = Date.now() } = {}) {
  const safe = assertTempDataDir(dir);
  const store = openMessageStore({ dir: safe });
  SAMPLES.forEach((fields, index) => store.append(fields, { now: now - (SAMPLES.length - index) * MINUTE }));
  return SAMPLES.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const count = seedPreview(DATA_DIR);
    console.log(`Seeded ${count} sample messages into ${DATA_DIR}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
