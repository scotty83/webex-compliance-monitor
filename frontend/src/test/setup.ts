import '@testing-library/jest-dom'

// ── localStorage polyfill for Node 26 ────────────────────────────────────────
// Node 26 ships an experimental globalThis.localStorage that emits a warning
// and returns undefined without --localstorage-file. Its property descriptor
// can prevent jsdom from overriding it in some vitest workers.
// Install a reliable in-memory implementation whenever the native one is absent.
;(() => {
  if (typeof globalThis.localStorage !== 'undefined') return

  class MockStorage {
    private _s = new Map<string, string>()
    get length(): number               { return this._s.size }
    clear(): void                      { this._s = new Map() }
    getItem(k: string): string | null  { return this._s.get(k) ?? null }
    key(i: number): string | null      { return [...this._s.keys()][i] ?? null }
    removeItem(k: string): void        { this._s.delete(k) }
    setItem(k: string, v: string): void { this._s.set(k, String(v)) }
  }

  // Attempt to remove Node 26's accessor (returns false if non-configurable,
  // does not throw) then install a writable data property.
  Reflect.deleteProperty(globalThis, 'localStorage')
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MockStorage(),
      writable: true,
      configurable: true,
      enumerable: true,
    })
  } catch {
    // Non-configurable — no further recourse
  }

  // Expose the constructor as Storage so vi.spyOn(Storage.prototype, ...)
  // works in files that use it (e.g. SettingsPanel tests).
  const g = globalThis as Record<string, unknown>
  if (!g['Storage']) {
    try {
      Object.defineProperty(globalThis, 'Storage', {
        value: MockStorage,
        writable: true,
        configurable: true,
        enumerable: true,
      })
    } catch {
      // ignore
    }
  }
})()
