/* Local Sherpa-ONNX wake word plus continuous XiaoZhi conversation.
 * The WASM loader/model configuration below is intentionally preserved.
 */
(() => {
  'use strict';
  const KWS_DIR = '/static/kws/';
  const KEYWORDS_URL = KWS_DIR + 'jarvis_keywords.txt';
  const AUDIO_SAMPLE_RATE = 16000;
  let kws = null, streamKws = null, audio = null;
  let enabled = false, ready = false, phase = 'boot', starting = false;
  let captureGeneration = 0, lastWake = 0;
  const panel = document.getElementById('jarvisLocalPanel');
  const button = document.getElementById('jarvisLocalToggle');
  const status = document.getElementById('jarvisLocalStatus');
  const endButton = document.getElementById('jarvisEndConversation');
  const continuous = document.getElementById('jarvisContinuous');
  const barge = document.getElementById('jarvisBargeIn');
  const silence = document.getElementById('jarvisSilence');
  const activity = document.getElementById('jarvisActivity');
  function setStatus(value) { status.textContent = value; }
  function log(...args) { console.log('[Jarvis KWS local]', ...args); }
  function err(...args) { console.error('[Jarvis KWS local]', ...args); }
  const dialogue = () => window.JarvisConversation;

  window.addEventListener('jarvis-dialogue-state', ({ detail }) => {
    const labels = { IDLE: 'Aguardando “Jarvis”', WAKE_WORD: 'Jarvis reconhecido',
      LISTENING: 'Ouvindo você', PROCESSING: 'Processando', SPEAKING: 'Jarvis falando' };
    setStatus(detail.message || labels[detail.state]);
    activity.textContent = detail.active ? (continuous.checked ? 'Conversa contínua ativa' : 'Conversa de um turno ativa') : '';
    endButton.disabled = !detail.active;
    phase = detail.active ? 'conversation' : 'waiting';
    if (!detail.active && streamKws) kws.reset(streamKws);
  });

  async function stopLocalCapture() {
    captureGeneration++;
    const old = audio; audio = null;
    if (streamKws) { try { streamKws.free(); } catch (_) {} streamKws = null; }
    if (!old) return;
    old.processor.onaudioprocess = null;
    old.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
    for (const node of [old.source, old.processor, old.gain]) { try { node.disconnect(); } catch (_) {} }
    try { await old.context.close(); } catch (_) {}
  }
  async function disable(message = 'Conversa encerrada') {
    enabled = false;
    dialogue()?.end(message);
    phase = 'off';
    button.textContent = 'Ativar Jarvis';
    await stopLocalCapture();
    setStatus(message);
  }
  window.JarvisLocal = {
    disable,
    echoCancellation: () => audio?.stream.getAudioTracks()[0]?.getSettings().echoCancellation === true,
  };

  async function startLocalCapture() {
    if (!ready || !enabled || audio || starting || document.hidden) return;
    starting = true;
    const generation = ++captureGeneration;
    let acquired = null, context = null;
    try {
      if (!dialogue()) throw new Error('Aplicação ainda carregando. Tente novamente.');
      await dialogue().prepare();
      if (!enabled || generation !== captureGeneration) return;
      acquired = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: AUDIO_SAMPLE_RATE, channelCount: 1,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (!enabled || document.hidden || generation !== captureGeneration) return;
      const Context = window.AudioContext || window.webkitAudioContext;
      context = new Context({ sampleRate: AUDIO_SAMPLE_RATE });
      await context.resume();
      if (!enabled || document.hidden || generation !== captureGeneration) return;
      // Never send mislabelled PCM to the 16 kHz Opus encoder.
      if (context.sampleRate !== AUDIO_SAMPLE_RATE) throw new Error('Este navegador não oferece captura a 16 kHz.');
      const source = context.createMediaStreamSource(acquired);
      const processor = context.createScriptProcessor(1024, 1, 1);
      const gain = context.createGain(); gain.gain.value = 0;
      source.connect(processor); processor.connect(gain); gain.connect(context.destination);
      streamKws = kws.createStream();
      audio = { stream: acquired, context, source, processor, gain };
      acquired = null; context = null;
      phase = 'waiting';
      setStatus('Aguardando “Jarvis”');
      for (const track of audio.stream.getTracks()) track.onended = () => void disable('Microfone desconectado. Ative Jarvis novamente.');
      processor.onaudioprocess = event => {
        if (!enabled || !audio) return;
        try {
          const input = new Float32Array(event.inputBuffer.getChannelData(0));
          dialogue().pcm(input);
          if (dialogue().active || dialogue().playbackBusy()) return;
          streamKws.acceptWaveform(AUDIO_SAMPLE_RATE, input);
          let steps = 0;
          while (kws.isReady(streamKws) && steps++ < 20) {
            kws.decode(streamKws);
            const result = kws.getResult(streamKws);
            if (result?.keyword) {
              kws.reset(streamKws);
              const now = Date.now();
              if (now - lastWake > 1800) {
                lastWake = now;
                dialogue().continuous = continuous.checked;
                dialogue().bargeIn = barge.checked;
                dialogue().vad.silenceMs = Number(silence.value);
                dialogue().begin();
              }
              break;
            }
          }
        } catch (e) { err(e); void disable('Falha no áudio: ' + e.message); }
      };
    } catch (e) {
      err(e);
      await disable('Erro no microfone/áudio: ' + e.message);
    } finally {
      acquired?.getTracks().forEach(track => track.stop());
      if (context) await context.close();
      starting = false;
    }
  }
  button.addEventListener('click', async () => {
    if (enabled) { await disable('Jarvis desativado'); return; }
    if (!ready || starting) return;
    enabled = true;
    button.textContent = 'Desativar Jarvis';
    setStatus('Iniciando microfone local...');
    await startLocalCapture();
  });
  endButton.addEventListener('click', () => dialogue()?.end());
  continuous.addEventListener('change', () => { if (dialogue()) dialogue().continuous = continuous.checked; });
  barge.addEventListener('change', () => {
    if (dialogue()) dialogue().bargeIn = barge.checked;
    if (barge.checked && !window.JarvisLocal.echoCancellation()) setStatus('Interrupção indisponível até o navegador confirmar cancelamento de eco.');
  });
  silence.addEventListener('change', () => { if (dialogue()) dialogue().vad.silenceMs = Number(silence.value); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && enabled) void disable('Conversa encerrada: aba em segundo plano. Ative Jarvis ao voltar.');
  });
  window.addEventListener('pagehide', () => void disable());

  // O loader Emscripten chama isto quando .wasm e .data terminaram de carregar.
  // Ele precisa estar definido ANTES de carregar sherpa-onnx-wasm-kws-main.js.
  window.Module = {
    locateFile(filename) { return KWS_DIR + filename; },
    onAbort(reason) { err('WASM abortou:', reason); setStatus('Falha no WASM: veja console.'); },
    setStatus(message) {
      if (!ready && message && /Downloading|Running|Baixando|Executando/i.test(message))
        setStatus('Carregando modelo local...');
    },
    onRuntimeInitialized: async function() {
      try {
        const res = await fetch(KEYWORDS_URL, {cache:'no-cache'});
        if (!res.ok) throw new Error('arquivo Jarvis nao disponivel: HTTP ' + res.status);
        const keywords = (await res.text()).trim();
        if (!keywords.includes('@JARVIS')) throw new Error('jarvis_keywords.txt nao contem @JARVIS');
        if (typeof window.createKws !== 'function') throw new Error('sherpa-onnx-kws.js nao carregou');
        kws = window.createKws(window.Module, {
          featConfig:{samplingRate:16000,featureDim:80},
          modelConfig:{
            transducer:{
              encoder:'./encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
              decoder:'./decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
              joiner:'./joiner-epoch-12-avg-2-chunk-16-left-64.onnx'
            },
            tokens:'./tokens.txt', provider:'cpu', modelType:'',
            modelingUnit:'bpe', numThreads:1, debug:0
          },
          maxActivePaths:4, numTrailingBlanks:1,
          keywordsScore:1.0, keywordsThreshold:0.25,
          keywords: keywords + '\n'
        });
        if (!kws?.handle) throw new Error('Nao foi possivel criar o detector');
        ready = true;
        phase = 'off';
        button.disabled = false;
        button.textContent = 'Ativar Jarvis';
        setStatus('Modelo local pronto');
        log('WASM e modelo INT8 carregados; detector inicializado.');
      } catch (e) {
        err('Erro ao preparar detector:',e);
        setStatus('Erro ao carregar modelo (F12).');
      }
    }
  };
})();
