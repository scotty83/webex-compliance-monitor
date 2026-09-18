import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index.js';
import { insertMeeting, getMeeting, listMeetings, deleteMeeting } from '../src/db/meetings.js';

describe('meetings data-access', () => {
  it('inserts and reads back a meeting with a generated id and createdAt', () => {
    const db = openDb();
    const m = insertMeeting(db, { sipUri: '111@site.webex.com', title: 'Call A' });
    expect(m.meetingId).toMatch(/[0-9a-f-]{36}/);
    expect(m.createdAt).toBeGreaterThan(0);
    expect(getMeeting(db, m.meetingId)).toEqual(m);
  });

  it('round-trips optional fields and maps snake_case columns', () => {
    const db = openDb();
    const m = insertMeeting(db, {
      sipUri: '222@site.webex.com', title: 'Call B',
      webexMeetingId: 'wx-9', scheduledStart: 1000, scheduledEnd: 2000,
    });
    const got = getMeeting(db, m.meetingId)!;
    expect(got.webexMeetingId).toBe('wx-9');
    expect(got.scheduledStart).toBe(1000);
    expect(got.scheduledEnd).toBe(2000);
  });

  it('round-trips dtmf field (credential)', () => {
    const db = openDb();
    const m = insertMeeting(db, {
      sipUri: '333@site.webex.com', title: 'Call C', dtmf: '1234#',
    });
    expect(m.dtmf).toBe('1234#');
    const got = getMeeting(db, m.meetingId)!;
    expect(got.dtmf).toBe('1234#');
  });

  it('lists all meetings and deletes one', () => {
    const db = openDb();
    const a = insertMeeting(db, { sipUri: '1@s.webex.com', title: 'A' });
    insertMeeting(db, { sipUri: '2@s.webex.com', title: 'B' });
    expect(listMeetings(db)).toHaveLength(2);
    deleteMeeting(db, a.meetingId);
    expect(getMeeting(db, a.meetingId)).toBeUndefined();
    expect(listMeetings(db)).toHaveLength(1);
  });
});
