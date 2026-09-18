import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEYS = [
  'APP_SECRET', 'WEBEX_SCHEDULER_EMAIL', 'INTERNAL_EMAIL_DOMAINS',
  'CALENDAR_SYNC_INTERVAL_S', 'CALENDAR_WINDOW_H', 'ROSTER_POLL_INTERVAL_S', 'SOLITUDE_TIMEOUT_S',
  'CALENDAR_SYNC_ENABLED', 'WEBEX_GUEST_SUBJECT_PREFIX',
] as const;

describe('loadConfig — webex section', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.APP_SECRET = 'test-secret';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('applies spec defaults when the env vars are unset', () => {
    const cfg = loadConfig();
    expect(cfg.webex).toEqual({
      schedulerEmail: '',
      internalEmailDomains: [],
      calendarSyncIntervalS: 300,
      calendarWindowH: 24,
      rosterPollIntervalS: 20,
      solitudeTimeoutS: 600,
      calendarSyncEnabled: true,
      guestSubjectPrefix: 'compliance-bot',
    });
  });

  it('parses values; INTERNAL_EMAIL_DOMAINS is comma-split, trimmed, lowercased', () => {
    process.env.WEBEX_SCHEDULER_EMAIL = 'scheduler@bank.example';
    process.env.INTERNAL_EMAIL_DOMAINS = ' Bank.example, corp.example ';
    process.env.CALENDAR_SYNC_INTERVAL_S = '60';
    process.env.CALENDAR_WINDOW_H = '12';
    process.env.ROSTER_POLL_INTERVAL_S = '5';
    process.env.SOLITUDE_TIMEOUT_S = '0';
    const cfg = loadConfig();
    expect(cfg.webex.schedulerEmail).toBe('scheduler@bank.example');
    expect(cfg.webex.internalEmailDomains).toEqual(['bank.example', 'corp.example']);
    expect(cfg.webex.calendarSyncIntervalS).toBe(60);
    expect(cfg.webex.calendarWindowH).toBe(12);
    expect(cfg.webex.rosterPollIntervalS).toBe(5);
    expect(cfg.webex.solitudeTimeoutS).toBe(0);
  });
});
