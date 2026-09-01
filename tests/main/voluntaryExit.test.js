import { describe, it, expect } from 'vitest'
import {
    SHARD_COMMITTEE_PERIOD,
    SLOTS_PER_EPOCH,
    FAR_FUTURE_EPOCH,
    VOLUNTARY_EXIT_PATH,
    EXIT_POOL_PATH,
    epochFromSlot,
    exitEligibility,
    parseSignedExit,
    exitBroadcastBody,
    isExitAccepted,
    exitStatusMessage,
} from '@main/nodes/voluntaryExit'

// An eligible baseline: active, activated long ago, execution withdrawal credentials.
const ACTIVE = {
    pubkey: '0x' + 'ab'.repeat(48),
    index: 1234,
    status: 'Active',
    slashed: false,
    activationEpoch: '1000',
    withdrawalType: '0x01',
    rawStatus: 'active_ongoing',
}
const NOW = 1000 + SHARD_COMMITTEE_PERIOD // exactly the first eligible epoch

const SIGNED_EXIT = {
    message: { epoch: '9876', validator_index: '1234' },
    signature: '0x' + 'cd'.repeat(96),
}

describe('constants and paths', () => {
    it('pins the spec values the flow depends on', () => {
        expect(SHARD_COMMITTEE_PERIOD).toBe(256)
        expect(SLOTS_PER_EPOCH).toBe(32)
        expect(FAR_FUTURE_EPOCH).toBe('18446744073709551615')
    })
    it('builds the validator-client sign path and the beacon pool path', () => {
        expect(VOLUNTARY_EXIT_PATH('0xabc')).toBe('/eth/v1/validator/0xabc/voluntary_exit')
        expect(EXIT_POOL_PATH).toBe('/eth/v1/beacon/pool/voluntary_exits')
    })
    it('never puts an epoch query parameter on the sign path (the client must use its own clock)', () => {
        expect(VOLUNTARY_EXIT_PATH('0xabc')).not.toContain('?')
        expect(VOLUNTARY_EXIT_PATH('0xabc')).not.toContain('epoch')
    })
})

describe('epochFromSlot', () => {
    it('floors slot/32 for numbers and strings alike', () => {
        expect(epochFromSlot(0)).toBe(0)
        expect(epochFromSlot(31)).toBe(0)
        expect(epochFromSlot(32)).toBe(1)
        expect(epochFromSlot('12345678')).toBe(385802)
        expect(epochFromSlot(' 64 ')).toBe(2)
    })
    it('returns null for garbage rather than a misleading epoch 0', () => {
        for (const bad of ['', '   ', 'abc', '12abc', -1, '-32', NaN, Infinity, null, undefined, {}, []]) {
            expect(epochFromSlot(bad)).toBeNull()
        }
    })
})

