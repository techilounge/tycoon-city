import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('starter instructions exist', () => {
  for (const path of ['AGENTS.md', '.obvious/obvious.md', 'docs/PRODUCT.md', 'docs/ROADMAP.md']) {
    assert.ok(readFileSync(path, 'utf8').length > 100);
  }
});
