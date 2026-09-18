import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken, redirectToLogin } from '../auth/session';
import { createMockAudioSink, MockLiveWebSocket } from '../mock/live';

// Dev-only mock mode (VITE_MOCK=1). Inlined at build time — in real builds the
// mock branches are dead code and mock/live.ts is tree-shaken away.
const IS_MOCK = import.meta.env.VITE_MOCK === '1';

// ── AudioSink seam ────────────────────────────────────────────────────────────
// The decode / playback / analyser pipeline sits behind this interface.
// The WS state machine only depends on this interface, so tests can inject a
// stub AudioSink and never touch WebCodecs or AudioContext (neither exists in
// jsdom).

export interface AudioSink {
  /** Called for every raw Opus frame received from the server. */
  push(frame: ArrayBuffer): void;
  /** Returns 9 normalised band levels (0..1) for the current animation frame. */
  getLevels(): number[];
  /** Tears down all audio resources (AudioContext, decoder, analyser). */
  destroy(): void;
}

export type AudioSinkFactory = (sampleRate: number) => AudioSink;

// ── Real AudioSink (Chromium target: WebCodecs + Web Audio) ──────────────────
// Feature-detected at instantiation time; throws if AudioDecoder is absent so
// the hook surfaces the error cleanly. There is NO server-side PCM fallback —
// the backend contract always sends Opus.

const createRealAudioSink: AudioSinkFactory = (sampleRate: number): AudioSink => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof AudioDecoder === 'undefined') {
    throw new Error("This browser can't decode the audio stream");
  }

  const ctx = new AudioContext({ sampleRate });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.connect(ctx.destination);

  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const JITTER_S = 0.04; // 40 ms scheduling lead for smooth playback
  let nextSchedule = ctx.currentTime;

  const decoder = new AudioDecoder({
    output(audioData: AudioData) {
      const frames   = audioData.numberOfFrames;
      const channels = audioData.numberOfChannels;
      const buf      = ctx.createBuffer(channels, frames, sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        audioData.copyTo(buf.getChannelData(ch), { planeIndex: ch });
      }
      audioData.close();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      const startAt   = Math.max(ctx.currentTime + JITTER_S, nextSchedule);
      src.start(startAt);
      nextSchedule = startAt + buf.duration;
    },
    error(e: DOMException) {
      console.error('[useLiveAudio] AudioDecoder error:', e.message);
    },
  });

  decoder.configure({ codec: 'opus', sampleRate, numberOfChannels: 1 });

  return {
    push(frame: ArrayBuffer) {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: 0, data: frame }));
    },
    getLevels() {
      analyser.getByteFrequencyData(freqData);
      const bins = analyser.frequencyBinCount;
      const band = Math.floor(bins / NUM_BANDS);
      return Array.from({ length: NUM_BANDS }, (_, i) => {
        const start = i * band;
        let sum = 0;
        for (let j = start; j < start + band; j++) sum += freqData[j] ?? 0;
        return band > 0 ? Math.min(1, sum / (band * 255)) : 0;
      });
    },
    destroy() {
      try { decoder.close(); } catch { /* already closed */ }
      void ctx.close();
    },
  };
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveStatus = 'idle' | 'connecting' | 'listening' | 'paused' | 'error';

export interface LiveAudioError {
  code?: number;
  message: string;
}

export interface UseLiveAudioResult {
  status: LiveStatus;
  /** Always length 9, each value 0..1. Flat (all zeros) when paused or reduced-motion. */
  levels: number[];
  error?: LiveAudioError;
  pause(): void;
  resume(): void;
}

// ── Internal constants ────────────────────────────────────────────────────────

const NUM_BANDS = 9;
const FLAT: readonly number[] = Object.freeze(Array<number>(NUM_BANDS).fill(0));

