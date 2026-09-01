import { describe, it, expect } from 'vitest'
import { capabilityFor, actionDisabled, actionHint, explorerUrl } from '@renderer/utils/validatorCapabilities'

const byId = (list, id) => list.find((a) => a.id === id)
const solo = capabilityFor('validator', 'Lighthouse')

describe('capabilityFor', () => {
    it('substitutes the client name into the note', () => {
        expect(solo.note).toContain('Lighthouse')
    })
    it('gives read-only sets to roles that cannot act alone', () => {
        for (const role of ['share', 'distributed', 'signer']) {
            const cap = capabilityFor(role, 'X')
            expect(cap.rowActions.some((a) => a.mutating)).toBe(false)
            expect(cap.scopeActions.some((a) => a.mutating)).toBe(false)
        }
    })
    it('returns an empty set for an unknown role', () => {
        expect(capabilityFor('nonsense')).toEqual({ rowActions: [], scopeActions: [], drawerActions: [], note: '' })
    })
})

describe('actionDisabled', () => {
    const feeRecipient = byId(solo.rowActions, 'setFeeRecipient')
    const graffiti = byId(solo.rowActions, 'setGraffiti')
    const exit = byId(solo.rowActions, 'exitValidator')
    const copy = byId(solo.rowActions, 'copyPubkey')
    const row = { index: 42 }

    it('enables an implemented mutating action on a solo setup', () => {
        expect(actionDisabled(feeRecipient, { row, soloEligible: true })).toBe(false)
    })

    it('disables every mutating action when the setup is not solo-eligible', () => {
        // A VC behind Charon holds a key share: a local write there is meaningless or unsafe.
        expect(actionDisabled(feeRecipient, { row, soloEligible: false })).toBe(true)
        expect(actionDisabled(graffiti, { row, soloEligible: false })).toBe(true)
    })

    it('leaves read-only actions enabled regardless of eligibility', () => {
        expect(actionDisabled(copy, { row, soloEligible: false })).toBe(false)
    })

    it('keeps a mutating action without a pipeline disabled even on a solo setup', () => {
        // Synthetic on purpose: this pins the RULE, not the current roster of actions. Asserting
        // it against a real action would break every time one of them gets implemented, which is
        // exactly what happened when exitValidator landed.
        const unbuilt = { id: 'future', label: 'Future thing', mutating: true }
        expect(actionDisabled(unbuilt, { row, soloEligible: true })).toBe(true)
        expect(actionHint(unbuilt, { row, soloEligible: true })).toBe('soon')
    })

    it('enables the exit action on a solo setup now that it is implemented', () => {
        expect(actionDisabled(exit, { row, soloEligible: true })).toBe(false)
        expect(actionDisabled(exit, { row, soloEligible: false })).toBe(true)
    })

    it('disables graffiti when the client build has no graffiti route', () => {
        expect(actionDisabled(graffiti, { row, soloEligible: true, graffitiSupported: false })).toBe(true)
        expect(actionHint(graffiti, { row, soloEligible: true, graffitiSupported: false })).toBe('unsupported')
        // Fee recipient is unaffected: it is not version-gated.
        expect(actionDisabled(feeRecipient, { row, soloEligible: true, graffitiSupported: false })).toBe(false)
    })

    it('disables index-dependent actions until the beacon index is known', () => {
        const explorer = byId(solo.rowActions, 'viewBeaconcha')
        expect(actionDisabled(explorer, { row: { index: null }, soloEligible: true })).toBe(true)
        expect(actionHint(explorer, { row: { index: null }, soloEligible: true })).toBe('no index')
        expect(actionDisabled(explorer, { row, soloEligible: true })).toBe(false)
    })

    it('defaults to disabled for a missing action', () => {
        expect(actionDisabled(undefined)).toBe(true)
    })

    it('explains a multi-party block distinctly from an unbuilt one', () => {
        expect(actionHint(feeRecipient, { row, soloEligible: false })).toBe('multi-party')
    })
})

describe('explorerUrl', () => {
    it('maps known networks and is case-insensitive', () => {
        expect(explorerUrl('mainnet', 5)).toBe('https://beaconcha.in/validator/5')
        expect(explorerUrl('HOODI', 5)).toBe('https://hoodi.beaconcha.in/validator/5')
    })
    it('returns null without a network or index', () => {
        expect(explorerUrl('nonsense', 5)).toBeNull()
        expect(explorerUrl('mainnet', null)).toBeNull()
    })
})