describe('exitEligibility', () => {
    it('accepts an active validator past the activation period', () => {
        const r = exitEligibility(ACTIVE, { currentEpoch: NOW })
        expect(r).toEqual({ eligible: true, reasons: [], warnings: [] })
    })

    it('blocks when there is no beacon data at all', () => {
        const r = exitEligibility({ ...ACTIVE, index: null }, { currentEpoch: NOW })
        expect(r.eligible).toBe(false)
        expect(r.reasons).toHaveLength(1)
        expect(r.reasons[0]).toMatch(/no beacon-chain data/i)
    })

    it('blocks an already-exiting validator and names the raw status', () => {
        const r = exitEligibility({ ...ACTIVE, rawStatus: 'active_exiting' }, { currentEpoch: NOW })
        expect(r.eligible).toBe(false)
        expect(r.reasons).toHaveLength(1)
        expect(r.reasons[0]).toContain('active_exiting')
    })

    it('blocks exited and slashed raw statuses', () => {
        for (const raw of ['exited_unslashed', 'exited_slashed', 'active_slashed', 'pending_queued', 'withdrawal_possible']) {
            const r = exitEligibility({ ...ACTIVE, rawStatus: raw }, { currentEpoch: NOW })
            expect(r.eligible).toBe(false)
            expect(r.reasons[0]).toContain(raw)
        }
    })

    it('falls back to the bucketed status and the slashed flag when no raw status is known', () => {
        const slashed = exitEligibility({ ...ACTIVE, rawStatus: undefined, slashed: true, status: 'Slashed' }, { currentEpoch: NOW })
        expect(slashed.eligible).toBe(false)
        expect(slashed.reasons[0]).toMatch(/slashed/i)

        const exited = exitEligibility({ ...ACTIVE, rawStatus: undefined, status: 'Exited' }, { currentEpoch: NOW })
        expect(exited.eligible).toBe(false)
        expect(exited.reasons[0]).toMatch(/exited/i)

        const active = exitEligibility({ ...ACTIVE, rawStatus: undefined }, { currentEpoch: NOW })
        expect(active.eligible).toBe(true)
    })

    it('blocks while the validator is inside the 256-epoch activation period and says how long is left', () => {
        const r = exitEligibility(ACTIVE, { currentEpoch: NOW - 100 })
        expect(r.eligible).toBe(false)
        expect(r.reasons).toHaveLength(1)
        expect(r.reasons[0]).toContain('100 more epochs')
        expect(r.reasons[0]).toContain('10.7 hours') // 100 x 6.4 min
    })

    it('singularises the final remaining epoch and clears exactly at activation + 256', () => {
        const one = exitEligibility(ACTIVE, { currentEpoch: NOW - 1 })
        expect(one.reasons[0]).toContain('1 more epoch ')
        expect(one.reasons[0]).toContain('6 minutes')
        expect(exitEligibility(ACTIVE, { currentEpoch: NOW }).eligible).toBe(true)
    })

    it('treats a numeric activation epoch the same as a string one', () => {
        const asNumber = { ...ACTIVE, activationEpoch: 1000 }
        expect(exitEligibility(asNumber, { currentEpoch: NOW }).eligible).toBe(true)
        expect(exitEligibility(asNumber, { currentEpoch: NOW - 1 }).eligible).toBe(false)
        expect(exitEligibility({ ...ACTIVE, activationEpoch: '1000' }, { currentEpoch: NOW - 1 }).reasons[0])
            .toBe(exitEligibility(asNumber, { currentEpoch: NOW - 1 }).reasons[0])
    })

    it('blocks on the far-future activation sentinel instead of computing with it', () => {
        const r = exitEligibility({ ...ACTIVE, activationEpoch: FAR_FUTURE_EPOCH }, { currentEpoch: NOW })
        expect(r.eligible).toBe(false)
        expect(r.reasons.some((x) => /far-future/i.test(x))).toBe(true)
        // The sentinel must never be read as epoch 1.8e19 and produce a wait time.
        expect(r.reasons.some((x) => /more epochs/.test(x))).toBe(false)
    })

    it('blocks when the current or activation epoch is unknown or unparseable', () => {
        expect(exitEligibility(ACTIVE, {}).reasons.some((x) => /cannot be verified/i.test(x))).toBe(true)
        for (const bad of [null, undefined, '', 'soon', -1]) {
            expect(exitEligibility({ ...ACTIVE, activationEpoch: bad }, { currentEpoch: NOW }).eligible).toBe(false)
        }
    })

    it('names an unknown bucketed status without inventing one', () => {
        const r = exitEligibility({ ...ACTIVE, rawStatus: undefined, status: undefined }, { currentEpoch: NOW })
        expect(r.eligible).toBe(false)
        expect(r.reasons[0]).toContain('unknown state')
    })

    it('blocks while the beacon node is syncing or optimistic', () => {
        const syncing = exitEligibility(ACTIVE, { currentEpoch: NOW, beaconSyncing: true })
        expect(syncing.eligible).toBe(false)
        expect(syncing.reasons[0]).toMatch(/syncing/i)

        const optimistic = exitEligibility(ACTIVE, { currentEpoch: NOW, beaconOptimistic: true })
        expect(optimistic.eligible).toBe(false)
        expect(optimistic.reasons[0]).toMatch(/optimistic/i)
    })

    it('reports every blocking reason at once rather than stopping at the first', () => {
        const r = exitEligibility(
            { ...ACTIVE, rawStatus: 'pending_queued', withdrawalType: '0x00' },
            { currentEpoch: NOW - 10, beaconSyncing: true, beaconOptimistic: true },
        )
        expect(r.eligible).toBe(false)
        expect(r.reasons).toHaveLength(4) // status + activation period + syncing + optimistic
        expect(r.warnings).toHaveLength(1)
    })

    it('warns (but does not block) on 0x00 withdrawal credentials', () => {
        const r = exitEligibility({ ...ACTIVE, withdrawalType: '0x00' }, { currentEpoch: NOW })
        expect(r.eligible).toBe(true)
        expect(r.reasons).toEqual([])
        expect(r.warnings).toHaveLength(1)
        expect(r.warnings[0]).toMatch(/BLSToExecutionChange/)
    })

    it('does not warn for 0x01 / 0x02 credentials or an unknown type', () => {
        for (const type of ['0x01', '0x02', null, undefined]) {
            expect(exitEligibility({ ...ACTIVE, withdrawalType: type }, { currentEpoch: NOW }).warnings).toEqual([])
        }
    })

    it('survives a missing validator object', () => {
        const r = exitEligibility(undefined, { currentEpoch: NOW })
        expect(r.eligible).toBe(false)
        expect(r.reasons.length).toBeGreaterThan(0)
    })
})

