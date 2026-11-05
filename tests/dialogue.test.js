import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DialogueController, VoiceActivityDetector, isEndCommand } from '../public/static/dialogue.js';

const frame = (value = 0, n = 960) => new Float32Array(n).fill(value);
function fixture(options = {}) {
  const events = [];
  let busy = false, connected = true, echo = true;
  const session = { protocol: {
    isConnected: () => connected,
    sendListenStart: mode => { events.push(['start', mode]); return true; },
    sendListenStop: () => { events.push(['stop']); return true; },
    sendAudio: packet => { events.push(['audio', packet]); return true; },
    sendAbort: reason => events.push(['abort', reason]),
  } };
  const io = { session: () => session, canStart: () => true,
    encode: async samples => samples, clearPlayback: () => { busy = false; events.push(['clear']); },
    playbackBusy: () => busy, echoCancellation: () => echo,
    state: (state, message) => events.push(['state', state, message]), ...options };
  const d = new DialogueController(io);
  const speak = (count = 4) => { for (let i = 0; i < count; i++) d.pcm(frame(.1)); };
  const quiet = (count = 17) => { for (let i = 0; i < count; i++) d.pcm(frame()); };
  return { d, events, session, speak, quiet, io,
    busy: value => { busy = value; }, disconnect: () => { connected = false; }, echo: value => { echo = value; } };
}
test('VAD confirms onset, rejects impulses, and respects adjustable silence', () => {
  const v = new VoiceActivityDetector({ silenceMs: 1200 });
  assert.equal(v.push(frame(.1)), null); v.push(frame());
  assert.equal(v.push(frame(.1)), null); v.push(frame(.1));
  assert.equal(v.push(frame(.1)), 'start');
  for (let i = 0; i < 19; i++) assert.equal(v.push(frame()), null);
  assert.equal(v.push(frame()), 'end');
});
test('long speech streams beyond seven seconds; stop follows last encoded packet', async () => {
  const f = fixture(); f.d.begin();
  for (let i = 0; i < 500; i++) { f.speak(1); await f.d.chain; }
  assert.equal(f.d.state, 'LISTENING');
  assert.equal(f.events.filter(x => x[0] === 'stop').length, 0);
  f.quiet(); await f.d.chain;
  assert.equal(f.d.state, 'PROCESSING');
  const wire = f.events.filter(x => ['start', 'audio', 'stop'].includes(x[0]));
  assert.deepEqual(wire[0], ['start', 'manual']);
  assert.equal(wire.at(-1)[0], 'stop');
  assert.equal(wire.filter(x => x[0] === 'audio').length, 517);
});
test('same session listens again only after server stop AND scheduled playback ends', async () => {
  const f = fixture(); f.d.begin(); f.speak(); f.quiet(); await f.d.chain;
  f.d.ttsStart(f.session); f.busy(true); f.d.ttsStop(f.session);
  assert.equal(f.d.state, 'SPEAKING');
  f.busy(false); f.d.playbackDrained();
  assert.equal(f.d.state, 'LISTENING');
  f.speak(); f.quiet(); await f.d.chain;
  assert.equal(f.events.filter(x => x[0] === 'start').length, 2);
  assert.equal(f.d.session, f.session);
  f.d.end();
});
test('default half duplex never sends speaker echo or aborts on microphone energy', async () => {
  const f = fixture(); f.d.begin(); f.speak(); f.quiet(); await f.d.chain;
  f.d.ttsStart(f.session); f.speak(100);
  assert.equal(f.events.filter(x => x[0] === 'abort').length, 0);
  assert.equal(f.events.filter(x => x[0] === 'start').length, 1);
  f.d.end();
});
test('barge-in cancels locally once, waits for actual stop, retains interrupted question', async () => {
  const f = fixture(); f.d.bargeIn = true; f.d.begin(); f.speak(); f.quiet(); await f.d.chain;
  f.d.ttsStart(f.session); f.speak(8); f.quiet();
  assert.equal(f.events.filter(x => x[0] === 'abort').length, 1);
  assert.equal(f.d.allowAudio(f.session), false);
  assert.equal(f.events.filter(x => x[0] === 'start').length, 1);
  f.d.ttsStop(f.session); await f.d.chain;
  assert.equal(f.events.filter(x => x[0] === 'start').length, 2);
  assert.equal(f.d.state, 'PROCESSING');
  f.d.ttsStop(f.session); // duplicate stop must not restart a turn
  assert.equal(f.events.filter(x => x[0] === 'start').length, 2);
  f.d.end();
});
test('barge-in requires browser-confirmed echo cancellation', async () => {
  const f = fixture(); f.d.bargeIn = true; f.echo(false);
  f.d.begin(); f.speak(); f.quiet(); await f.d.chain;
  f.d.ttsStart(f.session); f.speak(20);
  assert.equal(f.events.filter(x => x[0] === 'abort').length, 0); f.d.end();
});
test('end cancels pending encode completions and does not duplicate commands', async () => {
  let resolve;
  const f = fixture({ encode: () => new Promise(r => { resolve = r; }) });
  f.d.begin(); f.speak(); await Promise.resolve();
  f.d.end(); f.d.end(); resolve(frame()); await f.d.chain;
  assert.equal(f.events.filter(x => x[0] === 'audio').length, 0);
  assert.equal(f.events.filter(x => x[0] === 'abort').length, 1);
});
test('disconnect ends conversation; reconnection cannot silently reuse old context', () => {
  const f = fixture(); f.d.begin(); f.disconnect(); f.speak();
  assert.equal(f.d.active, false); assert.equal(f.d.begin(), false);
});
test('voice end commands require whole utterance and the owning session', () => {
  for (const s of ['Jarvis, encerrar conversa.', 'Jarvis, parar!', 'Jarvis, cancelar.', 'encerrar a conversa']) assert.ok(isEndCommand(s));
  assert.equal(isEndCommand('Como cancelar uma compra?'), false);
  const f = fixture(); f.d.begin(); f.d.stt({}, 'Jarvis, parar');
  assert.equal(f.d.active, true); f.d.stt(f.session, 'Jarvis, parar');
  assert.equal(f.d.active, false);
});
test('disabled continuous mode ends after one real response', async () => {
  const f = fixture(); f.d.continuous = false; f.d.begin(); f.speak(); f.quiet(); await f.d.chain;
  f.d.ttsStart(f.session); f.d.ttsStop(f.session); assert.equal(f.d.active, false);
});
test('wake preroll preserves a short question captured before keyword decoding', async () => {
  const f = fixture(); f.speak(5); f.d.begin(); f.quiet(); await f.d.chain;
  assert.equal(f.d.state, 'PROCESSING');
  assert.equal(f.events.filter(x => x[0] === 'audio').length, 22);
});
test('manual/text handoff releases the audio gate without sending a duplicate abort', () => {
  const f = fixture(); f.d.begin(); f.d.end(); f.d.release();
  assert.equal(f.d.allowAudio(f.session), true);
  assert.equal(f.events.filter(x => x[0] === 'abort').length, 1);
});
test('missing abort confirmation ends explicitly instead of pretending a new turn is safe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.d.bargeIn = true; f.d.begin(); f.speak(); f.quiet(); await f.d.chain;
  f.d.ttsStart(f.session); f.speak(8);
  t.mock.timers.tick(8000);
  assert.equal(f.d.active, false);
  assert.match(f.events.at(-1)[2], /não confirmou/);
  assert.equal(f.events.filter(x => x[0] === 'start').length, 1);
});
