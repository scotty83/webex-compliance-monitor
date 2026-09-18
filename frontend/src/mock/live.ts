// Dev-only mock of the /live WebSocket + AudioSink (VITE_MOCK=1). Lets the
// chaperone view reach 'listening' with a moving meter without a backend or a
// real Opus stream. Real decode/playback remains a deploy-time verification.

import type { AudioSink } from '../hooks/useLiveAudio';

const HELLO_DELAY_MS = 250;
const NUM_BANDS = 9;

// ── Mock WebSocket ────────────────────────────────────────────────────────────
// Implements exactly the surface useLiveAudio touches: handler properties,
// binaryType, close(). Sends the contract hello after a short delay; no binary
// frames follow (the mock sink synthesises its own levels).

export class MockLiveWebSocket {
  binaryType: BinaryType = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  private helloTimer: ReturnType<typeof setTimeout>;

  constructor(public readonly url: string) {
    this.helloTimer = setTimeout(() => {
      this.onopen?.(new Event('open'));
      this.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'hello', codec: 'opus', sampleRate: 48000 }),
        }),
      );
    }, HELLO_DELAY_MS);
  }

  close(): void {
    clearTimeout(this.helloTimer);
    // useLiveAudio strips handlers before calling close(), so firing onclose
    // here would be a no-op; mirror the real socket by not self-firing events.
  }
}

// ── Mock AudioSink ────────────────────────────────────────────────────────────
// Speech-shaped synthetic levels: an utterance/pause envelope gating a mid-heavy
// band curve with per-band flutter. Deterministic enough to look alive, quiet
// during "pauses" so the paused/active contrast in the meter reads correctly.

export function createMockAudioSink(_sampleRate: number): AudioSink {
  const t0 = performance.now();

  return {
    push() {
      // No frames arrive in mock mode.
    },
    getLevels(): number[] {
      const t = (performance.now() - t0) / 1000;
      // Utterance envelope: ~2.4s of speech, ~0.8s of pause, softened edges.
      const cycle = t % 3.2;
      const speaking = cycle < 2.4 ? Math.min(1, cycle * 4, (2.4 - cycle) * 4) : 0;
      return Array.from({ length: NUM_BANDS }, (_, i) => {
        // Mid bands carry the most energy, like voiced speech.
        const bandGain = 0.35 + 0.65 * Math.exp(-((i - 3.5) ** 2) / 8);
        const flutter =
          0.55 +
          0.25 * Math.sin(t * (5.1 + i * 0.7) + i * 1.9) +
          0.2 * Math.sin(t * (11.3 + i * 1.3));
        return Math.max(0, Math.min(1, speaking * bandGain * flutter));
      });
    },
    destroy() {
      // Nothing to release.
    },
  };
}
