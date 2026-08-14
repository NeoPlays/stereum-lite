import { describe, it, expect } from 'vitest'
import { scopeTargets, selectionCount, effectiveScopeOf, scopeCountOf } from '@renderer/utils/validatorScope'

// 200 keys, 40 of which match the current filter, 25 of those checked on the visible page.
const rows = Array.from({ length: 200 }, (_, i) => ({ pubkey: `0x${i}` }))
const visible = rows.slice(0, 40)
const page = visible.slice(0, 25)
const selected = new Set(page.map((r) => r.pubkey))

describe('scopeTargets', () => {
    it('targets every key for the all scope', () => {
        expect(scopeTargets({ scope: 'all', rows, visible, selected })).toHaveLength(200)
    })

    it('targets the filtered set for the filtered scope', () => {
        expect(scopeTargets({ scope: 'filtered', rows, visible, selected })).toHaveLength(40)
    })

    it('targets only the checked keys for a normal selection', () => {
        expect(scopeTargets({ scope: 'selected', rows, visible, selected })).toHaveLength(25)
    })

    it('targets every filtered key once "select all matching" is used', () => {
        // The regression this guards: the bar said 200 and the write touched 25, silently.
        const targets = scopeTargets({ scope: 'selected', allMatching: true, rows, visible, selected })
        expect(targets).toHaveLength(40)
        expect(targets).toEqual(visible)
    })

    it('never targets more than the filtered set when a filter is active', () => {
        const targets = scopeTargets({ scope: 'selected', allMatching: true, rows, visible, selected })
        expect(targets.length).toBeLessThanOrEqual(visible.length)
    })

    it('ignores checked keys that are no longer present', () => {
        const stale = new Set(['0xgone', '0x1'])
        expect(scopeTargets({ scope: 'selected', rows, visible, selected: stale })).toEqual([{ pubkey: '0x1' }])
    })
})

describe('selectionCount', () => {
    it('counts the checked keys normally', () => {
        expect(selectionCount({ visible, selected })).toBe(25)
    })
    it('counts the filtered set, not every key, when select-all-matching is on', () => {
        // The link is labelled with the filtered count, so the count must agree with it.
        expect(selectionCount({ allMatching: true, visible, selected })).toBe(40)
    })
})

describe('the displayed count always equals what a bulk action would write', () => {
    const cases = [
        { name: 'all', state: { scope: 'all', rows, visible, selected } },
        { name: 'filtered', state: { scope: 'filtered', rows, visible, selected } },
        { name: 'selected', state: { scope: 'selected', rows, visible, selected } },
        { name: 'selected + all matching', state: { scope: 'selected', allMatching: true, rows, visible, selected } },
        { name: 'selected with nothing checked', state: { scope: 'selected', rows, visible, selected: new Set() } },
    ]
    for (const c of cases) {
        it(`holds for ${c.name}`, () => {
            const shown = scopeCountOf(c.state)
            const written = scopeTargets({ ...c.state, scope: effectiveScopeOf(c.state) }).length
            expect(shown).toBe(written)
        })
    }
})

describe('effectiveScopeOf', () => {
    it('falls back to all when a selected scope has nothing selected', () => {
        expect(effectiveScopeOf({ scope: 'selected', visible, selected: new Set() })).toBe('all')
    })
    it('keeps the selected scope when select-all-matching is on', () => {
        expect(effectiveScopeOf({ scope: 'selected', allMatching: true, visible, selected: new Set() })).toBe('selected')
    })
    it('leaves other scopes alone', () => {
        expect(effectiveScopeOf({ scope: 'filtered', visible, selected })).toBe('filtered')
    })
})
