import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTempDir } from './helpers/test-env.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const realHome = path.resolve(os.userInfo().homedir || os.homedir());
const realDataDir = path.resolve(path.join(realHome, '.herdr-boss'));
// Every module that reads the data directory at load time or as a default. A test file that loads one of them must
// import ./helpers/test-env.js first, so a direct `node --test test/<file>.js` run cannot freeze the live data dir.
const riskyModules = new Set([
  '../src/engine.js',
  '../src/project-new.js',
  '../src/messages.js',
  '../src/config.js',
  '../src/server.js',
  '../src/message-store.js',
  '../src/leases.js',
  '../src/analytics.js',
  '../src/spend.js',
  '../src/denials.js',
  '../src/handoff.js',
  '../src/agent-messages.js',
  '../src/collect.js',
  '../src/task-state.js',
  '../src/sqlite-store.js',
  '../src/review-store.js',
  '../src/kit/workers.js',
  '../src/kit/locks.js',
  '../src/harness.js',
]);

test('test environment uses temporary home and data paths', () => {
  assert.ok(isTempDir(process.env.HOME), `HOME must be inside ${os.tmpdir()}`);
  assert.ok(isTempDir(process.env.HERDR_BOSS_DIR), `HERDR_BOSS_DIR must be inside ${os.tmpdir()}`);
  assert.ok(isTempDir(process.env.HERDR_BOSS_LIVE_DIR), `HERDR_BOSS_LIVE_DIR must be inside ${os.tmpdir()}`);
  assert.notEqual(path.resolve(process.env.HOME), realHome);
  assert.notEqual(path.resolve(process.env.HERDR_BOSS_DIR), realDataDir);
  assert.notEqual(path.resolve(process.env.HERDR_BOSS_LIVE_DIR), realDataDir);
});

test('static imports of data-directory modules have the test environment helper first', () => {
  const offenders = [];
  const files = fs.readdirSync(testDir).filter((name) => name.endsWith('.test.js'));

  for (const name of files) {
    const source = fs.readFileSync(path.join(testDir, name), 'utf8');
    const lines = source.split(/\r?\n/);
    const firstImport = lines.find((line) => /^import\b/.test(line));
    const staticImports = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (!/^import\b/.test(lines[index]) || /^import\s*\(/.test(lines[index])) continue;
      let statement = lines[index];
      while (!/\bfrom\s*['"]/.test(statement) && index + 1 < lines.length) {
        statement += `\n${lines[++index]}`;
      }
      const specifier = statement.match(/\bfrom\s*['"]([^'"]+)['"]/)?.[1]
        ?? statement.match(/^import\s*['"]([^'"]+)['"]/)?.[1];
      if (specifier) staticImports.push(specifier);
    }

    if ([...riskyModules].some((specifier) => staticImports.includes(specifier))
      && firstImport !== "import './helpers/test-env.js';") {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, [], `Import ./helpers/test-env.js first in: ${offenders.join(', ')}`);
});
