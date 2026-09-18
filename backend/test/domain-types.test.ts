import { describe, it, expect } from 'vitest';
import type {
  BotState, ChaperonedMeeting, BotStatus, AudioFrame,
  AuditAction, AuditEntry, Role, Officer, RosterAttendee,
} from '../src/domain/types.js';

// Compile-time coverage: each construction must type-check; runtime asserts the shape.
describe('domain types', () => {
  it('constructs a ChaperonedMeeting + BotStatus', () => {
    const state: BotState = 'connected';
    const m: ChaperonedMeeting = {
      meetingId: 'uuid-1', sipUri: '12345@site.webex.com', title: 'Analyst call', createdAt: 1,
    };
    const bot: BotStatus = { meetingId: m.meetingId, state, joinedAt: 2, updatedAt: 3 };
    expect(bot.state).toBe('connected');
    expect(m.sipUri).toContain('@');
  });

  it('constructs an AudioFrame, AuditEntry, Officer, RosterAttendee', () => {
    const frame: AudioFrame = {
      meetingId: 'uuid-1', seq: 0, timestampMs: 1, codec: 'opus', payload: new Uint8Array([1, 2]),
    };
    const action: AuditAction = 'listen_start';
    const entry: AuditEntry = { id: 'a1', action, meetingId: 'uuid-1', officerEmail: 'o@x.com', at: 4 };
    const role: Role = 'admin';
    const officer: Officer = { email: 'o@x.com', role };
    const member: RosterAttendee = {
      id: 'p-bot', name: 'Compliance Monitor Bot', role: 'bot',
      isHost: false, joinedAt: 1, leftAt: null,
    };
    expect(frame.codec).toBe('opus');
    expect(entry.action).toBe('listen_start');
    expect(officer.role).toBe('admin');
    expect(member.role).toBe('bot');
  });
});
