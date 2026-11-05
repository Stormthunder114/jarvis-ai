import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual AudioEngine in a fake Web Audio environment. No network,
// simulated production responses, or browser microphone permission required.
function engine({ fallback = false, delayed = false } = {}) {
  const source = readFileSync(new URL('../public/static/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const AudioEngine = (() => {');
  const end = source.indexOf('\n})();', start) + '\n})();'.length;
  const nodes = [];
  let finishDecode, drained = 0;
  class AudioContext {
    state = 'running'; currentTime = 0; destination = {};
    createGain() { return { gain: {}, connect() {} }; }
    createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
    createBufferSource() {
      const node = { connect() {}, disconnect() { this.disconnected = true; },
        start() { this.started = true; }, stop() { this.stopped = true; } };
      nodes.push(node); return node;
    }
    decodeAudioData() {
      if (delayed) return new Promise(resolve => { finishDecode = () => resolve({ duration: .06 }); });
      return Promise.resolve({ duration: .06 });
    }
  }
  const context = vm.createContext({
    window: { AudioContext, JarvisConversation: { playbackDrained: () => drained++ } },
    document: { getElementById: () => null },
    Logger: { audio() {}, warn() {}, error() {} }, Float32Array, Uint8Array, ArrayBuffer,
  });
  const code = source.slice(start, end).replace('let opusDecoder = null;',
    fallback ? 'let opusDecoder = { decodeFloat() { throw Error("fallback"); } };' :
      'let opusDecoder = { decodeFloat() { return new Float32Array(1440); } };');
  vm.runInContext(code + '\nglobalThis.engine = AudioEngine;', context);
  return { audio: context.engine, nodes, resolve: () => finishDecode(), drained: () => drained };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('clearTTSQueue stops and disconnects every already scheduled buffer', async () => {
  const e = engine();
  e.audio.enqueueTTSChunk(new ArrayBuffer(10)); e.audio.enqueueTTSChunk(new ArrayBuffer(10)); await tick();
  assert.equal(e.nodes.length, 2); assert.equal(e.audio.playbackBusy(), true);
  e.audio.clearTTSQueue();
  assert.ok(e.nodes.every(n => n.stopped && n.disconnected && n.onended === null));
  assert.equal(e.audio.playbackBusy(), false);
});
test('drained fires after the last scheduled source ends, not after decoding', async () => {
  const e = engine(); e.audio.enqueueTTSChunk(new ArrayBuffer(10)); await tick();
  assert.equal(e.drained(), 0); e.nodes[0].onended();
  assert.equal(e.drained(), 1); assert.equal(e.audio.playbackBusy(), false);
});
test('abort during asynchronous decode cannot schedule obsolete audio', async () => {
  const e = engine({ fallback: true, delayed: true });
  e.audio.enqueueTTSChunk(new ArrayBuffer(10)); await tick();
  e.audio.clearTTSQueue(); e.resolve(); await tick();
  assert.equal(e.nodes.length, 0); assert.equal(e.audio.playbackBusy(), false);
});
test('fallback playback sources are also cancelled', async () => {
  const e = engine({ fallback: true }); e.audio.enqueueTTSChunk(new ArrayBuffer(10)); await tick();
  assert.equal(e.nodes.length, 1); e.audio.clearTTSQueue(); assert.equal(e.nodes[0].stopped, true);
});
