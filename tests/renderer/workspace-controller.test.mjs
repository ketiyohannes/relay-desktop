import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installWorkspaceTools } from '../../src/renderer/features/workspace/index.js';

class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; open = false; children = []; callbacks = new Map();
  classList = { toggle() {} };
  addEventListener(name, callback) { const callbacks = this.callbacks.get(name) || []; callbacks.push(callback); this.callbacks.set(name, callbacks); }
  async trigger(name) { for (const callback of this.callbacks.get(name) || []) await callback({ preventDefault() {} }); }
  after() {} append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; }
  focus() {} showModal() { this.open = true; } close() { this.open = false; void this.trigger('close'); }
}
function setup(t, command) {
  const elements = new Map();
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
  t.mock.method(globalThis, 'setInterval', () => 0);
  const document = { querySelector: get, createElement: () => new Element(), hidden: false };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  let busy = false;
  const state = { timelineAvailability: {}, sessions: [], accounts: [], projects: [] };
  const api = installWorkspaceTools({ command, active: () => undefined, state: () => state, busy: () => busy, snapshotSelection: () => undefined, openSnapshot() {}, openSearchMatch() {}, renderTimeline() {}, saved() {} });
  return { get, api, busy(value) { busy = value; api.editorStatus(true); } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('R11: dirty editor follows busy transitions without losing draft or rejection message; busy click is guarded', async (t) => {
  let saves = 0;
  const fixture = setup(t, async (command) => {
    if (command.type === 'editor_read') return { path: command.path, content: 'before' };
    if (command.type === 'editor_save') { saves++; if (saves === 1) throw new Error('Disk unavailable'); return { path: command.path, content: command.content }; }
  });
  fixture.api.openEditor({ sessionId: 'a', path: 'file' }); await tick();
  fixture.get('#editor-text').value = 'draft'; await fixture.get('#editor-text').trigger('input');
  assert.equal(fixture.get('#editor-save').disabled, false);
  fixture.busy(true); assert.equal(fixture.get('#editor-save').disabled, true);
  await fixture.get('#editor-save').trigger('click'); assert.equal(saves, 0);
  fixture.busy(false); assert.equal(fixture.get('#editor-save').disabled, false);
  await fixture.get('#editor-save').trigger('click');
  assert.equal(fixture.get('#editor-text').value, 'draft'); assert.equal(fixture.get('#editor-status').textContent, 'Disk unavailable');
  fixture.busy(true); fixture.busy(false);
  assert.equal(fixture.get('#editor-status').textContent, 'Disk unavailable');
  await fixture.get('#editor-save').trigger('click');
  assert.equal(saves, 2); assert.equal(fixture.get('#editor-save').disabled, true); assert.equal(fixture.get('#editor-text').value, 'draft');
});

test('R09: cancelled and replaced editor loads ignore stale replies after session switching', async (t) => {
  const replies = [];
  const fixture = setup(t, (command) => new Promise((resolve) => replies.push({ command, resolve })));
  fixture.api.openEditor({ sessionId: 'a', path: 'old' });
  fixture.get('#editor-dialog').close();
  fixture.api.openEditor({ sessionId: 'b', path: 'current' });
  replies[1].resolve({ path: 'current', content: 'b-content' }); await tick();
  replies[0].resolve({ path: 'old', content: 'stale-a' }); await tick();
  assert.equal(fixture.get('#editor-text').value, 'b-content'); assert.equal(fixture.get('#editor-path').textContent, 'current');
  fixture.get('#editor-text').value = 'b-draft'; await fixture.get('#editor-text').trigger('input');
  await fixture.get('#editor-close').trigger('click'); assert.equal(fixture.get('#editor-discard').hidden, false);
  await fixture.get('#editor-keep').trigger('click'); assert.equal(fixture.get('#editor-dialog').open, true); assert.equal(fixture.get('#editor-text').value, 'b-draft');
  await fixture.get('#editor-discard-confirm').trigger('click'); assert.equal(fixture.get('#editor-dialog').open, false);
});
