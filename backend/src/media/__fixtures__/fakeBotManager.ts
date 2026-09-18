import type { BotStatus, ChaperonedMeeting } from '../../domain/types.js';
import type { BotManager } from '../types.js';

export interface FakeBotManager extends BotManager {
  started: ChaperonedMeeting[];
  stopped: string[];
  emit(s: BotStatus): void;
}

export function createFakeBotManager(): FakeBotManager {
  const listeners: Array<(s: BotStatus) => void> = [];
  const fake: FakeBotManager = {
    started: [],
    stopped: [],
    async startBot(m) { fake.started.push(m); },
    async stopBot(id) { fake.stopped.push(id); },
    onStatus(cb) { listeners.push(cb); },
    emit(s) { for (const cb of listeners) cb(s); },
  };
  return fake;
}
