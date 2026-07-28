import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useThemeStore } from '@stores/useTheme'

// In-memory localStorage, installed explicitly - some happy-dom setups don't expose it as a global.
function fakeLocalStorage() {
    const store = new Map()
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)) },
        removeItem: (k) => { store.delete(k) },
        clear: () => { store.clear() },
    }
}

function ensureDocumentRoot() {
    // happy-dom provides this, but if a future env doesn't we fall back to a stub.
    if (typeof document !== 'undefined' && document.documentElement) return
    globalThis.document = { documentElement: { dataset: {}, removeAttribute(name) { delete this.dataset[name.replace(/^data-/, '')] } } }
}

describe('useThemeStore', () => {
    let matchMediaMatches

    beforeEach(() => {
        setActivePinia(createPinia())
        globalThis.localStorage = fakeLocalStorage()
        ensureDocumentRoot()
        document.documentElement.removeAttribute('data-theme')
        matchMediaMatches = false
        globalThis.window = globalThis.window || {}
        window.matchMedia = vi.fn(() => ({ matches: matchMediaMatches }))
    })

    describe('init', () => {
        it('reads a valid theme from localStorage', () => {
            localStorage.setItem('stereum-lite:theme', 'light')
            const t = useThemeStore()
            t.init()
            expect(t.theme).toBe('light')
            expect(document.documentElement.dataset.theme).toBe('light')
        })

        it('falls back to prefers-color-scheme: light when storage is empty', () => {
            matchMediaMatches = true
            const t = useThemeStore()
            t.init()
            expect(t.theme).toBe('light')
            expect(document.documentElement.dataset.theme).toBe('light')
        })

        it('defaults to dark when no storage value and no light preference', () => {
            matchMediaMatches = false
            const t = useThemeStore()
            t.init()
            expect(t.theme).toBe('dark')
            expect(document.documentElement.dataset.theme).toBe('dark')
        })

        it('ignores invalid values stored in localStorage', () => {
            localStorage.setItem('stereum-lite:theme', 'sepia')
            const t = useThemeStore()
            t.init()
            // Should fall through to the prefers / default logic, not honor "sepia"
            expect(['dark', 'light']).toContain(t.theme)
            expect(t.theme).not.toBe('sepia')
        })
    })

    describe('set', () => {
        it('updates state, persists to localStorage, and applies the dataset attribute', () => {
            const t = useThemeStore()
            t.set('light')
            expect(t.theme).toBe('light')
            expect(localStorage.getItem('stereum-lite:theme')).toBe('light')
            expect(document.documentElement.dataset.theme).toBe('light')
        })

        it('ignores invalid values', () => {
            const t = useThemeStore()
            t.init() // settles to a valid value first
            const before = t.theme
            t.set('paisley')
            expect(t.theme).toBe(before)
            expect(localStorage.getItem('stereum-lite:theme')).not.toBe('paisley')
        })
    })

    describe('toggle', () => {
        it('flips dark → light', () => {
            const t = useThemeStore()
            t.init() // -> dark (no storage, no prefers)
            t.toggle()
            expect(t.theme).toBe('light')
            expect(document.documentElement.dataset.theme).toBe('light')
        })

        it('flips light → dark', () => {
            localStorage.setItem('stereum-lite:theme', 'light')
            const t = useThemeStore()
            t.init()
            t.toggle()
            expect(t.theme).toBe('dark')
            expect(document.documentElement.dataset.theme).toBe('dark')
        })

        it('persists the toggled value to localStorage', () => {
            const t = useThemeStore()
            t.init()
            t.toggle()
            expect(localStorage.getItem('stereum-lite:theme')).toBe(t.theme)
        })
    })
})
