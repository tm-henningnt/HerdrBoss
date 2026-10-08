import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeLifecyclePort } from '../src/kit/lifecycle.js';
import { lifecyclePort, setLifecyclePort } from '../src/kit/lifecycle-port.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const LIFECYCLE_MODULES = new Set([
  'git-pins.js',
  'kit/locks.js',
  'kit/workers.js',
  'leases.js',
]);

function sourceFiles(directory, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(directory, child));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(child.split(path.sep).join('/'));
  }
  return files;
}

function moduleSpecifiers(source) {
  const imports = [];
  const expressions = [
    /^\s*import\s+(?:[^'";]*?\s+from\s*)?(['"])(\.[^'"]+)\1\s*;?/gm,
    /^\s*export\s+(?:\*|\*\s+as\s+\w+|\{[^}]*\})\s+from\s+(['"])(\.[^'"]+)\1\s*;?/gm,
    /\bimport\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/gm,
  ];
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) imports.push(match[2]);
  }
  return imports;
}

function graphFromSources(sources) {
  const files = new Set(Object.keys(sources));
  return new Map(Object.entries(sources).map(([file, source]) => {
    const edges = moduleSpecifiers(source)
      .map((specifier) => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)))
      .filter((target) => files.has(target));
    return [file, edges];
  }));
}

function importGraph() {
  const files = sourceFiles(SRC);
  const known = new Set(files.map((file) => path.resolve(SRC, file)));
  const graph = new Map();
  for (const file of files) {
    const absolute = path.resolve(SRC, file);
    const source = fs.readFileSync(absolute, 'utf8');
    const edges = moduleSpecifiers(source)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => path.resolve(path.dirname(absolute), specifier))
      .filter((target) => known.has(target));
    graph.set(absolute, edges);
  }
  return graph;
}

function findCycles(graph) {
  const cycles = [];
  const nodes = [...graph.keys()].sort();
  for (const start of nodes) {
    const pathNodes = [start];
    const active = new Set(pathNodes);
    function visit(current) {
      for (const next of graph.get(current) ?? []) {
        if (!graph.has(next)) continue;
        if (next === start) {
          cycles.push([...pathNodes, start]);
        } else if (next > start && !active.has(next)) {
          active.add(next);
          pathNodes.push(next);
          visit(next);
          pathNodes.pop();
          active.delete(next);
        }
      }
    }
    visit(start);
  }
  return cycles;
}

function displayCycles(cycles, base = '') {
  return cycles.map((cycle) => cycle.map((file) => base ? path.relative(base, file) : file).join(' -> '));
}

test('import graph finds imports, re-exports, dynamic imports, and self-cycles', () => {
  const cycleBackEdge = "import './a.js';";
  const fixtures = [
    ['static import', "import './b.js';"],
    ['re-export', "export { value } from './b.js';"],
    ['dynamic import', "void import('./b.js');"],
  ];
  for (const [form, declaration] of fixtures) {
    const graph = graphFromSources({ 'a.js': declaration, 'b.js': cycleBackEdge });
    assert.deepEqual(displayCycles(findCycles(graph)), ['a.js -> b.js -> a.js'], `${form} cycle`);
  }

  const selfCycle = graphFromSources({ 'a.js': "import './a.js';" });
  assert.deepEqual(displayCycles(findCycles(selfCycle)), ['a.js -> a.js'], 'self-cycle');
});

test('module imports do not cycle through Git pins, locks, workers, and leases', () => {
  const graph = importGraph();
  const modules = new Set([...LIFECYCLE_MODULES].map((file) => path.resolve(SRC, file)));
  for (const module of modules) assert.ok(graph.has(module), `${path.relative(SRC, module)} must exist`);
  const cycles = findCycles(graph).filter((cycle) => cycle.some((file) => modules.has(file)));
  const display = displayCycles(cycles, SRC);
  assert.deepEqual(display, [], `module import cycles found:\n${display.join('\n')}`);
});

test('startup sets one lifecycle port for locks, workers, and leases', () => {
  const port = initializeLifecyclePort();
  assert.equal(port, lifecyclePort());
  assert.equal(initializeLifecyclePort(), port);
  assert.throws(() => setLifecyclePort({ ...port }), /already set/);
  assert.equal(lifecyclePort(), port);
  assert.deepEqual(Object.keys(port).sort(), [
    'acquireLeaseFor',
    'createHerdrRunner',
    'dropLeases',
    'portEnvStatus',
    'setLeasePane',
    'verifyCallerPane',
  ]);
});

test('test setup does not load config before a test sets its data directories', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = path.join(os.tmpdir(), `arch6-test-env-${randomUUID()}.test.js`);
  const helper = pathToFileURL(path.join(root, 'test/helpers/test-env.js')).href;
  const configUrl = pathToFileURL(path.join(root, 'src/config.js')).href;
  const dataDir = path.join(os.tmpdir(), `arch6-data-${randomUUID()}`);
  const liveDir = path.join(os.tmpdir(), `arch6-live-${randomUUID()}`);
  fs.writeFileSync(fixture, `
    import '${helper}';
    import assert from 'node:assert/strict';
    import test from 'node:test';
    process.env.HERDR_BOSS_DIR = ${JSON.stringify(dataDir)};
    process.env.HERDR_BOSS_LIVE_DIR = ${JSON.stringify(liveDir)};
    const config = await import(${JSON.stringify(configUrl)});
    test('the helper leaves per-file data paths available', () => {
      assert.equal(config.DATA_DIR, process.env.HERDR_BOSS_DIR);
      assert.equal(config.LIVE_DATA_DIR, process.env.HERDR_BOSS_LIVE_DIR);
    });
  `);
  try {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', fixture], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
});

test('an Engine initializes the lifecycle port for a direct caller', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { Engine } from './src/engine.js';
    import { lifecyclePort } from './src/kit/lifecycle-port.js';
    new Engine({ push: false }, { push: false, act: false });
    assert.equal(typeof lifecyclePort().verifyCallerPane, 'function');
  `;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
