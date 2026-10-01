import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = [
  '- Orchestrators and workers may read another Herdr Boss project repository to learn how it solved a problem.',
  "- Do not edit another project's repository.",
  '- Do not copy secrets, tenant hosts, client names, or app IDs into this project.',
  '- Cite each source file in `docs/orchestration/memory.md`.',
].join('\n');

test('the project kit source, installed kit file, and orchestrator skill state the read-only rule', () => {
  for (const file of [
    'kit/templates/project-kit.md',
    'docs/orchestration/herdr-boss.md',
    'kit/skills/herdr-orchestrator/SKILL.md',
  ]) {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(content.includes(RULE), `${file} must contain the shared read-only rule`);
  }
});
