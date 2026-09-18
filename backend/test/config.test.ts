import { describe, it, expect } from 'vitest';
import { parseEmails, loadConfig } from '../src/config.js';

describe('parseEmails', () => {
  it('splits, trims, and lowercases comma-separated emails', () => {
    expect(parseEmails('Alice@Corp.com, bob@corp.com')).toEqual(['alice@corp.com', 'bob@corp.com']);
  });
  it('tolerates trailing commas and whitespace, and returns [] for empty/undefined', () => {
    expect(parseEmails('  a@x.com ,, b@x.com ,')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseEmails('')).toEqual([]);
    expect(parseEmails(undefined)).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('applies documented defaults when optional vars are unset', () => {
    const prev = { ...process.env };
    process.env.APP_SECRET = 'test-secret';
    delete process.env.PORT;
    delete process.env.DATABASE_PATH;
    delete process.env.SIP_TRANSPORT;
    const cfg = loadConfig();
    expect(cfg.port).toBe(4000);
    expect(cfg.databasePath).toBe('./data/compliance-monitor.db');
    expect(cfg.sip.transport).toBe('tls');
    process.env = prev;
  });

  it('reads and normalizes officer/admin allowlists', () => {
    const prev = { ...process.env };
    process.env.APP_SECRET = 'test-secret';
    process.env.OFFICER_EMAILS = 'Off@corp.com';
    process.env.ADMIN_EMAILS = 'admin@corp.com';
    const cfg = loadConfig();
    expect(cfg.officerEmails).toEqual(['off@corp.com']);
    expect(cfg.adminEmails).toEqual(['admin@corp.com']);
    process.env = prev;
  });

  it('throws when APP_SECRET is unset', () => {
    const prev = { ...process.env };
    delete process.env.APP_SECRET;
    expect(() => loadConfig()).toThrow('APP_SECRET');
    process.env = prev;
  });
});
