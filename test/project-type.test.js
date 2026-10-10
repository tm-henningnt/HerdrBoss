import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProjectTypeCatalog, validateProjectTypeFolder, validateProjectLicenseMode } from '../src/project-type.js';
import { projectTypeCommand } from '../src/project-type-cli.js';
import { projectCommand } from '../src/project-new-cli.js';

const TYPES_ROOT = path.resolve('kit/project-types');

function makeManifest(overrides = {}) {
  return {
    schema: 'herdr-boss.project-type/1',
    id: 'widget',
    title: 'Widget project',
    version: '1.0.0',
    default: false,
    templateRepository: null,
    setupSteps: [{ id: 'copy', operation: 'copy-template' }],
    templates: ['template/README.md'],
    agentsSections: [{ id: 'rules', file: 'agents/rules.md', heading: 'Widget rules' }],
    gates: [{ id: 'build', command: 'npm run build', expectedOutput: 'exit code 0' }],
    trackerPreset: {
      triageLabels: ['ready'],
      stateLabels: { open: 'open', inProgress: 'doing', blocked: 'blocked', done: 'done' },
    },
    releaseFlow: {
      repository: 'example/widget-releases',
      approvalStep: 'mailbox',
      scanRules: ['no-private-inputs'],
      assets: ['release/README.md'],
      checklist: 'release/checklist.md',
    },
    settings: [{ name: 'theme', type: 'string', default: 'light', projectEditable: true }],
    checks: [{ id: 'source', files: ['template/README.md'], script: 'checks/verify.js', settings: ['theme'], versions: { node: '26' } }],
    requiredInputs: [{ id: 'prd', kind: 'document', required: false, destination: 'private-inputs/prd.md' }],
    licenseMode: { values: ['display-warning', 'block-use', 'skip-check'], default: 'block-use' },
    ...overrides,
  };
}

function writeType(root, name, manifest = makeManifest()) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const relative of [
    ...(manifest.templates ?? []),
    ...(manifest.agentsSections ?? []).map(({ file }) => file),
    ...(manifest.checks ?? []).flatMap(({ files = [], script }) => [...files, ...(script ? [script] : [])]),
    ...(manifest.releaseFlow?.assets ?? []),
    ...(manifest.releaseFlow?.checklist ? [manifest.releaseFlow.checklist] : []),
  ]) {
    if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..')) continue;
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Sample type file.\n');
  }
  return folder;
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-project-type-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the generic type manifest validates as the default type', () => {
  const { manifest } = validateProjectTypeFolder(path.join(TYPES_ROOT, 'generic'));
  assert.equal(manifest.id, 'generic');
  assert.equal(manifest.default, true);
  assert.equal(validateProjectLicenseMode(manifest, { licenseMode: manifest.licenseMode.default }), 'none');
});

test('a new valid type folder validates without a source change', (t) => {
  const folder = writeType(tempRoot(t), 'widget');
  const { manifest } = validateProjectTypeFolder(folder);
  assert.equal(manifest.id, 'widget');
  assert.deepEqual(manifest.licenseMode.values, ['display-warning', 'block-use', 'skip-check']);
});

test('unknown manifest fields are rejected at every schema level', (t) => {
  const root = tempRoot(t);
  const top = makeManifest({ unexpected: true });
  const folder = writeType(root, 'top-field', top);
  assert.throws(() => validateProjectTypeFolder(folder), /unknown field.*unexpected/i);

  const nested = makeManifest({ trackerPreset: { triageLabels: [], stateLabels: { open: 'open', inProgress: 'doing', blocked: 'blocked', done: 'done' }, extra: true } });
  const nestedFolder = writeType(root, 'nested-field', nested);
  assert.throws(() => validateProjectTypeFolder(nestedFolder), /unknown field.*extra/i);
});

test('an unsupported manifest schema version is rejected', (t) => {
  const folder = writeType(tempRoot(t), 'wrong-schema', makeManifest({ schema: 'herdr-boss.project-type/2' }));
  assert.throws(() => validateProjectTypeFolder(folder), /unsupported value/i);
});

test('unsafe type-folder and project destination paths are rejected', (t) => {
  const root = tempRoot(t);
  for (const [index, value] of ['/absolute/file.md', '../outside.md', 'template/../outside.md', 'C:\\private\\file.md'].entries()) {
    const folder = writeType(root, `unsafe-${index}`, makeManifest({ templates: [value] }));
    assert.throws(() => validateProjectTypeFolder(folder), /unsafe path/i, value);
  }
  const destinationFolder = writeType(root, 'unsafe-destination', makeManifest({
    requiredInputs: [{ id: 'prd', kind: 'document', required: false, destination: '../private/prd.md' }],
  }));
  assert.throws(() => validateProjectTypeFolder(destinationFolder), /unsafe path/i);
});

test('every file named by a manifest must exist as a file', (t) => {
  const folder = writeType(tempRoot(t), 'missing', makeManifest());
  fs.rmSync(path.join(folder, 'checks/verify.js'));
  assert.throws(() => validateProjectTypeFolder(folder), /missing named file/i);
});

test('unsupported setup operations are rejected', (t) => {
  const folder = writeType(tempRoot(t), 'unsupported', makeManifest({ setupSteps: [{ id: 'run', operation: 'run-command' }] }));
  assert.throws(() => validateProjectTypeFolder(folder), /operation/i);
});

test('a type catalog rejects duplicate IDs and multiple defaults', (t) => {
  const duplicateRoot = tempRoot(t);
  writeType(duplicateRoot, 'first', makeManifest({ id: 'same', default: true }));
  writeType(duplicateRoot, 'second', makeManifest({ id: 'same', default: false }));
  assert.throws(() => validateProjectTypeCatalog(duplicateRoot), /duplicate type id/i);

  const defaultsRoot = tempRoot(t);
  writeType(defaultsRoot, 'first', makeManifest({ id: 'first', default: true }));
  writeType(defaultsRoot, 'second', makeManifest({ id: 'second', default: true }));
  assert.throws(() => validateProjectTypeCatalog(defaultsRoot), /one default/i);
});

test('project license modes accept the type-declared string set', (t) => {
  const folder = writeType(tempRoot(t), 'license-modes');
  const { manifest } = validateProjectTypeFolder(folder);
  assert.equal(validateProjectLicenseMode(manifest, { licenseMode: 'display-warning' }), 'display-warning');
  assert.equal(validateProjectLicenseMode(manifest, { licenseMode: 'skip-check' }), 'skip-check');
  assert.equal(validateProjectLicenseMode(manifest, {}), 'block-use');
  assert.throws(() => validateProjectLicenseMode(manifest, { licenseMode: 'unlisted' }), /declared by the type/i);
});

test('project type check validates a folder from the project command', () => {
  const output = [];
  assert.equal(projectCommand(['type', 'check', path.join(TYPES_ROOT, 'generic')], { log: (line) => output.push(line) }), 0);
  assert.match(output.join('\n'), /generic.*valid/i);
});

test('project type check sends validation errors to stderr and returns one', (t) => {
  const folder = writeType(tempRoot(t), 'invalid-cli', makeManifest({ schema: 'unknown' }));
  const errors = [];
  assert.equal(projectTypeCommand(['check', folder], { log: () => {}, error: (line) => errors.push(line) }), 1);
  assert.match(errors.join('\n'), /invalid:.*unsupported value/i);
});
