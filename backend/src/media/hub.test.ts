import { describe, it, expect } from 'vitest';
import { createMediaHub } from './hub.js';
import type { AudioFrame } from '../domain/types.js';

function frame(meetingId: string, seq: number): AudioFrame {
  return { meetingId, seq, timestampMs: 1000 + seq, codec: 'opus', payload: new Uint8Array([seq & 0xff]) };
}

describe('createMediaHub', () => {
  it('fans a published frame out to every subscriber of that meeting only', () => {
    const hub = createMediaHub();
    const a: AudioFrame[] = [];
    const b: AudioFrame[] = [];
    const other: AudioFrame[] = [];
    hub.subscribe('m1', (f) => a.push(f));
    hub.subscribe('m1', (f) => b.push(f));
    hub.subscribe('m2', (f) => other.push(f));

    hub.publish(frame('m1', 0));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].payload).toEqual(new Uint8Array([0]));
    expect(other).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = createMediaHub();
    const got: AudioFrame[] = [];
    const unsub = hub.subscribe('m1', (f) => got.push(f));
    hub.publish(frame('m1', 0));
    unsub();
    hub.publish(frame('m1', 1));
    expect(got).toHaveLength(1);
  });

  it('isolates a throwing subscriber from the rest of the fan-out', () => {
    const hub = createMediaHub();
    const ok: AudioFrame[] = [];
    hub.subscribe('m1', () => { throw new Error('boom'); });
    hub.subscribe('m1', (f) => ok.push(f));
    expect(() => hub.publish(frame('m1', 0))).not.toThrow();
    expect(ok).toHaveLength(1);
  });

  it('reports hasPublisher only within the publisher TTL window', () => {
    let t = 1000;
    const hub = createMediaHub({ now: () => t, publisherTtlMs: 3000 });
    expect(hub.hasPublisher('m1')).toBe(false);   // no frame yet
    hub.publish(frame('m1', 0));
    expect(hub.hasPublisher('m1')).toBe(true);
    t += 2999;
    expect(hub.hasPublisher('m1')).toBe(true);
    t += 2;                                        // now 3001 ms since last frame
    expect(hub.hasPublisher('m1')).toBe(false);
    expect(hub.hasPublisher('m2')).toBe(false);   // unknown meeting
  });
});
