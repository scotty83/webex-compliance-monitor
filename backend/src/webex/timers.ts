/** Injectable repeating-timer seam — same philosophy as
 *  OrchestratorDeps.scheduleRetry: production uses real unref'd intervals,
 *  tests capture the callbacks and fire them synchronously. */
export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const defaultTimers: IntervalTimers = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref(); // pending polls never keep the process alive
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};
