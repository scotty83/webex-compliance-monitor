import { describe, it, expect } from 'vitest';
import type { MediaHub, BotManager } from '../src/media/types.js';
import type { AudioFrame, ChaperonedMeeting, BotStatus } from '../src/domain/types.js';

// Conforming mocks prove the interface shapes are usable by the media implementations.
describe('media interfaces', () => {
  it('a MediaHub mock satisfies publish/subscribe/hasPublisher', () => {
    const frames: AudioFrame[] = [];
    const hub: MediaHub = {
      publish: (f) => frames.push(f),
      subscribe: (_id, onFrame) => {
        onFrame(frames[frames.length - 1]);
        return () => undefined;
      },
      hasPublisher: (id) => frames.some((f) => f.meetingId === id),
    };
    hub.publish({ meetingId: 'm1', seq: 0, timestampMs: 1, codec: 'opus', payload: new Uint8Array([9]) });
    expect(hub.hasPublisher('m1')).toBe(true);
    let seen: AudioFrame | undefined;
    const off = hub.subscribe('m1', (f) => (seen = f));
    expect(seen?.payload[0]).toBe(9);
    expect(typeof off).toBe('function');
  });

  it('a BotManager mock satisfies startBot/stopBot/onStatus', async () => {
    const statuses: BotStatus[] = [];
    const meeting: ChaperonedMeeting = { meetingId: 'm1', sipUri: '1@s.webex.com', title: 'A', createdAt: 1 };
    const mgr: BotManager = {
      startBot: async (m) => { statuses.push({ meetingId: m.meetingId, state: 'dialing', updatedAt: 2 }); },
      stopBot: async () => undefined,
      onStatus: (cb) => cb({ meetingId: 'm1', state: 'connected', updatedAt: 3 }),
    };
    await mgr.startBot(meeting);
    let last: BotStatus | undefined;
    mgr.onStatus((s) => (last = s));
    expect(statuses[0].state).toBe('dialing');
    expect(last?.state).toBe('connected');
  });
});
