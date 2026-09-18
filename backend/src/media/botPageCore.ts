/* eslint-disable @typescript-eslint/no-explicit-any */
// Browser-side bot logic, dependency-injected so it is unit-testable in Node.
// Real globals (window.Webex, WebCodecs, MediaStreamTrackProcessor, WebSocket)
// are supplied by bot.js. NEVER include the password in any control message.

export interface BotPageConfig {
  token: string;
  destination: string;
  password?: string;
  displayName: string;
  /** 'transcoded' = one server-mixed audio stream (default); 'multistream' = per-speaker. */
  mediaMode?: 'transcoded' | 'multistream';
}

export interface BotPageDeps {
  Webex: any;
  makeAudioEncoder: (
    onChunk: (bytes: Uint8Array) => void,
    onError: (e: unknown) => void,
  ) => { encode: (data: unknown) => void; close: () => void };
  makeTrackReader: (track: unknown) => AsyncIterable<unknown>;
  /** Web-Audio mixer: connect any number of remote audio streams into ONE mixed
   *  track to encode. Multistream can deliver several active-speaker audio streams. */
  makeMixer: () => { addStream: (stream: unknown) => void; track: unknown };
  send: (msg: { type: string; [k: string]: unknown }) => void;
  sendAudio: (bytes: Uint8Array) => void;
  log: (line: string) => void;
}

function sanitize(err: unknown, secrets: ReadonlyArray<string | undefined> = []): string {
  let msg = err instanceof Error ? err.message : String(err);
  // Scrub known secrets first (password/token), then fall back to stripping
  // anything that looks like a long digit run (never echo PII/creds).
  for (const s of secrets) if (s) msg = msg.split(s).join('***');
  return msg.replace(/\d{4,}/g, '****').slice(0, 200);
}

