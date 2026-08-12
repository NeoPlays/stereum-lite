import { describe, it, expect } from 'vitest'
import { classifyValidatorSetup, isSoloEligible, holdsOnChainValidators } from '@renderer/utils/validatorSetup'

const svc = (id, service) => ({ id, config: { service } })

describe('classifyValidatorSetup', () => {
    it('classifies a solo validator setup and points keyHolder at the VC', () => {
        const vc = svc('v1', 'LighthouseValidatorService')
        const r = classifyValidatorSetup([svc('b1', 'LighthouseBeaconService'), vc])
        expect(r.kind).toBe('solo')
        expect(r.keyHolder).toBe(vc)
        expect(r.clients).toEqual([vc])
    })

    it('classifies a remote-signer setup (Web3Signer holds the keys, not the VC)', () => {
        const signer = svc('w1', 'Web3SignerService')
        const r = classifyValidatorSetup([svc('v1', 'TekuValidatorService'), signer])
        expect(r.kind).toBe('remote-signer')
        expect(r.keyHolder).toBe(signer)
        expect(r.web3signer).toBe(signer)
    })

    it('classifies an Obol setup as obol, with Charon as the keyHolder (lockfile DV pubkeys)', () => {
        const charon = svc('c1', 'CharonService')
        const r = classifyValidatorSetup([charon, svc('v1', 'LighthouseValidatorService')])
        expect(r.kind).toBe('obol') // obol wins over solo
        expect(r.keyHolder).toBe(charon) // the DV pubkeys come from Charon's cluster-lock.json
        expect(r.charon).toBe(charon)
    })

    it('keeps Charon as the Obol keyHolder even when a VC and Web3Signer are present', () => {
        const charon = svc('c1', 'CharonService')
        const r = classifyValidatorSetup([charon, svc('v1', 'TekuValidatorService'), svc('w1', 'Web3SignerService')])
        expect(r.kind).toBe('obol')
        expect(r.keyHolder).toBe(charon)
    })

    it('classifies an SSV setup and takes precedence over everything else', () => {
        const ssv = svc('s1', 'SSVNetworkService')
        const r = classifyValidatorSetup([ssv, svc('c1', 'CharonService'), svc('v1', 'PrysmValidatorService')])
        expect(r.kind).toBe('ssv')
        expect(r.keyHolder).toBeNull()
        expect(r.ssv).toBe(ssv)
    })

    it('is "none" when the setup has no validator-category service', () => {
        const r = classifyValidatorSetup([svc('e1', 'GethService'), svc('b1', 'LighthouseBeaconService')])
        expect(r.kind).toBe('none')
        expect(r.keyHolder).toBeNull()
        expect(r.clients).toEqual([])
    })

    it('handles an empty / undefined setup', () => {
        expect(classifyValidatorSetup([]).kind).toBe('none')
        expect(classifyValidatorSetup().kind).toBe('none')
    })

    it('collects every validator-category service in clients (across paradigms)', () => {
        const r = classifyValidatorSetup([
            svc('c1', 'CharonService'),
            svc('v1', 'LighthouseValidatorService'),
            svc('v2', 'LodestarValidatorService'),
        ])
        expect(r.clients.map((s) => s.id).sort()).toEqual(['c1', 'v1', 'v2'])
    })
})

describe('isSoloEligible', () => {
    it('is true only for solo setups (slashing gate S4)', () => {
        expect(isSoloEligible('solo')).toBe(true)
        for (const k of ['remote-signer', 'obol', 'ssv', 'none']) expect(isSoloEligible(k)).toBe(false)
    })
})

describe('holdsOnChainValidators', () => {
    it('Charon DV pubkeys and solo/remote-signer keys are on-chain', () => {
        expect(holdsOnChainValidators('distributed', 'obol')).toBe(true)
        expect(holdsOnChainValidators('validator', 'solo')).toBe(true)
        expect(holdsOnChainValidators('signer', 'remote-signer')).toBe(true)
    })
    it('key shares behind Charon (VC or Web3Signer) are NOT on-chain', () => {
        expect(holdsOnChainValidators('share', 'obol')).toBe(false)
        expect(holdsOnChainValidators('signer', 'obol')).toBe(false)
    })
    it('SSV is off-node', () => {
        expect(holdsOnChainValidators('ssv', 'ssv')).toBe(false)
    })
})
