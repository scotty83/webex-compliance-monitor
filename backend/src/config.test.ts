/**
 * Numeric env parsing is fail-LOUD (review rule): a typo'd value must never
 * become NaN — setInterval(fn, NaN) clamps to 1 ms (API hammering) and
 * `aloneMs >= NaN` is never true (solitude silently disabled). A set-but-bad
 * value logs ONE loud console.error naming the var and uses the documented
 * default instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

const ENV_KEYS = [
  'APP_SECRET', 'PORT', 'CALENDAR_SYNC_INTERVAL_S', 'CALENDAR_WINDOW_H',
  'ROSTER_POLL_INTERVAL_S', 'SOLITUDE_TIMEOUT_S', 'BOT_MAX_ATTEMPTS', 'BOT_RETRY_MAX_DELAY_S',
] as const;

describe('loadConfig — numeric env parsing', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.APP_SECRET = 'config-test-secret'; // required, no default
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('parses valid numeric env vars', () => {
    process.env.PORT = '5005';
    process.env.CALENDAR_SYNC_INTERVAL_S = '120';
    process.env.CALENDAR_WINDOW_H = '8';
    process.env.ROSTER_POLL_INTERVAL_S = '10';
    process.env.SOLITUDE_TIMEOUT_S = '300';
    process.env.BOT_MAX_ATTEMPTS = '20';
    process.env.BOT_RETRY_MAX_DELAY_S = '45';
    const cfg = loadConfig();
    expect(cfg.port).toBe(5005);
    expect(cfg.webex.calendarSyncIntervalS).toBe(120);
    expect(cfg.webex.calendarWindowH).toBe(8);
    expect(cfg.webex.rosterPollIntervalS).toBe(10);
    expect(cfg.webex.solitudeTimeoutS).toBe(300);
    expect(cfg.botRetry.maxAttempts).toBe(20);
    expect(cfg.botRetry.maxDelayS).toBe(45);
  });

  it('missing (or blank) numeric env vars fall back to the documented defaults, silently', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CALENDAR_WINDOW_H = ''; // blank in a .env file ≙ unset, not 0
    const cfg = loadConfig();
    expect(cfg.port).toBe(4000);
    expect(cfg.webex.calendarSyncIntervalS).toBe(300);
    expect(cfg.webex.calendarWindowH).toBe(24);
    expect(cfg.webex.rosterPollIntervalS).toBe(20);
    expect(cfg.webex.solitudeTimeoutS).toBe(600);
    expect(cfg.botRetry.maxAttempts).toBe(12); // generous default: ~4-minute admit window
    expect(cfg.botRetry.maxDelayS).toBe(30);
    expect(errSpy).not.toHaveBeenCalled(); // absent ≠ misconfigured — no noise
    errSpy.mockRestore();
  });

  it('garbage numeric env → LOUD console.error naming the var, default used (never NaN)', () => {
    // Repo convention: silence the expected loud lines AND assert they fired.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CALENDAR_SYNC_INTERVAL_S = 'three hundred'; // NaN → 1 ms setInterval before fix
    process.env.SOLITUDE_TIMEOUT_S = '-5'; // negative is as broken as NaN here
    const cfg = loadConfig();
    expect(cfg.webex.calendarSyncIntervalS).toBe(300);
    expect(cfg.webex.solitudeTimeoutS).toBe(600);
    const logged = errSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('CALENDAR_SYNC_INTERVAL_S'))).toBe(true);
    expect(logged.some((l) => l.includes('SOLITUDE_TIMEOUT_S'))).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(2); // exactly ONE loud line per bad var
    errSpy.mockRestore();
  });

  // 0 passed the old `n < 0` guard, defeating the very hammering it was meant to
  // stop: setInterval(fn, 0) fires a Webex fetch every tick, and a 0 backoff cap
  // turns the join retry into a storm. These vars must be strictly positive.
  it('rejects 0 for interval/window/retry vars → LOUD line + default (no hammering)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CALENDAR_SYNC_INTERVAL_S = '0';
    process.env.ROSTER_POLL_INTERVAL_S = '0';
    process.env.CALENDAR_WINDOW_H = '0';
    process.env.BOT_MAX_ATTEMPTS = '0';
    process.env.BOT_RETRY_MAX_DELAY_S = '0';
    const cfg = loadConfig();
    expect(cfg.webex.calendarSyncIntervalS).toBe(300);
    expect(cfg.webex.rosterPollIntervalS).toBe(20);
    expect(cfg.webex.calendarWindowH).toBe(24);
    expect(cfg.botRetry.maxAttempts).toBe(12);
    expect(cfg.botRetry.maxDelayS).toBe(30);
    const logged = errSpy.mock.calls.map((c) => String(c[0]));
    for (const k of ['CALENDAR_SYNC_INTERVAL_S', 'ROSTER_POLL_INTERVAL_S', 'CALENDAR_WINDOW_H',
      'BOT_MAX_ATTEMPTS', 'BOT_RETRY_MAX_DELAY_S']) {
      expect(logged.some((l) => l.includes(k)), `no loud line for ${k}`).toBe(true);
    }
    errSpy.mockRestore();
  });

  // 0 is MEANINGFUL for these two, so the positive-only guard must not touch them:
  // PORT=0 asks the OS for an ephemeral port, and SOLITUDE_TIMEOUT_S=0 means
  // "hang up as soon as the bot is alone" (no grace period).
  it('still accepts 0 where 0 is a legitimate value (PORT, SOLITUDE_TIMEOUT_S)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PORT = '0';
    process.env.SOLITUDE_TIMEOUT_S = '0';
    const cfg = loadConfig();
    expect(cfg.port).toBe(0);
    expect(cfg.webex.solitudeTimeoutS).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('calendarSyncEnabled defaults true and is disabled by CALENDAR_SYNC_ENABLED=false', () => {
    delete process.env.CALENDAR_SYNC_ENABLED;
    expect(loadConfig().webex.calendarSyncEnabled).toBe(true);
    process.env.CALENDAR_SYNC_ENABLED = 'false';
    expect(loadConfig().webex.calendarSyncEnabled).toBe(false);
    delete process.env.CALENDAR_SYNC_ENABLED;
  });

  // The guest subject is derived, so a guest user Webex has wedged is re-derived
  // identically on every retry. This env var is the only fleet-wide way out.
  it('guestSubjectPrefix defaults to compliance-bot and is overridable by WEBEX_GUEST_SUBJECT_PREFIX', () => {
    delete process.env.WEBEX_GUEST_SUBJECT_PREFIX;
    expect(loadConfig().webex.guestSubjectPrefix).toBe('compliance-bot');
    process.env.WEBEX_GUEST_SUBJECT_PREFIX = 'compliance-bot-v2';
    expect(loadConfig().webex.guestSubjectPrefix).toBe('compliance-bot-v2');
    delete process.env.WEBEX_GUEST_SUBJECT_PREFIX;
  });

  it('exposes bot-page asset dir and chromium path', () => {
    const cfg = loadConfig();
    expect(typeof cfg.botPage.assetDir).toBe('string');
    expect(typeof cfg.botPage.chromiumPath).toBe('string');
  });
});
