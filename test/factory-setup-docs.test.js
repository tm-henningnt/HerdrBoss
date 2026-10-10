import './helpers/test-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

for (const file of ['cli.md', 'specs/factories.md']) {
  test(`${file} has the Windows HTTPS setup, transfer, and smoke cleanup contract`, () => {
    const text = fs.readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes('Windows host runbook'), `${file} must have the Windows host runbook`);
    for (const term of ['WSL2', 'systemd', 'tag:factory:22,443,4477,4478', '"acls"', '"tests"',
      'sudo tailscale serve --http=PORT off', 'sudo tailscale serve --bg PORT', 'HTTPS certificates',
      'factory connect NAME', 'factory update NAME --tier service', 'project transfer plan SLUG --to NAME',
      'factory clean-smoke NAME --dry-run', 'clean-smoke NAME', 'smoke-', 'symbolic links']) assert.ok(text.includes(term), `${file} must document ${term}`);
    assert.doesNotMatch(text, /http:\/\/HOST(?::PORT)?/);
  });
}

test('the Factory hosts page help explains HTTPS repair, shared-tag ACLs, and smoke cleanup', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const help = app.slice(app.indexOf('<h3>Factory hosts</h3>'), app.indexOf('<h3>Factory updates</h3>'));
  for (const term of ['HTTPS certificates', 'sudo tailscale serve --http=PORT off', 'sudo tailscale serve --bg PORT',
    'factory connect NAME', 'tag:factory:22,443,4477,4478', 'acls', 'tests', 'factory clean-smoke NAME', '--dry-run', 'smoke-', 'symbolic links']) assert.ok(help.includes(term), `Factory hosts help must document ${term}`);
});