describe('parseSignedExit', () => {
    const body = JSON.stringify({ data: SIGNED_EXIT })

    it('extracts the data object from a raw response body', () => {
        const r = parseSignedExit(body)
        expect(r.ok).toBe(true)
        expect(r.signedExit).toEqual(SIGNED_EXIT)
    })

    it('accepts an already-parsed object and returns the data object unchanged', () => {
        const parsed = { data: SIGNED_EXIT }
        const r = parseSignedExit(parsed)
        expect(r.ok).toBe(true)
        expect(r.signedExit).toBe(parsed.data) // same reference - nothing re-serialised
    })

    it('keeps the uint64 fields as strings', () => {
        const big = { data: { message: { epoch: '18446744073709551614', validator_index: '9007199254740993' }, signature: '0xff' } }
        const r = parseSignedExit(JSON.stringify(big))
        expect(r.ok).toBe(true)
        expect(r.signedExit.message.epoch).toBe('18446744073709551614')
        expect(r.signedExit.message.validator_index).toBe('9007199254740993')
    })

    it('rejects numeric uint64 fields - a number means precision was already lost', () => {
        const epochNum = parseSignedExit({ data: { message: { epoch: 9876, validator_index: '1234' }, signature: '0xff' } })
        expect(epochNum.ok).toBe(false)
        expect(epochNum.error).toContain('message.epoch')
        expect(epochNum.error).toMatch(/string/i)

        const indexNum = parseSignedExit({ data: { message: { epoch: '9876', validator_index: 1234 }, signature: '0xff' } })
        expect(indexNum.ok).toBe(false)
        expect(indexNum.error).toContain('message.validator_index')
    })

    it('rejects missing fields with a field-specific error', () => {
        expect(parseSignedExit({ data: { message: { validator_index: '1' }, signature: '0xff' } }).error).toContain('message.epoch')
        expect(parseSignedExit({ data: { message: { epoch: '1' }, signature: '0xff' } }).error).toContain('message.validator_index')
        expect(parseSignedExit({ data: { message: { epoch: '1', validator_index: '1' } } }).error).toContain('signature')
        expect(parseSignedExit({ data: { signature: '0xff' } }).error).toContain('message')
        expect(parseSignedExit({ data: { message: { epoch: '1', validator_index: '1' }, signature: '' } }).error).toContain('signature')
    })

    it('rejects a missing or non-object data field', () => {
        for (const bad of ['{}', JSON.stringify({ data: null }), JSON.stringify({ data: [] }), JSON.stringify({ data: 'x' })]) {
            const r = parseSignedExit(bad)
            expect(r.ok).toBe(false)
            expect(r.error).toContain('data')
        }
    })

    it('rejects an unreadable body', () => {
        const r = parseSignedExit('<html>502 Bad Gateway</html>')
        expect(r.ok).toBe(false)
        expect(r.error).toMatch(/unreadable/i)
    })
})

describe('exitBroadcastBody', () => {
    it('posts the signed exit ITSELF - never wrapped in {data}', () => {
        const out = exitBroadcastBody(SIGNED_EXIT)
        expect(out).toBe(SIGNED_EXIT)
        expect(out).not.toHaveProperty('data')
        expect(Object.keys(out).sort()).toEqual(['message', 'signature'])
        // The exact wire shape: a re-wrap here is the 400 that misreads as a signature error.
        expect(JSON.parse(JSON.stringify(out))).toEqual({
            message: { epoch: '9876', validator_index: '1234' },
            signature: '0x' + 'cd'.repeat(96),
        })
    })

    it('round-trips the step-1 parse into the step-2 body without adding a layer', () => {
        const parsed = parseSignedExit(JSON.stringify({ data: SIGNED_EXIT }))
        expect(JSON.stringify(exitBroadcastBody(parsed.signedExit))).toBe(JSON.stringify(SIGNED_EXIT))
    })
})

describe('isExitAccepted', () => {
    it('accepts 200 only', () => {
        expect(isExitAccepted(200)).toBe(true)
        for (const code of [0, 202, 204, 400, 415, 500]) expect(isExitAccepted(code)).toBe(false)
    })
})

describe('exitStatusMessage', () => {
    it('says the exit is pooled, not on chain, on success', () => {
        const msg = exitStatusMessage(200, '')
        expect(msg).toMatch(/pool/i)
        expect(msg).toMatch(/not on chain/i)
    })

    it('surfaces the beacon node message verbatim', () => {
        const body = JSON.stringify({ code: 400, message: 'Invalid voluntary exit, it will never pass validation so it is dropped' })
        expect(exitStatusMessage(400, body)).toBe('HTTP 400: Invalid voluntary exit, it will never pass validation so it is dropped')
    })

    it('falls back to the bare status when the error body is not JSON or has no message', () => {
        expect(exitStatusMessage(500, 'Internal Server Error')).toBe('Beacon node rejected the exit (HTTP 500)')
        expect(exitStatusMessage(400, JSON.stringify({ code: 400 }))).toBe('Beacon node rejected the exit (HTTP 400)')
    })

    it('reports no response when curl never got a status', () => {
        expect(exitStatusMessage(0, '')).toMatch(/did not respond/i)
    })
})
