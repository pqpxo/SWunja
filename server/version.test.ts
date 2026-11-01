import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANGELOG } from '../web/src/changelog.ts';

// every release bumps package.json's version and adds its changelog entry (shown in Settings → About)
test('the newest changelog entry is the current version, newest first, versions unique', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(CHANGELOG[0].version, version, 'add a changelog entry for this version (web/src/changelog.ts)');
  const nums = CHANGELOG.map(e => e.version.split('.').map(Number));
  for (let i = 1; i < nums.length; i++) {
    const [a, b] = [nums[i - 1], nums[i]];
    assert.ok(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))), `${CHANGELOG[i - 1].version} should be newer than ${CHANGELOG[i].version}`);
  }
  for (const e of CHANGELOG) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.changes.length > 0, `${e.version} lists its changes`);
  }
});
