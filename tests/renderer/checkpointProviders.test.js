import { describe, it, expect } from 'vitest'
import { CHECKPOINT_PROVIDERS, providersForNetwork } from '@renderer/utils/checkpointProviders'

describe('checkpointProviders', () => {
    it('every provider entry has a name and an https base URL without a trailing slash', () => {
        for (const [network, list] of Object.entries(CHECKPOINT_PROVIDERS)) {
            expect(Array.isArray(list), network).toBe(true)
            for (const p of list) {
                expect(typeof p.name, `${network} name`).toBe('string')
                expect(p.name.length).toBeGreaterThan(0)
                expect(p.url, `${network} ${p.name}`).toMatch(/^https:\/\/\S+$/)
                expect(p.url.endsWith('/'), `${network} ${p.name} trailing slash`).toBe(false)
            }
        }
    })

    it('resolves providers case-insensitively by network', () => {
        expect(providersForNetwork('mainnet')).toBe(CHECKPOINT_PROVIDERS.mainnet)
        expect(providersForNetwork('Holesky')).toBe(CHECKPOINT_PROVIDERS.holesky)
        expect(providersForNetwork('HOODI')).toBe(CHECKPOINT_PROVIDERS.hoodi)
    })

    it('returns an empty list for unknown / devnet / missing networks', () => {
        expect(providersForNetwork('devnet')).toEqual([])
        expect(providersForNetwork(undefined)).toEqual([])
        expect(providersForNetwork('')).toEqual([])
    })
})
