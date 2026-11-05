import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

async function local(getUserMedia) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return elements.get(id);
  };
  const window = { addEventListener() {}, createKws: () => ({ handle: 1 }),
    JarvisConversation: { prepare: async () => {}, end() {} } };
  const document = { getElementById: element, hidden: false, addEventListener() {} };
  const context = vm.createContext({ window, document,
    navigator: { mediaDevices: { getUserMedia } },
    fetch: async () => ({ ok: true, text: async () => '@JARVIS' }),
    console: { log() {}, error() {} }, Float32Array, Date,
  });
  vm.runInContext(readFileSync(new URL('../public/static/jarvis-local.js', import.meta.url), 'utf8'), context);
  await window.Module.onRuntimeInitialized();
  return { window, element, start: () => element('jarvisLocalToggle').handlers.click() };
}
test('microphone permission denial disables capture and exposes an actionable error', async () => {
  const f = await local(async () => { throw new Error('Permission denied'); });
  await f.start();
  assert.equal(f.element('jarvisLocalToggle').textContent, 'Ativar Jarvis');
  assert.match(f.element('jarvisLocalStatus').textContent, /Permission denied/);
});
test('disable during pending permission releases the stream when it arrives', async () => {
  let resolve, stopped = 0;
  const f = await local(() => new Promise(r => { resolve = r; }));
  const pending = f.start(); await new Promise(r => setImmediate(r));
  await f.window.JarvisLocal.disable();
  resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  await pending;
  assert.equal(stopped, 1);
});
test('context startup failure closes the context and stops all microphone tracks', async () => {
  let stopped = 0, closed = 0;
  const f = await local(async () => ({ getTracks: () => [{ stop: () => stopped++ }] }));
  f.window.AudioContext = class {
    async resume() { throw Error('Context suspended'); }
    async close() { closed++; }
  };
  await f.start(); assert.equal(stopped, 1); assert.equal(closed, 1);
});
