import { createHash } from 'node:crypto';

/** What the runner knows about the bot it is starting. Widened from a bare displayName
 *  so the provider can mint a distinct guest identity per bot; kept as one object so the
 *  seam can grow (a licensed machine-account provider may want the site or the organiser)
 *  without breaking every implementor again. */
export interface GuestTokenRequest {
  /** Roster identity. The SAME for every bot on purpose — classify.ts finds the bot's own
   *  roster entry by display name, so a per-bot name would count the bot as a human and
   *  break solitude detection. */
  displayName: string;
  /** The meeting this bot serves. Drives the per-bot guest `subject`. */
  meetingId: string;
}

export interface BotTokenProvider {
  /** A join-ready access token for the bot, plus its lifetime in seconds. */
  getToken(req: GuestTokenRequest): Promise<{ token: string; expiresInS: number }>;
}

export interface GuestBotTokenDeps {
  getServiceAppToken: () => Promise<string>;
  webexApiBase: string;
  /** Label for the guest subject (default 'compliance-bot'). Only the prefix is configurable —
   *  the per-meeting suffix is derived, never supplied, so two bots cannot share one. */
  subjectPrefix?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SUBJECT_PREFIX = 'compliance-bot';
/** Webex is undocumented about the subject's limits; stay well inside any plausible one. */
const SUBJECT_MAX_LEN = 64;
/** 128 bits of the meetingId digest: fixed width, collision-free in practice. */
const SUBJECT_HASH_LEN = 32;

/** Reduce an operator-supplied prefix to lowercase [a-z0-9-] and leave room for the digest. */
function sanitizePrefix(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const bounded = cleaned.slice(0, SUBJECT_MAX_LEN - SUBJECT_HASH_LEN - 1).replace(/-+$/, '');
  return bounded || DEFAULT_SUBJECT_PREFIX;
}

/** The Webex guest identity for one meeting's bot.
 *
 *  WHY per meeting: Webex binds the guest user — and the device registration under it — to
 *  `subject`. With every bot sharing one subject, a second concurrent bot died with
 *  "Confluence url for the device is null" and a 409 on the media PUT.
 *
 *  WHY a digest instead of the meetingId itself: the subject must be charset- and
 *  length-safe, and hashing makes it so by construction for any meetingId (a uuid today,
 *  whatever a future source hands us) while staying collision-free — sanitizing alone would
 *  fold 'm/1' and 'm:1' into one identity, i.e. straight back into this bug.
 *
 *  WHY deterministic instead of random: a re-dial of the same meeting reuses the guest
 *  identity it already had (the behaviour already proven in production for a single bot),
 *  and the subject in a log line stays correlatable to the meeting across restarts.
 *
 *  ROTATION (what to do when Webex wedges a guest identity — determinism means a retry
 *  re-derives the SAME dead subject, so something must change): set a new
 *  WEBEX_GUEST_SUBJECT_PREFIX to move the whole fleet at once, or re-register the one
 *  meeting — a new row is a new uuid, hence a new subject, for that meeting only. */
export function guestSubjectForMeeting(meetingId: string, prefix = DEFAULT_SUBJECT_PREFIX): string {
  const digest = createHash('sha256').update(meetingId).digest('hex').slice(0, SUBJECT_HASH_LEN);
  return `${sanitizePrefix(prefix)}-${digest}`;
}

/** Mint a Webex guest token from the org Service-App token. This uses the
 *  Webex guest-issuer flow (POST /guests/token). Behind the BotTokenProvider seam so an
 *  enterprise deploy can swap in a licensed machine-account token later. */
export function createGuestBotTokenProvider(deps: GuestBotTokenDeps): BotTokenProvider {
  const doFetch = deps.fetchImpl ?? fetch;
  const prefix = deps.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX;
  const url = `${deps.webexApiBase.replace(/\/$/, '')}/guests/token`;

  return {
    async getToken({ displayName, meetingId }: GuestTokenRequest) {
      const subject = guestSubjectForMeeting(meetingId, prefix);
      const saToken = await deps.getServiceAppToken();
      const res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, displayName }),
      });
      // Log the subject on the failure paths too, and log it HERE rather than relying on
      // the thrown message: that message is surfaced through webexBotProcess's sanitize(),
      // which masks any run of 4+ digits — so a digest like ...9552... reaches the DB and
      // the console UI partly '****'-ed and can no longer be matched back to Webex.
      if (!res.ok) {
        console.error(
          `[botToken] LOUD: guest token mint failed (${res.status}) for meeting ${meetingId} as subject ${subject}`,
        );
        throw new Error(`guest token mint failed (${res.status}) for subject ${subject}`);
      }
      const json = (await res.json()) as { accessToken?: string; token?: string; expiresIn?: number };
      const token = json.accessToken ?? json.token;
      if (!token) {
        console.error(
          `[botToken] LOUD: guest token response missing access token for meeting ${meetingId} as subject ${subject}`,
        );
        throw new Error(`guest token response missing access token for subject ${subject}`);
      }
      // The subject is not a secret, and it is the only handle tying a meeting to the guest
      // user Webex sees — log it (never the token) so the audit trail follows a bot into Webex.
      console.error(`[botToken] minted guest token for meeting ${meetingId} as subject ${subject}`);
      return { token, expiresInS: json.expiresIn ?? 0 };
    },
  };
}