export async function runBotPage(
  cfg: BotPageConfig,
  deps: BotPageDeps,
): Promise<{ leave(): Promise<void> }> {
  const secrets = [cfg.password, cfg.token];
  const webex = deps.Webex.init({ credentials: { access_token: cfg.token } });
  let encoder: { encode: (d: unknown) => void; close: () => void } | null = null;
  let meeting: any = null;
  // stopped: set once leave() is called, so the in-flight track-reader loop exits
  // and no further audio is encoded/forwarded (avoids a leaked reader + a race
  // with a fresh reader started by a later remoteAudio event).
  let stopped = false;
  // readerActive: guards against a second concurrent track-reader loop if the SDK
  // fires a second remoteAudio event while one is already running.
  let readerActive = false;
  // endedSent: the SDK may fire both meeting:self:left and meeting:ended; only
  // forward 'ended' once.
  let endedSent = false;

  const leave = async (): Promise<void> => {
    stopped = true;
    try { encoder?.close(); } catch { /* already closed */ }
    try { await meeting?.leave(); } catch { /* already gone */ }
    // Leaving the meeting frees the roster seat but NOT the device registration made by
    // meetings.register() above. Each bot derives a deterministic guest subject from its
    // meetingId, so a bot that flaps re-registers that same subject ~1s later — on top of
    // a device Webex still considers live, which answers 409 / "Confluence url for the
    // device is null". Separate try from the leave above: whichever one fails, the other
    // must still run, and neither may throw out of this teardown-path function.
    try { await webex.meetings.unregister(); } catch { /* never registered, or already released */ }
  };

  try {
    await new Promise<void>((resolve) => webex.once('ready', resolve));
    await webex.meetings.register();
    meeting = await webex.meetings.create(cfg.destination);

    // Attach media + lifecycle listeners BEFORE join — Webex emits initial media
    // events DURING join and never re-fires them in a stable meeting.
    let firstFrameLogged = false;
    encoder = deps.makeAudioEncoder(
      (bytes) => {
        if (!firstFrameLogged) {
          firstFrameLogged = true;
          deps.log(`first audio frame encoded (${bytes.length}B) — forwarding to console`);
        }
        deps.sendAudio(bytes);
      },
      (e) => deps.log(`encoder error: ${sanitize(e, secrets)}`),
    );

    // Mix every remote audio stream into ONE track, then encode that track. Webex
    // multistream (enableMultistream:true) can deliver several active-speaker audio
    // streams; connecting them all to one Web-Audio destination gives the room mix.
    const mixer = deps.makeMixer();
    const addedStreams = new Set<unknown>();

    const startReaderOnce = (): void => {
      if (readerActive || stopped) return;
      readerActive = true;
      void (async () => {
        try {
          for await (const audioData of deps.makeTrackReader(mixer.track)) {
            // WebCodecs: encode() does NOT take ownership of the AudioData — every
            // frame must be closed or its off-heap buffer leaks. At ~50 frames/s an
            // unclosed loop grows by hundreds of MB per hour until Chromium OOM-kills
            // the tab, ending monitoring with no loud signal. The finally also covers
            // the `stopped` break, so the shutdown path releases its last frame too.
            try {
              if (stopped) break;
              encoder!.encode(audioData);
            } finally {
              (audioData as { close?: () => void } | null)?.close?.();
            }
          }
        } catch (e) {
          deps.log(`track reader ended: ${sanitize(e, secrets)}`);
        } finally {
          readerActive = false;
        }
      })();
    };

    const addRemoteStreams = (streams: any[]): void => {
      if (stopped) return;
      let added = 0;
      for (const s of streams) {
        if (!s || addedStreams.has(s)) continue;
        try {
          mixer.addStream(s);
          addedStreams.add(s);
          added++;
        } catch (e) {
          deps.log(`mixer.addStream failed: ${sanitize(e, secrets)}`);
        }
      }
      if (added > 0) {
        deps.log(`remote audio: +${added} stream(s) mixed (total ${addedStreams.size})`);
        startReaderOnce();
      }
    };

    // Multistream delivers remote audio via media:remoteAudio:created with a "group"
    // (group.getRemoteMedia()[].stream) — NOT media:ready. This is the proven path.
    meeting.on('media:remoteAudio:created', (group: any) => {
      const streams = (group?.getRemoteMedia?.() ?? [])
        .map((rm: any) => rm?.stream)
        .filter(Boolean);
      deps.log(`media:remoteAudio:created — ${streams.length} stream(s)`);
      addRemoteStreams(streams);
    });
    // Fallback for transcoded (non-multistream) mode; inert under multistream.
    meeting.on('media:ready', (media: any) => {
      if (media?.type === 'remoteAudio' && media.stream) addRemoteStreams([media.stream]);
    });
    meeting.on('members:update', (payload: any) => {
      deps.send({ type: 'members', roster: payload });
    });
    for (const endEvt of ['meeting:self:left', 'meeting:ended']) {
      meeting.on(endEvt, () => {
        if (endedSent) return;
        endedSent = true;
        deps.send({ type: 'ended' });
      });
    }

    if (cfg.password) {
      const result = await meeting.verifyPassword(cfg.password, '');
      if (!result?.isPasswordValid) {
        deps.send({ type: 'failed', reason: 'password rejected' });
        return { leave };
      }
    }

    // Media mode:
    //  transcoded  → one server-mixed audio stream via media:ready (no video decode) — default.
    //  multistream → per-speaker streams via media:remoteAudio:created; REQUIRES videoEnabled,
    //                else Webex suppresses remote-audio delivery (the RemoteMediaManager
    //                allocates audio slots but the event never fires — confirmed live). Proven
    //                on SDK 3.12.0.
    // Either way we publish nothing (no localStreams) and encode audio only; video is ignored.
    const multistream = (cfg.mediaMode ?? 'transcoded') === 'multistream';
    await meeting.joinWithMedia({
      joinOptions: { enableMultistream: multistream },
      mediaOptions: { audioEnabled: true, videoEnabled: multistream, allowMediaInLobby: true },
    });
    deps.send({ type: 'joined' });
  } catch (e) {
    deps.send({ type: 'failed', reason: sanitize(e, secrets) });
  }
  return { leave };
}
