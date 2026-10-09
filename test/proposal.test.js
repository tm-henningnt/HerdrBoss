import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runKitCommand } from '../src/kit/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

const VALID_PROPOSAL = `## What
Add a project proposal checker.

## Why
The Owner needs a clear proposal format.

## Cost
Lane: codex
Size: small

## Recommendation
Accept this work.

## Choices
- Accept
- Deny
`;

function proposalFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-proposal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'proposal.md');
  fs.writeFileSync(file, content);
  return file;
}

test('proposal validator accepts the required headings, lane, size, and exact choices', async () => {
  const { validateProposalFile } = await import('../src/kit/proposal.js');
  assert.deepEqual(validateProposalFile(VALID_PROPOSAL), []);
});

test('proposal validator reports missing headings and choices and rejects extra choices', async () => {
  const { validateProposalFile } = await import('../src/kit/proposal.js');
  const errors = validateProposalFile(`## What
Do the work.
## Cost
Lane: codex
## Recommendation
Accept.
## Choices
- Accept
- Later
`);

  assert.ok(errors.some((error) => /missing heading: Why/i.test(error)));
  assert.ok(errors.some((error) => /missing cost field: Size/i.test(error)));
  assert.ok(errors.some((error) => /missing choice: Deny/i.test(error)));
  assert.ok(errors.some((error) => /choices must be exactly Accept and Deny/i.test(error)));
});

test('proposal validator requires text in the What, Why, and Recommendation sections', async () => {
  const { validateProposalFile } = await import('../src/kit/proposal.js');
  const errors = validateProposalFile(`## What

## Why

## Cost
Lane: codex
Size: small

## Recommendation

## Choices
- Accept
- Deny
`);

  for (const heading of ['What', 'Why', 'Recommendation']) {
    assert.ok(errors.some((error) => new RegExp(`missing content: ${heading}`, 'i').test(error)));
  }
});

test('proposal check accepts a complete file and prints a clear result', (t) => {
  const file = proposalFile(t, VALID_PROPOSAL);
  const output = [];
  const result = runKitCommand('proposal', ['check', file], { output: (line) => output.push(line) });

  assert.equal(result.valid, true);
  assert.deepEqual(output, ['Proposal file is valid.']);
});

test('proposal check returns a failing exit code and lists missing fields', (t) => {
  const file = proposalFile(t, '## What\nDo this.\n');

  assert.throws(() => runKitCommand('proposal', ['check', file], { output: () => {} }), (error) => {
    assert.equal(error.exitCode, 1);
    assert.match(error.message, /missing heading: Why/i);
    assert.match(error.message, /missing choice: Accept/i);
    return true;
  });
});

test('the top-level CLI routes proposal check to the kit command handler', (t) => {
  const file = proposalFile(t, VALID_PROPOSAL);
  const result = spawnSync(process.execPath, [CLI, 'proposal', 'check', file], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Proposal file is valid\./);
});
