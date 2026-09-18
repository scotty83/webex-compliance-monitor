import type { AudioFrame } from '../domain/types.js';
import type { MediaHub } from './types.js';

export interface MediaHubDeps {
  now?: () => number;
  publisherTtlMs?: number;
}

type Subscriber = (f: AudioFrame) => void;

interface Channel {
  subscribers: Set<Subscriber>;
  lastPublishAt: number;
}

export function createMediaHub(deps: MediaHubDeps = {}): MediaHub {
  const now = deps.now ?? Date.now;
  const ttl = deps.publisherTtlMs ?? 3000;
  const channels = new Map<string, Channel>();

  function channel(meetingId: string): Channel {
    let c = channels.get(meetingId);
    if (!c) {
      c = { subscribers: new Set(), lastPublishAt: 0 };
      channels.set(meetingId, c);
    }
    return c;
  }

  return {
    publish(frame: AudioFrame): void {
      const c = channel(frame.meetingId);
      c.lastPublishAt = now();
      for (const sub of c.subscribers) {
        try {
          sub(frame);
        } catch {
          // A slow/broken subscriber (e.g. a backed-up WS) must never break fan-out to others.
        }
      }
    },

    subscribe(meetingId: string, onFrame: Subscriber): () => void {
      const c = channel(meetingId);
      c.subscribers.add(onFrame);
      return () => {
        c.subscribers.delete(onFrame);
      };
    },

    hasPublisher(meetingId: string): boolean {
      const c = channels.get(meetingId);
      if (!c || c.lastPublishAt === 0) return false;
      return now() - c.lastPublishAt < ttl;
    },
  };
}