function buildWsUrl(meetingId: string, token: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Token goes into query string per contract. It is NEVER logged.
  return `${proto}//${location.host}/live/${meetingId}?token=${token}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useLiveAudio(
  opts: { meetingId: string; active: boolean },
  sinkFactory: AudioSinkFactory = IS_MOCK ? createMockAudioSink : createRealAudioSink,
): UseLiveAudioResult {
  const { meetingId, active } = opts;

  const [status, setStatus] = useState<LiveStatus>('idle');
  const [levels, setLevels] = useState<number[]>([...FLAT]);
  const [error, setError]   = useState<LiveAudioError | undefined>(undefined);

  // ── Mutable refs (no re-render on change) ─────────────────────────────────
  const wsRef          = useRef<WebSocket | null>(null);
  const sinkRef        = useRef<AudioSink | null>(null);
  const rafRef         = useRef<number | null>(null);
  const mountedRef     = useRef(true);
  const wantOpenRef    = useRef(false);
  const hasHelloRef    = useRef(false);
  const retriedRef     = useRef(false);
  const meetingIdRef   = useRef(meetingId);
  const sinkFactoryRef = useRef(sinkFactory);
  meetingIdRef.current   = meetingId;
  sinkFactoryRef.current = sinkFactory;

  // Checked once at mount so we don't animate bars for users who prefer no motion.
  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  // ── Stable imperative helpers ─────────────────────────────────────────────
  // All helpers only access refs or stable React state setters, so their dep
  // arrays are legitimately empty (they never go stale).

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const destroySink = useCallback(() => {
    if (sinkRef.current) {
      sinkRef.current.destroy();
      sinkRef.current = null;
    }
  }, []);

  const closeWs = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      // Strip handlers before close to prevent onclose re-entring teardown.
      ws.onopen    = null;
      ws.onmessage = null;
      ws.onerror   = null;
      ws.onclose   = null;
      wsRef.current = null;
      ws.close();
    }
    hasHelloRef.current = false;
  }, []);

  const teardown = useCallback(() => {
    stopRaf();
    closeWs();
    destroySink();
  }, [stopRaf, closeWs, destroySink]);

  const startRaf = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame === 'undefined') return; // jsdom safety
    const tick = () => {
      if (!mountedRef.current) { rafRef.current = null; return; }
      if (reducedMotion.current) { rafRef.current = null; return; }
      if (sinkRef.current) {
        const raw = sinkRef.current.getLevels();
        setLevels(raw.length === NUM_BANDS ? raw : [...FLAT]);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // ── connectRef ────────────────────────────────────────────────────────────
  // Re-assigned every render so it always closes over the latest stable refs.
  // The retry in onclose calls connectRef.current() to avoid a stale-closure
  // problem that would arise if connect were a regular useCallback with deps.

  const connectRef = useRef<() => void>(() => { /* placeholder */ });

  connectRef.current = () => {
    if (wsRef.current) return; // already opening / open

    const token = getToken();
    if (!token) {
      setStatus('error');
      setError({ message: 'Session expired — sign in again' });
      redirectToLogin();
      return;
    }

    const url = buildWsUrl(meetingIdRef.current, token);

    let ws: WebSocket;
    try {
      ws = IS_MOCK
        ? (new MockLiveWebSocket(url) as unknown as WebSocket)
        : new WebSocket(url);
    } catch (e) {
      setStatus('error');
      setError({ message: e instanceof Error ? e.message : 'WebSocket failed to open' });
      return;
    }
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    if (mountedRef.current) setStatus('connecting');

    // Server sends the hello first; nothing to send on open.
    ws.onopen = () => { /* intentionally empty */ };

    ws.onmessage = (evt: MessageEvent) => {
      if (!mountedRef.current) return;

      if (!hasHelloRef.current) {
        // First message must be the hello JSON frame.
        if (typeof evt.data === 'string') {
          try {
            const msg = JSON.parse(evt.data) as Record<string, unknown>;
            if (msg['type'] === 'hello') {
              hasHelloRef.current = true;
              const sr = typeof msg['sampleRate'] === 'number' ? msg['sampleRate'] : 48000;
              try {
                sinkRef.current = sinkFactoryRef.current(sr);
              } catch (e) {
                const message = e instanceof Error ? e.message : 'Audio init failed';
                setStatus('error');
                setError({ message });
                teardown();
                return;
              }
              setError(undefined);
              setStatus('listening');
              // A successful (re)connection restores the single-retry budget.
              // Only a successful hello re-arms it — a failing retry must not
              // (bounded to ONE reconnect per connect attempt, per T5 review).
              retriedRef.current = false;
              startRaf();
            }
          } catch { /* malformed JSON hello — ignore */ }
        }
        return;
      }

      // After hello: binary Opus frames arrive.
      if (evt.data instanceof ArrayBuffer && sinkRef.current) {
        sinkRef.current.push(evt.data);
      }
    };

    ws.onerror = () => { /* onclose always follows; all cleanup is there */ };

    ws.onclose = (evt: CloseEvent) => {
      wsRef.current     = null;
      hasHelloRef.current = false;
      stopRaf();
      destroySink();

      if (!mountedRef.current) return;

      // ── Error close codes ──────────────────────────────────────────────
      if (evt.code === 4401) {
        setStatus('error');
        setError({ code: 4401, message: 'Session expired — sign in again' });
        redirectToLogin();
        return;
      }
      if (evt.code === 4404) {
        // Fail-loud: the officer must see the coverage gap clearly.
        setStatus('error');
        setError({ code: 4404, message: 'Bot not connected' });
        return;
      }
      // Normal close (1000) comes from pause() / active=false — no action.
      if (evt.code === 1000) return;

      // Unexpected drop while we want the connection: attempt one reconnect.
      if (wantOpenRef.current && !retriedRef.current) {
        retriedRef.current = true;
        setStatus('connecting');
        setError({ message: `Connection lost (${evt.code}) — retrying` });
        setTimeout(() => {
          if (mountedRef.current && wantOpenRef.current) connectRef.current();
        }, 1_000);
        return;
      }
      if (wantOpenRef.current) {
        setStatus('error');
        setError({ message: `Connection lost (${evt.code})` });
      }
    };
  };

  // ── pause / resume ────────────────────────────────────────────────────────

  const pause = useCallback(() => {
    wantOpenRef.current = false;
    teardown(); // strips onclose handlers, then closes — no re-entry
    if (mountedRef.current) {
      setStatus('paused');
      setLevels([...FLAT]);
    }
  }, [teardown]);

  const resume = useCallback(() => {
    if (!mountedRef.current) return;
    wantOpenRef.current = true;
    retriedRef.current = false;
    if (!wsRef.current) connectRef.current();
  }, []);

  // ── Effect: gate on `active` ──────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    if (active) {
      wantOpenRef.current = true;
      retriedRef.current = false;
      connectRef.current();
    } else {
      wantOpenRef.current = false;
      teardown();
      setStatus('idle');
      setLevels([...FLAT]);
    }
    return () => {
      mountedRef.current  = false;
      wantOpenRef.current = false;
      teardown();
    };
  }, [active, meetingId, teardown]);

  return { status, levels, error, pause, resume };
}
