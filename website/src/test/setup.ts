import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom in this config exposes a method-less `localStorage` object (getItem /
// setItem / clear are undefined), while `sessionStorage` works. Back it with a
// Map so components/libs that persist per-viewer state behave like a browser.
// Guarded: only installed when the real one is missing its methods.
if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
  const store = new Map<string, string>()
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: mock, configurable: true })
  Object.defineProperty(window, 'localStorage', { value: mock, configurable: true })
}

// Unmount React trees between tests to avoid cross-test DOM leakage.
afterEach(() => cleanup())
