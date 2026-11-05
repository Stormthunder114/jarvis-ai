// Browser-owned endpointing. The wire protocol stays in manual mode.
export class VoiceActivityDetector {
  constructor({ silenceMs = 1000, onsetMs = 160, threshold = 0.012 } = {}) {
    this.silenceMs = silenceMs;
    this.onsetMs = onsetMs;
    this.threshold = threshold;
    this.reset();
  }
  reset() { this.voiceMs = 0; this.quietMs = 0; this.speaking = false; this.noise = 0.002; }
  push(samples, rate = 16000, interrupting = false) {
    const ms = samples.length / rate * 1000;
    const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    const threshold = Math.max(this.threshold * (interrupting ? 2.5 : 1), this.noise * 3);
    const voiced = rms >= threshold;
    if (!voiced && !this.speaking) this.noise = this.noise * 0.95 + rms * 0.05;
    this.voiceMs = voiced ? this.voiceMs + ms : 0;
    this.quietMs = voiced ? 0 : this.quietMs + ms;
    if (!this.speaking && this.voiceMs >= this.onsetMs * (interrupting ? 2 : 1)) {
      this.speaking = true;
      return 'start';
    }
    if (this.speaking && this.quietMs >= this.silenceMs) {
      this.reset();
      return 'end';
    }
    return null;
  }
}

export function isEndCommand(text) {
  return /^(?:jarvis[\s,.:!-]*)?(?:encerrar (?:a )?conversa|parar|cancelar)[\s.!?]*$/i.test(text.trim());
}

