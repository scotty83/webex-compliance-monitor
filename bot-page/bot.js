// Thin browser entry. window.Webex comes from the vendored webex.min.js loaded
// by index.html. Config + WS URL are injected by the runner via window.__BOT_START.
import { runBotPage } from './botPageCore.js';

function makeAudioEncoder(onChunk, onError) {
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      onChunk(buf);
    },
    error: onError,
  });
  encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, opus: { frameDuration: 20000 } });
  return { encode: (audioData) => encoder.encode(audioData), close: () => { try { encoder.close(); } catch {} } };
}

async function* makeTrackReader(track) {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value; // AudioData — the consumer owns it and must close() it
    }
  } finally {
    // The consumer breaks out of this loop on leave(); without cancelling, the
    // MediaStreamTrackProcessor keeps pulling frames from a still-open
    // AudioContext for the life of the page.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

// Web-Audio mixer: every remote audio stream is connected to one destination node,
// so `track` is a single 48kHz MONO mixed track (= the room audio) that we encode once.
// Mono is required: the Opus encoder is configured numberOfChannels:1 (matching the
// console's decoder), so a stereo mixed track fails with "Input audio buffer is
// incompatible with codec parameters". channelCountMode:'explicit' down-mixes to 1ch.
function makeMixer() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  dest.channelCountMode = 'explicit';
  dest.channelInterpretation = 'speakers';
  const sinks = []; // keep <audio> elements alive (see below) so Chromium keeps pulling samples
  return {
    addStream(stream) {
      // Chromium will NOT pump a remote WebRTC audio track into Web Audio unless the stream
      // is also consumed by a playing media element. Headless has no speakers, so nothing is
      // actually heard, but the element pulling samples is what makes createMediaStreamSource
      // deliver real audio instead of silence. Keep a reference so it isn't garbage-collected.
      const el = new Audio();
      el.srcObject = stream;
      el.autoplay = true;
      el.play().catch(() => {});
      sinks.push(el);
      ctx.createMediaStreamSource(stream).connect(dest);
      if (ctx.state === 'suspended') ctx.resume();
    },
    get track() { return dest.stream.getAudioTracks()[0]; },
  };
}

window.__BOT_START = (cfg, wsUrl) => {
  const ws = new WebSocket(wsUrl);
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const sendAudio = (bytes) => ws.readyState === WebSocket.OPEN && ws.send(bytes);
  ws.onopen = () => {
    runBotPage(cfg, {
      Webex: window.Webex,
      makeAudioEncoder, makeTrackReader, makeMixer, send, sendAudio,
      log: (line) => send({ type: 'log', line }),
    }).then((h) => { window.__BOT_LEAVE = h.leave; });
  };
};
