import { describe, it, expect } from 'vitest';
import { formatCallerId, attendeeLabel } from './participants';
import type { Attendee } from '../types';

describe('formatCallerId', () => {
  it('10-digit NANP number → (NPA) NXX-XXXX', () => {
    expect(formatCallerId('8452338546')).toBe('(845) 233-8546');
  });

  it('11-digit with leading 1 → +1 (NPA) NXX-XXXX', () => {
    expect(formatCallerId('18452338546')).toBe('+1 (845) 233-8546');
  });

  it('11-digit NOT starting with 1 → raw passthrough', () => {
    expect(formatCallerId('28452338546')).toBe('28452338546');
  });

  it('masked string (non-10/11 stripped digits) → raw passthrough', () => {
    expect(formatCallerId('8452****46')).toBe('8452****46');
  });

  it('international number (e.g. +44…) passes through', () => {
    expect(formatCallerId('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });

  it('empty string → empty string', () => {
    expect(formatCallerId('')).toBe('');
  });
});

function makeAttendee(over: Partial<Attendee> = {}): Attendee {
  return {
    id: 'a1', name: 'Alex Chen', role: 'analyst', isHost: false,
    joinedAt: 1000, leftAt: null, ...over,
  };
}

describe('attendeeLabel', () => {
  it('PSTN attendee with phone → formatted number', () => {
    expect(attendeeLabel(makeAttendee({ pstn: true, phone: '8452338546' }))).toBe('(845) 233-8546');
  });

  it('PSTN attendee without phone → falls back to name', () => {
    expect(attendeeLabel(makeAttendee({ pstn: true, phone: undefined }))).toBe('Alex Chen');
  });

  it('non-PSTN attendee → name regardless of phone', () => {
    expect(attendeeLabel(makeAttendee({ pstn: false, phone: '8452338546' }))).toBe('Alex Chen');
  });

  it('attendee with no pstn field → name', () => {
    expect(attendeeLabel(makeAttendee())).toBe('Alex Chen');
  });
});
