/* MONZA JARVIS Web — wake word experimental (Chrome Web Speech API)
 * Does not modify Xiaozhi protocol or ESP32 firmware.
 * Note: Chrome speech recognition may send audio to its recognition service.
 */
(() => {
  'use strict';
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const panel = document.createElement('div');
  panel.id = 'jarvisWakePanel';
  panel.style.cssText = 'position:fixed;right:18px;bottom:90px;z-index:10000;display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:12px;background:#152235;color:#fff;box-shadow:0 4px 20px #0006;font:13px system-ui,sans-serif;';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Ativar Jarvis';
  button.style.cssText = 'border:0;background:#087de4;color:#fff;padding:9px;border-radius:8px;cursor:pointer;font:inherit;';
  const status = document.createElement('span');
  status.textContent = SpeechRecognition ? 'Desativado' : 'Chrome não compatível';
  status.setAttribute('role', 'status');
  status.style.cssText = 'max-width:170px;';
  panel.append(button, status);
  document.body.appendChild(panel);
  if (!SpeechRecognition) { button.disabled = true; return; }

  let enabled = false;
  let listening = false;
  let busy = false;
  let pendingStart = null;
  let captureTimer = null;
  let recognition = null;
  function setStatus(message) { status.textContent = message; }
  function queueStart(delay = 700) {
    if (!enabled || busy || document.hidden || pendingStart) return;
    pendingStart = setTimeout(() => {
      pendingStart = null;
      if (enabled && !busy && !listening && !document.hidden) {
        try { recognition.start(); } catch (e) { setStatus('Falha ao iniciar: ' + e.message); }
      }
    }, delay);
  }
  function stopRecognition() {
    if (pendingStart) { clearTimeout(pendingStart); pendingStart = null; }
    if (listening) { try { recognition.abort(); } catch (_) {} }
  }
  function deactivate() {
    enabled = false;
    button.textContent = 'Ativar Jarvis';
    stopRecognition();
    setStatus('Desativado');
  }
  function micButton() { return document.getElementById('micBtn'); }
  function connected() {
    // Web client provides the existing mic button; its click handler checks the session.
    const m = micButton();
    return !!(m && !m.disabled);
  }
  function trigger() {
    if (busy || !enabled) return;
    busy = true;
    stopRecognition();
    setStatus('Jarvis detectado! Fale após o sinal.');
    // Release Web Speech microphone before opening the existing Xiaozhi Opus microphone.
    setTimeout(() => {
      if (!enabled) { busy = false; return; }
      if (!connected()) {
        setStatus('Conecte ao XiaoZhi antes de falar');
        busy = false;
        queueStart(2500);
        return;
      }
      const m = micButton();
      if (m.classList.contains('active')) {
        setStatus('Microfone já está em uso');
        busy = false;
        queueStart(2500);
        return;
      }
      m.click(); // Original OLIVIA handler, preserving normal audio/Opus pipeline.
      setStatus('Ouvindo seu comando (até 9 s)...');
      captureTimer = setTimeout(() => {
        captureTimer = null;
        if (micButton()?.classList.contains('active')) micButton().click();
        setStatus('Aguardando resposta...');
        // Allows TTS time to finish before rearming; not a precise TTS-state signal.
        setTimeout(() => {
          busy = false;
          if (enabled) { setStatus('Diga “Jarvis”'); queueStart(); }
        }, 13000);
      }, 4000);
  }, 150);
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'pt-BR';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => { listening = true; if (enabled && !busy) setStatus('Diga “Jarvis”'); };
  recognition.onend = () => { listening = false; queueStart(750); };
  recognition.onerror = (event) => {
    listening = false;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      deactivate(); setStatus('Autorize o microfone no Chrome'); return;
    }
    setStatus('Reconhecimento: ' + event.error);
    queueStart(2200);
  };
  recognition.onresult = (event) => {
    if (!enabled || busy) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const words = event.results[i][0]?.transcript || '';
      if (/\bjarvis\b/i.test(words.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
        trigger(); return;
      }
    }
  };
  button.addEventListener('click', () => {
    if (enabled) deactivate();
    else { enabled = true; button.textContent = 'Desativar Jarvis'; setStatus('Iniciando microfone...'); queueStart(50); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopRecognition(); if (enabled && !busy) setStatus('Pausado: aba em segundo plano'); }
    else queueStart(1000);
  });
})();
