import type { ParticipantRole } from '../domain/types.js';
import type { WebexParticipant } from './meetingsClient.js';

export interface ClassifyRules {
  /** Lowercased email domains → 'fo'; other authenticated → 'analyst'; guests → 'other'. */
  internalEmailDomains: string[];
  /** BOT_DISPLAY_NAME — the bot's own roster entry self-match. */
  botDisplayName: string;
}

/** Authenticated-domain rule — the SINGLE source shared by
 *  rosterMonitor (live polling) and rosterPeek (bot-independent snapshot).
 *  Do not fork this logic. Extracted verbatim from rosterMonitor. */
export function classifyParticipant(p: WebexParticipant, rules: ClassifyRules): ParticipantRole {
  if (p.displayName === rules.botDisplayName) return 'bot';
  const email = p.email?.trim().toLowerCase();
  if (!email || !email.includes('@')) return 'other'; // unauthenticated guest
  const domain = email.split('@')[1];
  return rules.internalEmailDomains.includes(domain) ? 'fo' : 'analyst';
}
