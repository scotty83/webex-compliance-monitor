// Internal bot <-> media hub contract (shared contract; keep in sync with frontend/src/types.ts).
// Declared here; the media layer provides the concrete implementations.
import type { AudioFrame, BotStatus, ChaperonedMeeting, BotState } from '../domain/types.js';

export interface MediaHub {
  publish(frame: AudioFrame): void;                       // called by the bot
  subscribe(meetingId: string, onFrame: (f: AudioFrame) => void): () => void; // returns unsubscribe
  hasPublisher(meetingId: string): boolean;               // true while a frame published within ~3s
}

export interface BotManager {
  startBot(meeting: ChaperonedMeeting): Promise<void>;    // dial in
  stopBot(meetingId: string): Promise<void>;              // hang up
  onStatus(cb: (s: BotStatus) => void): void;             // lifecycle events → orchestrator
}

// Bot process seam. Abstracts the bot media process (now the headless-Chromium
// Webex-SDK runner) so the BotManager is unit-testable with a scripted fake. CAPTURE PATH IS
// SPIKE-CONTINGENT on Phase 0: if a cleaner in-process RTP/Opus path is found, only the
// BotProcess implementation changes.
export type BotEventMap = {
  status: [state: BotState, info?: { error?: string }];
  frame: [payload: Uint8Array, capturedAt: number];      // one 20ms Opus packet + capture epoch ms
  exit: [code: number | null];
};

export interface BotProcessSpec {
  meetingId: string;    // which meeting this bot serves; scopes its Webex guest identity
  sipUri: string;       // full request URI incl. ;transport=tls
  displayName: string;  // "Compliance Monitor Bot" — identical for every bot (roster classification)
  dtmf?: string;        // post-connect DTMF (meeting password + #); credential — do not log
}

export interface BotProcess {
  on<E extends keyof BotEventMap>(event: E, listener: (...args: BotEventMap[E]) => void): this;
  start(): void;
  stop(): Promise<void>;
}

export type BotProcessFactory = (spec: BotProcessSpec) => BotProcess;
