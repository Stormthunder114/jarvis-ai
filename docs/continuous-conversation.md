# Conversa contínua do MONZA JARVIS Web

Conecte e pareie o assistente XiaoZhi normalmente. Clique em **Ativar Jarvis**
para autorizar o microfone e inicializar o áudio. Diga “Jarvis” uma vez e faça
perguntas sucessivas. **Encerrar conversa** ou o STT de “Jarvis, encerrar
conversa”, “Jarvis, parar” ou “Jarvis, cancelar” retorna à palavra-chave.
**Desativar Jarvis** libera o microfone. Desmarcar **Conversa contínua** faz a
sessão terminar após uma resposta. Nenhuma configuração anterior do assistente
é sobrescrita.

## Implementação

- `jarvis-local.js`: mantém o detector, configuração WASM e modelos Sherpa;
  uma captura a 16 kHz alimenta tanto KWS quanto diálogo, sem reabrir o microfone
  no despertar. Guarda até 600 ms de áudio anterior para não perder o início.
- `dialogue.js`: IDLE → WAKE_WORD → LISTENING → PROCESSING → SPEAKING →
  LISTENING. VAD de energia RMS com piso de ruído adaptativo e confirmação de
  início (160 ms; 320 ms na interrupção). Silêncio padrão de 1000 ms, ajustável
  na interface; `threshold` e `onsetMs` também são parâmetros do detector.
  Não há duração máxima de pergunta. Um limite de fila de codificação de 10 s
  encerra com erro caso o dispositivo não consiga codificar em tempo real;
  isso não limita a duração de fala quando o codificador acompanha a captura.
- `AudioEngine`: reutiliza o codificador Opus de 960 amostras/60 ms, mantém a
  ordem dos pacotes e completa o último frame antes de `listen.stop`. TTS
  rastreia e cancela todos os `AudioBufferSourceNode`, inclusive fallback,
  e invalida decodificações assíncronas anteriores.
- `ProtocolClient`/`SessionManager`/`ChatEngine`: mantêm WebSocket, contexto,
  MCP e histórico. Eventos STT/TTS reais alimentam o diálogo. Retorno à escuta
  depende de `tts.stop` **e** do término dos buffers locais (`onended`). Não há
  temporizador que presuma o fim da resposta. Assistentes em segundo plano
  não cancelam o áudio do assistente ativo ao desconectar/enviar abort.
- Troca de assistente, texto, microfone manual, aba oculta e fechamento da
  página encerram o diálogo. Falhas e permissões negadas liberam recursos,
  inclusive se a permissão chegar depois de uma desativação. Uma desconexão
  encerra a conversa; reconexão não finge preservar o contexto perdido.

## Protocolo e interrupção

O código do repositório documenta `manual`, mas não demonstra que o endpoint
configurado aceite `auto` ou `realtime`. Não houve uma sessão pareada disponível
para verificar esses modos ao vivo. Este fluxo usa apenas **manual**: VAD local
envia `listen.start`, Opus e `listen.stop`, sempre na mesma sessão XiaoZhi.
Os controles anteriores de modos do aplicativo continuam disponíveis.

O padrão é **alternância automática**, com o microfone aberto mas sem enviar
áudio durante a resposta. A opção de interrupção é **experimental**, desativada
por padrão, exige `getSettings().echoCancellation === true` e deve ser testada
com fones. O navegador recebe pedidos de AEC, supressão de ruído e ganho
automático. Esses pedidos não garantem que eco residual seja eliminado; o VAD
de energia não é um classificador neural de fala e ruído/TV pode dispará-lo.

Ao detectar interrupção, cancela imediatamente os sons locais, envia exatamente
um `sendAbort('user_interruption')` e retém a nova pergunta enquanto aguarda
`tts.stop` da resposta anterior. Só então abre o novo turno manual. Se o stop
já chegou e só restam buffers locais, pode iniciar imediatamente. Se não houver
confirmação em 8 s, encerra com erro explícito, sem simular full-duplex. Esse
prazo detecta falha do abort; não presume conclusão da resposta.

O protocolo observado não fornece IDs de turno para distinguir respostas
atrasadas após abort. Supõe-se que o servidor respeite a ordem `abort → tts.stop`
antes de aceitar o próximo turno. Servidores sem essa garantia devem usar a
alternância padrão. Comandos de encerramento por voz dependem da transcrição
do servidor; durante TTS, só funcionam por voz com interrupção habilitada e
suportada. O botão funciona em qualquer estado.

## Validação realizada

- `npm ci` e `npm run build` concluídos.
- `npm test`: VAD, pergunta de 30 s, pré-captura, múltiplos turnos, ordenação
  Opus/stop, cancelamento assíncrono, abort único, ausência de AEC, encerramento
  por STT, reconexão, passagem para controles antigos, permissões e limpeza.
  Testes de áudio executam o AudioEngine real com Web Audio substituído por
  objetos de teste; não são comprovação acústica nem teste do servidor real.
- Interface e carregamento real do Sherpa WASM inspecionados no navegador,
  incluindo viewport de 390 × 844. Modelos e arquivos de `public/static/kws/`
  não foram alterados.
- `npm run dev` iniciou Vite, mas o `workerd` instalado falhou no Windows com
  access violation. A inspeção visual usou o HTML do worker compilado servido
  por Node com os assets reais. Não valida o proxy WebSocket do Cloudflare.
- A instalação reportou 12 vulnerabilidades nas dependências existentes
  (4 moderadas, 8 altas); este trabalho não atualiza dependências.

## Testes reais antes de produção

1. HTTPS/localhost, permissão concedida/negada/revogada; Chrome desktop,
   Android e Safari/iOS. Navegador sem contexto de áudio a 16 kHz recebe erro
   explícito. O pipeline mantém ScriptProcessor existente, sujeito a limitações
   de desempenho/suspensão dos navegadores móveis.
2. “Jarvis, que horas são?” e perguntas longas, pausas de 800–1800 ms, voz baixa,
   ambiente ruidoso; ajustar limiar/tempo se houver cortes ou falsos positivos.
3. Pergunta de acompanhamento para verificar contexto no mesmo session_id.
   Resposta extensa: não reabrir escuta enquanto ainda houver áudio local.
4. Fones e alto-falantes, diferentes volumes: habilitar interrupção, falar sobre
   TTS e verificar abort, silêncio imediato, confirmação stop e nova pergunta.
   Se houver eco ou ausência de stop, manter a opção desligada.
5. Encerrar por voz/botão em cada estado; trocar assistente, usar mic manual,
   ocultar aba, desconectar/reconectar rede e remover dispositivo de áudio.
   Confirmar ausência de gravação órfã, envio tardio e respostas sobrepostas.

Não foram modificados firmware ESP32, MCP, modelos KWS nem credenciais.
