import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDesktopUpdate } from '../../src/renderer/stream-state.js';

test('streaming updates retain history, replace actions once, and preserve session settings', () => {
  const history = { id: 'old', text: 'Existing history' };
  const state = { sessions: [{ id: 'a', accountId: 'codex', models: { codex: 'gpt' }, actions: [history] }], busySession: 'a' };
  for (let index = 0; index < 1000; index++) mergeDesktopUpdate(state, { session: { id: 'a', accountId: 'claude', models: { claude: 'sonnet' }, actions: [{ id: 'reply', text: String(index) }] }, busySession: 'a' });
  assert.equal(state.sessions[0].actions.length, 2);
  assert.equal(state.sessions[0].actions[0], history);
  assert.equal(state.sessions[0].actions[1].text, '999');
  assert.equal(state.sessions[0].accountId, 'claude');
  mergeDesktopUpdate(state, { session: { id: 'a', actions: [] } });
  assert.equal(state.busySession, undefined);
  assert.equal(state.sessions[0].actions.length, 2);
});
