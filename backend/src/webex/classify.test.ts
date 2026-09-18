import { describe, it, expect } from 'vitest';
import { classifyParticipant } from './classify.js';
import type { WebexParticipant } from './meetingsClient.js';

const RULES = { internalEmailDomains: ['bank.example', 'bank.co.uk'], botDisplayName: 'Compliance Bot' };

function p(over: Partial<WebexParticipant>): WebexParticipant {
  return { id: 'x', displayName: 'Someone', host: false, state: 'joined', pstn: false, ...over };
}

describe('classifyParticipant — authenticated-domain rule', () => {
  it('bot display-name self-match wins over email', () => {
    expect(classifyParticipant(p({ displayName: 'Compliance Bot', email: 'bot@bank.example' }), RULES)).toBe('bot');
  });
  it('internal domain → fo (case-insensitive, trimmed)', () => {
    expect(classifyParticipant(p({ email: '  Fred@BANK.example ' }), RULES)).toBe('fo');
  });
  it('other authenticated email → analyst', () => {
    expect(classifyParticipant(p({ email: 'ana@fund.example' }), RULES)).toBe('analyst');
  });
  it('no email (unauthenticated guest) → other', () => {
    expect(classifyParticipant(p({}), RULES)).toBe('other');
  });
  it('malformed email without @ → other', () => {
    expect(classifyParticipant(p({ email: 'not-an-email' }), RULES)).toBe('other');
  });
});
