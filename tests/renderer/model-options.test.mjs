import assert from 'node:assert/strict';
import test from 'node:test';
import { modelGroups } from '../../src/renderer/model-options.js';

const accounts = [
  { id: 'codex-a', name: 'Work', engine: 'pi', provider: 'openai-codex', model: 'gpt' },
  { id: 'codex-b', name: 'Personal', engine: 'pi', provider: 'openai-codex', model: 'gpt' },
  { id: 'claude-a', name: 'Claude A', engine: 'claude', provider: '', model: 'sonnet' },
  { id: 'claude-b', name: 'Claude B', engine: 'claude', provider: '', model: 'sonnet' },
];
const catalog = (ids) => ({ connected: true, models: ids.map((id) => ({ id, name: id, authenticated: true })) });
const catalogs = new Map([
  ['codex-a', catalog(['gpt', 'work-only', 'gpt'])], ['codex-b', catalog(['gpt'])],
  ['claude-a', catalog(['sonnet', 'shared'])], ['claude-b', catalog(['sonnet', 'shared'])],
]);

test('models appear once per provider and use the selected eligible account', () => {
  const groups = modelGroups(accounts, catalogs, new Map(), { accountId: 'codex-b', models: {} });
  assert.deepEqual(groups.map((group) => [group.provider, group.models.map(({ model }) => model.id)]), [
    ['Codex', ['gpt', 'work-only']], ['Claude', ['sonnet', 'shared']],
  ]);
  assert.equal(groups[0].models[0].accountId, 'codex-b');
  assert.equal(groups[0].models[0].selected, true);
  assert.equal(groups[0].models[1].accountId, 'codex-a');
});

test('disconnected accounts cannot route models and errors remain visible', () => {
  const disconnected = new Map(catalogs);
  disconnected.set('codex-b', { ...catalog(['gpt']), connected: false });
  const group = modelGroups(accounts, disconnected, new Map(), { accountId: 'codex-b' })[0];
  assert.equal(group.models[0].accountId, 'codex-a');
  assert.deepEqual(group.unavailable, ['Personal: Sign-in needed']);
});

test('search matches every eligible account without repeating models', () => {
  const groups = modelGroups(accounts, catalogs, new Map(), { accountId: 'codex-b' }, 'personal');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].models.map(({ model }) => model.id), ['gpt']);
});

test('equal IDs from different providers stay separate', () => {
  const equal = new Map(accounts.map((account) => [account.id, catalog(['shared'])]));
  const groups = modelGroups(accounts, equal, new Map(), { accountId: 'claude-b', models: { 'claude-b': 'shared' } });
  assert.equal(groups.length, 2);
  assert.equal(groups[1].models[0].accountId, 'claude-b');
  assert.equal(groups[1].models[0].selected, true);
});
