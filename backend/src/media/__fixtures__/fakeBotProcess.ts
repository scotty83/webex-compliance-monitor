import { EventEmitter } from 'node:events';
import type { BotState } from '../../domain/types.js';
import type { BotEventMap, BotProcess } from '../types.js';

export interface FakeBotProcess extends BotProcess {
  started: boolean;
  stopped: boolean;
  emitStatus(state: BotState, info?: { error?: string }): void;
  emitFrame(payload: Uint8Array, capturedAt?: number): void;
  emitExit(code?: number | null): void;
}

export function createFakeBotProcess(): FakeBotProcess {
  const ee = new EventEmitter();
  const fake: FakeBotProcess = {
    started: false,
    stopped: false,
    on<E extends keyof BotEventMap>(event: E, listener: (...args: BotEventMap[E]) => void) {
      ee.on(event as string, listener as (...args: unknown[]) => void);
      return fake;
    },
    start() {
      fake.started = true;
    },
    async stop() {
      fake.stopped = true;
    },
    emitStatus(state, info) {
      ee.emit('status', state, info);
    },
    emitFrame(payload, capturedAt = Date.now()) {
      ee.emit('frame', payload, capturedAt);
    },
    emitExit(code = 0) {
      ee.emit('exit', code);
    },
  };
  return fake;
}
