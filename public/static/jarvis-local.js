/* MONZA JARVIS Web — ativacao local Sherpa-ONNX (versao de teste 1)
 * Funciona com o Sherpa-ONNX WASM compilado no workflow build-jarvis-wasm.yml.
 * Nao altera app.js nem o protocolo de voz do XiaoZhi.
 * Modelos ONNX estao incorporados no arquivo .data compilado.
 */
(() => {
  'use strict';

  const KWS_DIR = '/static/kws/';
  const KEYWORDS_URL = KWS_DIR + 'jarvis_keywords.txt';
  const COMMAND_MAX_MS = 7000;
  const RESPONSE_GUARD_MS = 9000;
  const AUDIO_SAMPLE_RATE = 16000;

  let kws = null;
  let streamKws = null;
  let audio = null;
  let enabled = false;
  let ready = false;
  let phase = 'boot';
  let timer = null;
  let ownsXiaozhiMic = false;
  let starting = false;
  let lastWake = 0;

  const panel = document.createElement('div');
  panel.id = 'jarvisLocalPanel';
  panel.style.cssText = 'position:fixed;right:18px;bottom:90px;z-index:10000;display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:12px;background:#152235;color:white;box-shadow:0 4px 20px #0006;font:13px system-ui,sans-serif;max-width:min(92vw,430px)';
  const button = document.createElement('button');
  button.id = 'jarvisLocalToggle';
  button.type = 'button';
  button.textContent = 'Carregando Jarvis...';
  button.disabled = true;
  button.style.cssText = 'border:0;background:#087de4;color:white;padding:9px 12px;border-radius:8px;cursor:pointer;font:inherit;white-space:nowrap';
  const status = document.createElement('span');
  status.id = 'jarvisLocalStatus';
  status.textContent = 'Preparando modelo offline...';
  status.setAttribute('role', 'status');
  status.style.cssText = 'min-width:110px;overflow-wrap:anywhere';
  panel.append(button, status);
  document.body.appendChild(panel);

  function setStatus(value) { status.textContent = value; }
  function log(...args) { console.log('[Jarvis KWS local]', ...args); }
  function err(...args) { console.error('[Jarvis KWS local]', ...args); }
  function clearTimer() { if (timer) clearTimeout(timer); timer = null; }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function micButton() { return document.getElementById('micBtn'); }

  // O segundo microfone so pertence a esta extensao quando ela propria
  // iniciou a captura por clique. Nunca interrompe o microfone manual do usuario.
  function releaseXiaozhiMic() {
    if (!ownsXiaozhiMic) return;
    ownsXiaozhiMic = false;
    const btn = micButton();
    if (btn && btn.classList.contains('active')) btn.click();
  }

  async function stopLocalCapture() {
    const old = audio;
    audio = null;
    const oldKwsStream = streamKws;
    streamKws = null;
    if (oldKwsStream) { try { oldKwsStream.free(); } catch (_) {} }
    if (!old) return;
    try { old.processor.onaudioprocess = null; old.source.disconnect(); } catch (_) {}
    try { old.processor.disconnect(); old.gain.disconnect(); } catch (_) {}
    try { old.stream.getTracks().forEach(track => track.stop()); } catch (_) {}
    try { await old.context.close(); } catch (_) {}
  }

  async function startLocalCapture() {
    if (!ready || !enabled || audio || starting || document.hidden) return;
    starting = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('microfone indisponivel');
      // Com permissao concedida no primeiro clique, pode reativar apos cada resposta.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}
      });
      if (!enabled || document.hidden) { stream.getTracks().forEach(t => t.stop()); return; }
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Web Audio indisponivel');
      const context = new Context({ sampleRate:AUDIO_SAMPLE_RATE });
      await context.resume();
      if (!enabled || document.hidden) {
        stream.getTracks().forEach(t => t.stop());
        await context.close();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(2048, 1, 1);
      const gain = context.createGain();
      gain.gain.value = 0; // Sem retorno do microfone nos alto-falantes.
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);

      audio = {stream,context,source,processor,gain};
      streamKws = kws.createStream();
      phase = 'waiting';
      setStatus('Diga “Jarvis”');
      log('Microfone local pronto, sample rate:',context.sampleRate);
      processor.onaudioprocess = event => {
        if (!enabled || phase !== 'waiting' || !audio) return;
        try {
          const input = new Float32Array(event.inputBuffer.getChannelData(0));
          streamKws.acceptWaveform(context.sampleRate, input);
          let steps = 0;
          while (kws.isReady(streamKws) && steps++ < 20) {
            kws.decode(streamKws);
            const result = kws.getResult(streamKws);
            if (result?.keyword) {
              kws.reset(streamKws);
              const now = Date.now();
              if (now - lastWake > 1800) {
                lastWake = now;
                phase = 'switching';
                log('Palavra detectada:', result.keyword);
                void activateXiaozhi();
              }
              break;
            }
          }
        } catch (e) {
          err('Falha na inferencia:',e);
          phase = 'error';
          enabled = false;
          button.textContent = 'Ativar Jarvis';
          setStatus('Falha na inferencia. Veja console.');
          void stopLocalCapture();
        }
      };
    } catch (e) {
      err('Nao foi possivel abrir microfone:',e);
      phase = 'error';
      enabled = false;
      button.textContent = 'Ativar Jarvis';
      setStatus('Erro no microfone; autorize no Chrome.');
      await stopLocalCapture();
    } finally { starting = false; }
  }

  async function rearm() {
    if (!enabled || !ready || document.hidden) return;
    clearTimer();
    phase = 'waiting';
    await startLocalCapture();
  }

  async function activateXiaozhi() {
    setStatus('Jarvis reconhecido! Abrindo XiaoZhi...');
    await stopLocalCapture(); // Libera microfone antes de iniciar o Opus/XiaoZhi.
    if (!enabled) return;
    const btn = micButton();
    if (!btn || btn.disabled || btn.classList.contains('active')) {
      setStatus('Conecte o XiaoZhi e desative o microfone manual.');
      timer = setTimeout(() => {timer=null;void rearm();}, 1600);
      return;
    }
    // O codigo original do site responde ao click no botao #micBtn.
    // A integracao MCP/Opus e mantida inteiramente no app.js original.
    await sleep(180);
    if (!enabled) return;
    btn.click();
    ownsXiaozhiMic = true;
    phase = 'command';
    setStatus('Fale seu comando em português...');
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      releaseXiaozhiMic();
      phase = 'response';
      setStatus('Aguardando resposta do XiaoZhi...');
      // Guarda temporaria para evitar ouvir a propria resposta por voz.
      // Etapa futura: rearmar por evento de TTS stop do app.js.
      timer = setTimeout(() => {timer=null;void rearm();}, RESPONSE_GUARD_MS);
    }, COMMAND_MAX_MS);
  }

  button.addEventListener('click', async () => {
    if (enabled) {
      enabled = false;
      clearTimer();
      phase = 'off';
      releaseXiaozhiMic();
      await stopLocalCapture();
      button.textContent = 'Ativar Jarvis';
      setStatus('Desativado');
    } else {
      if (!ready) return;
      enabled = true;
      button.textContent = 'Desativar Jarvis';
      setStatus('Iniciando microfone local...');
      await startLocalCapture();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (enabled && phase === 'waiting') {
        void stopLocalCapture();
        setStatus('Pausado: volte à aba do Jarvis');
      }
    } else if (enabled && phase === 'waiting') void rearm();
  });

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