export class DialogueController {
  constructor(io, options = {}) {
    this.io = io;
    this.vad = new VoiceActivityDetector(options);
    this.continuous = true;
    this.bargeIn = false; // Explicit experimental opt-in; never claims full duplex.
    this.state = 'IDLE';
    this.active = false;
    this.generation = 0;
    this.preRoll = [];
    this.preSamples = 0;
    this.chain = Promise.resolve();
    this.pendingSamples = 0;
    this.muted = false;
  }
  setState(state, message = '') {
    this.state = state;
    this.io.state(state, message, this.active);
  }
  begin() {
    if (this.active) return false;
    const session = this.io.session();
    if (!session?.protocol.isConnected() || !this.io.canStart()) {
      this.setState('IDLE', 'Conecte o XiaoZhi e libere o microfone manual.');
      return false;
    }
    this.session = session;
    this.active = true;
    this.generation++;
    this.muted = true;
    this.vad.reset();
    this.setState('WAKE_WORD');
    this.setState('LISTENING');
    // The keyword decoder has latency: preserve speech already captured with
    // “Jarvis, ...”, including a very short question in the same breath.
    for (const chunk of this.preRoll) this.vad.push(chunk);
    if (this.vad.speaking) this.openTurn();
    return true;
  }
  remember(samples) {
    this.preRoll.push(samples.slice());
    this.preSamples += samples.length;
    while (this.preSamples > 9600 && this.preRoll.length > 1) this.preSamples -= this.preRoll.shift().length;
  }
  resetInput() {
    this.vad.reset(); this.preRoll = []; this.preSamples = 0;
    this.tail = new Float32Array(0);
  }
  pcm(samples) {
    if (!this.active) {
      if (this.io.playbackBusy()) this.resetInput();
      else this.remember(samples);
      return;
    }
    if (this.session !== this.io.session() || !this.session.protocol.isConnected()) {
      this.end('Conversa encerrada: conexão ou assistente mudou.'); return;
    }
    if (this.state !== 'LISTENING' && !(this.state === 'SPEAKING' && this.bargeIn && this.io.echoCancellation())) return;
    const event = this.vad.push(samples, 16000, this.state === 'SPEAKING');
    if (!this.turnOpen && !this.interruptPending) {
      this.remember(samples);
      if (event !== 'start') return;
      if (this.state === 'SPEAKING') {
        this.muted = true;
        this.interruptPending = true;
        this.io.clearPlayback();
        this.session.protocol.sendAbort('user_interruption');
        this.setState('LISTENING', 'Interrupção: aguardando confirmação do servidor.');
        if (this.serverStopped) { this.ttsStop(this.session); return; }
        // Failure deadline only; it never pretends TTS has completed.
        this.abortDeadline = setTimeout(() => this.end('Conversa encerrada: servidor não confirmou a interrupção.'), 8000);
        return;
      }
      this.openTurn();
      return;
    }
    if (this.interruptPending) {
      this.preRoll.push(samples.slice()); this.preSamples += samples.length;
      if (event === 'end') this.endPending = true;
      return;
    }
    this.encode(samples);
    if (event === 'end') this.finishTurn();
  }
  openTurn() {
    if (!this.session.protocol.sendListenStart('manual')) { this.end('Falha ao enviar áudio.'); return; }
    this.turnOpen = true;
    this.tail = new Float32Array(0);
    for (const chunk of this.preRoll) this.encode(chunk);
    this.preRoll = []; this.preSamples = 0;
  }
  encode(samples) {
    const merged = new Float32Array(this.tail.length + samples.length);
    merged.set(this.tail); merged.set(samples, this.tail.length);
    let offset = 0;
    while (offset + 960 <= merged.length) {
      this.queueFrame(merged.slice(offset, offset + 960)); offset += 960;
    }
    this.tail = merged.slice(offset);
  }
  queueFrame(frame) {
    const generation = this.generation;
    const session = this.session;
    this.pendingSamples += frame.length;
    if (this.pendingSamples > 160000) { this.end('Conversa encerrada: codificador de áudio sobrecarregado.'); return; }
    this.chain = this.chain.then(async () => {
      try {
        if (!this.active || generation !== this.generation) return;
        const packet = await this.io.encode(frame);
        if (!this.active || generation !== this.generation) return;
        if (!packet || !session.protocol.sendAudio(packet)) throw new Error('Falha ao enviar Opus');
      } finally { this.pendingSamples -= frame.length; }
    }).catch(error => { if (generation === this.generation) this.end(error.message); });
  }
  finishTurn() {
    if (!this.turnOpen || this.state === 'PROCESSING') return;
    if (this.tail.length) {
      const padded = new Float32Array(960); padded.set(this.tail); this.queueFrame(padded);
      this.tail = new Float32Array(0);
    }
    this.setState('PROCESSING');
    const generation = this.generation;
    this.chain = this.chain.then(() => {
      if (!this.active || generation !== this.generation) return;
      this.turnOpen = false;
      this.muted = false;
      if (!this.session.protocol.sendListenStop()) this.end('Conversa encerrada: conexão perdida.');
    });
  }
  stt(session, text) {
    if (this.active && session === this.session && isEndCommand(text)) this.end();
  }
  ttsStart(session) {
    if (!this.active || session !== this.session || this.muted || this.state !== 'PROCESSING') return;
    this.serverStopped = false;
    this.resetInput();
    this.setState('SPEAKING');
  }
  ttsStop(session) {
    if (!this.active || session !== this.session) return;
    if (this.interruptPending) {
      clearTimeout(this.abortDeadline);
      this.interruptPending = false;
      this.serverStopped = false;
      this.openTurn();
      if (this.endPending) { this.endPending = false; this.finishTurn(); }
      return;
    }
    if (this.muted || this.state !== 'SPEAKING') return;
    this.serverStopped = true;
    this.playbackDrained();
  }
  playbackDrained() {
    if (!this.active || !this.serverStopped || this.io.playbackBusy()) return;
    this.serverStopped = false;
    if (!this.continuous) { this.end(); return; }
    this.muted = true;
    this.resetInput();
    this.setState('LISTENING');
  }
  allowAudio(session) { return session !== this.session || !this.muted; }
  release() {
    this.end();
    this.session = null;
    this.muted = false;
  }
  end(message = 'Conversa encerrada') {
    const wasActive = this.active;
    this.active = false;
    this.generation++;
    clearTimeout(this.abortDeadline);
    if (wasActive) {
      if (this.turnOpen) this.session.protocol.sendListenStop();
      this.session.protocol.sendAbort('user_interruption');
      this.io.clearPlayback();
    }
    this.turnOpen = false; this.interruptPending = false; this.endPending = false;
    this.serverStopped = false; this.muted = true;
    this.resetInput();
    this.setState('IDLE', message);
  }
}
