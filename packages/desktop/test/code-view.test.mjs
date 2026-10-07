import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { diffRows } from '../ui/code-view.js';
import { buildTree } from '../ui/file-tree.js';

const require = createRequire(new URL('../../coding-agent/package.json', import.meta.url));
const diff = require('diff');

test('diff rows show source and old/new positions without Git headers', () => {
  const before = 'const keep = true;\nconst message = "Before";\n';
  const after = 'const keep = true;\nconst message = "After";\n';
  const patch = diff.createPatch('app.ts', before, after);
  assert.deepEqual(diffRows({ before, after, diff: patch }, diff).rows, [
    { kind: 'context', text: 'const keep = true;', oldLine: 1, newLine: 1 },
    { kind: 'removed', text: 'const message = "Before";', oldLine: 2, newLine: undefined },
    { kind: 'added', text: 'const message = "After";', oldLine: undefined, newLine: 2 },
  ]);
});

test('new and deleted files render code even with the legacy new-file description', () => {
  const text = 'export const ready = true;\n';
  assert.deepEqual(diffRows({ after: text, diff: `New file: app.ts\n${text}` }, diff).rows, [
    { kind: 'added', text: 'export const ready = true;', oldLine: undefined, newLine: 1 },
  ]);
  assert.deepEqual(diffRows({ before: text }, diff).rows, [
    { kind: 'removed', text: 'export const ready = true;', oldLine: 1, newLine: undefined },
  ]);
});

test('separate hunks preserve absolute line numbers and indicate omitted context', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 10\n', 'replacement 10\n').replace('line 30\n', 'replacement 30\n');
  const result = diffRows({ before, after, diff: diff.createPatch('test.txt', before, after) }, diff);
  assert.equal(result.rows.filter((row) => row.kind === 'gap').length, 2);
  assert.deepEqual(result.rows.filter((row) => row.kind === 'added').map((row) => row.newLine), [10, 30]);
});

test('newline markers are annotations, never source lines', () => {
  const result = diffRows({ before: 'old', after: 'new' }, diff);
  assert.equal(result.rows.filter((row) => row.kind === 'note').length, 2);
  assert.deepEqual(result.rows.filter((row) => row.kind === 'added').map((row) => row.newLine), [1]);
});

test('binary files and permission-only diffs have explicit empty states', () => {
  assert.match(diffRows({ before: '\0binary', after: '\0data' }, diff).message, /Binary/);
  assert.match(diffRows({ before: 'same\n', after: 'same\n', diff: 'old mode 100644\nnew mode 100755' }, diff).message, /permissions/);
  assert.match(diffRows({ before: '', after: '' }, diff).message, /No code changes/);
});

test('source resembling diff headers remains source', () => {
  const result = diffRows({ before: '', after: '--- example\n+++ example\n@@ example\n<script>alert(1)</script>\n' }, diff);
  assert.deepEqual(result.rows.map((row) => row.text), ['--- example', '+++ example', '@@ example', '<script>alert(1)</script>']);
  assert.ok(result.rows.every((row) => row.kind === 'added'));
});

test('full context preserves all source lines and interleaves removed lines', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 20\n', 'replacement 20\n');
  const rows = diffRows({ before, after, diff: diff.createPatch('file', before, after) }, diff, true).rows.filter((row) => row.kind !== 'note');
  assert.equal(rows.length, 41);
  assert.equal(rows[0].text, 'line 1');
  assert.equal(rows.at(-1).text, 'line 40');
  assert.equal(rows[19].kind, 'removed');
  assert.equal(rows[20].kind, 'added');
  assert.equal(rows[20].newLine, 20);
  assert.equal(diffRows({ before, after: before }, diff, true).rows.length, 40);
});

test('file trees preserve nested structure, unusual names and deleted paths supplied by the view', () => {
  const tree = buildTree(['src/app.ts', 'src/lib/util.ts', 'src/deleted.ts', '__proto__/name.ts', 'read me.md']);
  assert.equal(tree.children.get('src').children.get('lib').children.get('util.ts').path, 'src/lib/util.ts');
  assert.equal(tree.children.get('src').children.get('deleted.ts').file, true);
  assert.equal(tree.children.get('__proto__').children.get('name.ts').path, '__proto__/name.ts');
  assert.equal(tree.children.get('read me.md').file, true);
});
