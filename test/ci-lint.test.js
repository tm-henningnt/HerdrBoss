import assert from 'node:assert/strict';
import test from 'node:test';
import { lintWorkflows, workflowPushesBranch } from '../src/ci-lint.js';

const clean = `name: Quick check
on:
  pull_request:
    paths-ignore: [docs/**, .orchestration/**]
  push:
    branches: [main]
    paths-ignore:
      - docs/**
      - .orchestration/**
  workflow_dispatch:
jobs:
  quick:
    name: Quick lint
    runs-on: ubuntu-latest
concurrency:
  group: ci-${'${{ github.workflow }}'}-${'${{ github.ref }}'}
  cancel-in-progress: true
`;

const findingIds = (files, options = {}) => lintWorkflows(files, options).map((finding) => finding.id);

test('a clean workflow has no findings', () => {
  assert.deepEqual(lintWorkflows([{ path: '.github/workflows/quick.yml', text: clean }]), []);
});

test('push-main-full warns for a full main push workflow', () => {
  const text = clean.replace('name: Quick check', 'name: Full verification').replace('  quick:', '  verify:').replace('name: Quick lint', 'name: Verify')
    .replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    steps:\n      - name: lint sources');
  const findings = lintWorkflows([{ path: '.github/workflows/verify.yml', text }]);
  assert.deepEqual(findings.map(({ id }) => id), ['push-main-full']);
  assert.ok(findings[0].message && findings[0].hint);
  assert.equal(findings[0].level, 'warn');
  assert.ok(!findingIds([{ path: '.github/workflows/changed-files.yml', text }]).includes('push-main-full'));
});

test('push-main-full warns for master and for an unfiltered push', () => {
  const master = clean.replace('branches: [main]', 'branches: [master]').replaceAll('Quick', 'Verify').replace('name: Verify lint', 'name: Verify').replace('  quick:', '  verify:').replace('quick.yml', 'verify.yml');
  const allBranches = clean.replace('    branches: [main]\n', '').replaceAll('Quick', 'Verify').replace('name: Verify lint', 'name: Verify').replace('  quick:', '  verify:').replace('quick.yml', 'verify.yml');
  assert.ok(findingIds([{ path: '.github/workflows/verify.yml', text: master }]).includes('push-main-full'));
  assert.ok(findingIds([{ path: '.github/workflows/verify.yml', text: allBranches }]).includes('push-main-full'));
});

test('schedule-private warns only when privacy is known to be private', () => {
  const scheduled = clean.replace('  workflow_dispatch:', '  schedule:\n    - cron: "0 0 * * *"\n  workflow_dispatch:');
  const file = { path: '.github/workflows/quick.yml', text: scheduled };
  assert.ok(findingIds([file], { privateRepo: true }).includes('schedule-private'));
  assert.ok(!findingIds([file], { privateRepo: false }).includes('schedule-private'));
  assert.ok(!findingIds([file]).includes('schedule-private'));
});

test('no-concurrency warns when the workflow lacks cancel-in-progress concurrency', () => {
  const noBlock = clean.replace(/concurrency:\n[\s\S]*$/, '');
  const falseValue = clean.replace('cancel-in-progress: true', 'cancel-in-progress: false');
  const jobBlock = noBlock.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    concurrency:\n      group: ci\n      cancel-in-progress: true');
  assert.ok(findingIds([{ path: '.github/workflows/quick.yml', text: noBlock }]).includes('no-concurrency'));
  assert.ok(findingIds([{ path: '.github/workflows/quick.yml', text: falseValue }]).includes('no-concurrency'));
  assert.ok(!findingIds([{ path: '.github/workflows/quick.yml', text: jobBlock }]).includes('no-concurrency'));
});

test('no-paths-ignore warns when push or pull request has no docs path filter', () => {
  const noFilters = clean.replace(/    paths-ignore:.*\n(?:      - .*\n)*/g, '');
  assert.ok(findingIds([{ path: '.github/workflows/quick.yml', text: noFilters }]).includes('no-paths-ignore'));
});

test('matrix-or-non-linux warns for a matrix or a non-Linux runner', () => {
  const matrix = clean.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [20, 22]');
  const macos = clean.replace('runs-on: ubuntu-latest', 'runs-on: macos-latest');
  assert.ok(findingIds([{ path: '.github/workflows/quick.yml', text: matrix }]).includes('matrix-or-non-linux'));
  assert.ok(findingIds([{ path: '.github/workflows/quick.yml', text: macos }]).includes('matrix-or-non-linux'));
});

test('parses on triggers in scalar, list, and mapping forms', () => {
  const cases = [
    ['on: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n', ['push-main-full', 'no-concurrency', 'no-paths-ignore']],
    ['on: [push, pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n', ['push-main-full', 'no-concurrency', 'no-paths-ignore']],
    ['on:\n  push:\n    branches: [main]\n    paths: [src/**, docs/**, .orchestration/**]\n  pull_request:\n    paths: [src/**, docs/**, .orchestration/**]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n', ['push-main-full', 'no-concurrency']],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(findingIds([{ path: '.github/workflows/verify.yml', text }]), expected);
  }
});

test('recognizes branch filters for push triggers', () => {
  assert.equal(workflowPushesBranch([{ path: 'ci.yml', text: clean }], 'main'), true);
  assert.equal(workflowPushesBranch([{ path: 'ci.yml', text: clean }], 'master'), false);
  assert.equal(workflowPushesBranch([{ path: 'ci.yml', text: 'on: push\n' }], 'master'), true);
  assert.equal(workflowPushesBranch([{ path: 'ci.yml', text: 'on: pull_request\n' }], 'main'), false);
  assert.equal(workflowPushesBranch([{ path: 'ci.yml', text: 'on: { push: { branches: [main] } }\n' }], 'main'), true);
});

test('block lists with items at the indent of their key parse', () => {
  const same = `name: Quick check
on:
  pull_request:
    paths-ignore:
    - docs/**
    - .orchestration/**
  push:
    branches:
    - develop
    paths-ignore:
    - docs/**
    - .orchestration/**
concurrency:
  group: x
  cancel-in-progress: true
jobs:
  quick:
    runs-on: ubuntu-latest
`;
  assert.deepEqual(findingIds([{ path: '.github/workflows/q.yml', text: same }]), []);
  const list = 'name: Full\non:\n- push\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
  assert.ok(findingIds([{ path: '.github/workflows/f.yml', text: list }]).includes('push-main-full'));
});
