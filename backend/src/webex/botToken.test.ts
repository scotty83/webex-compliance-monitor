import { describe, it, expect, vi } from 'vitest';
import { createGuestBotTokenProvider, guestSubjectForMeeting } from './botToken.js';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A provider wired to a recording fetch, so a test can read back what was POSTed to Webex. */
function makeRecordingProvider(deps: { subjectPrefix?: string } = {}) {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
    okResponse({ accessToken: 'guest-abc', expiresIn: 3600 }),
  );
  const provider = createGuestBotTokenProvider({
    getServiceAppToken: async () => 'sa-token',
    webexApiBase: 'https://webexapis.com/v1',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...deps,
  });
  const mintedBody = (call: number): { subject: string; displayName: string } =>
    JSON.parse(fetchImpl.mock.calls[call][1]!.body as string);
  return { provider, fetchImpl, mintedBody };
}

describe('createGuestBotTokenProvider', () => {
  it('mints a guest token using the Service-App token and the given displayName', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ accessToken: 'guest-abc', expiresIn: 3600 }),
    );
    const provider = createGuestBotTokenProvider({
      getServiceAppToken: async () => 'sa-token',
      webexApiBase: 'https://webexapis.com/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'm1' });

    expect(result).toEqual({ token: 'guest-abc', expiresInS: 3600 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://webexapis.com/v1/guests/token');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sa-token' });
    // Pin the SHAPE, not guestSubjectForMeeting('m1') — re-deriving the value under test
    // would still pass if the derivation itself broke.
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.subject).toMatch(/^compliance-bot-[0-9a-f]{32}$/);
    expect(body.displayName).toBe('Compliance Monitor Bot');
  });

  it('accepts the alternate `token` field name in the guest response', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ token: 'guest-xyz', expiresIn: 900 }),
    );
    const provider = createGuestBotTokenProvider({
      getServiceAppToken: async () => 'sa',
      webexApiBase: 'https://webexapis.com/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await provider.getToken({ displayName: 'Bot', meetingId: 'm1' })).toEqual({
      token: 'guest-xyz',
      expiresInS: 900,
    });
  });

  // Both failure branches must LOG the subject, not just embed it in the thrown message:
  // that message reaches the DB and the console UI through webexBotProcess's sanitize(),
  // which masks any run of 4+ digits and can chew a hex digest into '****'.
  it('fails loud when the mint is not ok, logging the un-masked subject', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('nope', { status: 403 }));
    const provider = createGuestBotTokenProvider({
      getServiceAppToken: async () => 'sa',
      webexApiBase: 'https://webexapis.com/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getToken({ displayName: 'Bot', meetingId: 'm1' })).rejects.toThrow(
      /guest token mint failed/i,
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`LOUD.*m1.*${guestSubjectForMeeting('m1')}`)),
    );
    errSpy.mockRestore();
  });

  it('fails loud when the response has no token field, logging the un-masked subject', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse({ expiresIn: 3600 }));
    const provider = createGuestBotTokenProvider({
      getServiceAppToken: async () => 'sa',
      webexApiBase: 'https://webexapis.com/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getToken({ displayName: 'Bot', meetingId: 'm1' })).rejects.toThrow(/missing access token/i);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`LOUD.*m1.*${guestSubjectForMeeting('m1')}`)),
    );
    errSpy.mockRestore();
  });
});

// Webex ties the guest identity — and the device registration behind it — to `subject`.
// One shared subject made the 2nd concurrent bot die with "Confluence url for the device
// is null" + a 409 on the media PUT. These tests pin the per-meeting identity.
describe('createGuestBotTokenProvider — per-meeting guest subject', () => {
  it('mints a DIFFERENT subject per meeting so concurrent bots do not collide on one Webex device', async () => {
    const { provider, mintedBody } = makeRecordingProvider();

    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-a' });
    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-b' });

    expect(mintedBody(0).subject).not.toBe(mintedBody(1).subject);
  });

  it('reuses the SAME subject when the same meeting re-mints, so a re-dial keeps one guest identity', async () => {
    const { provider, mintedBody } = makeRecordingProvider();

    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-a' });
    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-a' });

    expect(mintedBody(1).subject).toBe(mintedBody(0).subject);
  });

  it('keeps displayName byte-identical across bots — classify.ts matches the bot row by display name', async () => {
    const { provider, mintedBody } = makeRecordingProvider();

    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-a' });
    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-b' });

    expect(mintedBody(0).displayName).toBe('Compliance Monitor Bot');
    expect(mintedBody(1).displayName).toBe('Compliance Monitor Bot');
  });

  it('sanitizes and bounds a hostile meetingId — the subject stays lowercase [a-z0-9-] and <= 64 chars', async () => {
    const { provider, mintedBody } = makeRecordingProvider();

    await provider.getToken({
      displayName: 'Compliance Monitor Bot',
      meetingId: `  Weird/ID:with spaces & ✨ ${'x'.repeat(300)}`,
    });

    const { subject } = mintedBody(0);
    expect(subject).toMatch(/^[a-z0-9-]+$/);
    expect(subject.length).toBeLessThanOrEqual(64);
  });

  it('keeps meetingIds distinct even when they differ only in characters a naive sanitizer would strip', async () => {
    const { provider, mintedBody } = makeRecordingProvider();

    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting/1' });
    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting:1' });

    expect(mintedBody(0).subject).not.toBe(mintedBody(1).subject);
  });

  it('sanitizes and bounds an operator-supplied subject prefix, keeping the subject well-formed', async () => {
    const { provider, mintedBody } = makeRecordingProvider({ subjectPrefix: `  Bot Ops!! ${'Z'.repeat(80)}` });

    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-a' });

    // The exact shape for THIS input, not just "well-formed": the default-prefix subject
    // is also lowercase-and-short, so a loose assertion would pass with subjectPrefix
    // ignored entirely. '  Bot Ops!! ' folds to 'bot-ops-', then 23 z's fill the prefix
    // budget (64 - 32 digest - 1 separator = 31 chars).
    const { subject } = mintedBody(0);
    expect(subject).toMatch(/^bot-ops-z{23}-[0-9a-f]{32}$/);
    expect(subject.length).toBe(64);
  });

  it('mints with the CONFIGURED prefix, so WEBEX_GUEST_SUBJECT_PREFIX really rotates the fleet', async () => {
    const { provider, mintedBody } = makeRecordingProvider({ subjectPrefix: 'rotated-v2' });

    await provider.getToken({ displayName: 'Compliance Monitor Bot', meetingId: 'meeting-a' });

    expect(mintedBody(0).subject).toBe(guestSubjectForMeeting('meeting-a', 'rotated-v2'));
    expect(mintedBody(0).subject).toMatch(/^rotated-v2-[0-9a-f]{32}$/);
    // ...and rotating the prefix genuinely moves the bot off its old guest identity.
    expect(mintedBody(0).subject).not.toBe(guestSubjectForMeeting('meeting-a'));
  });
});

describe('guestSubjectForMeeting', () => {
  it('is deterministic, prefixed, and collision-free across meetings', () => {
    expect(guestSubjectForMeeting('m1')).toBe(guestSubjectForMeeting('m1'));
    expect(guestSubjectForMeeting('m1')).not.toBe(guestSubjectForMeeting('m2'));
    expect(guestSubjectForMeeting('m1')).toMatch(/^compliance-bot-[0-9a-f]+$/);
  });

  it('falls back to the default prefix when the configured one sanitizes to nothing', () => {
    expect(guestSubjectForMeeting('m1', '!!!')).toBe(guestSubjectForMeeting('m1'));
  });
});
