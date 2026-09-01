import { describe, it, expect } from 'vitest'
import {
    BEACON_VALIDATORS_PATH,
    CHUNK_MARKER,
    HTTP_MARKER,
    normalizeBeaconUrl,
    bucketStatus,
    withdrawalType,
    toValidatorStat,
    buildBeaconValidatorsScript,
    parseBeaconStates,
} from '@main/nodes/beaconValidators'

describe('normalizeBeaconUrl', () => {
    it('trims + strips trailing slash, accepts host:port/path', () => {
        expect(normalizeBeaconUrl('  http://10.0.0.5:5052/  ')).toBe('http://10.0.0.5:5052')
        expect(normalizeBeaconUrl('https://beacon.example.com')).toBe('https://beacon.example.com')
    })
    it('rejects non-URLs and shell metacharacters', () => {
        for (const bad of ['', 'ftp://x', 'notaurl', "http://x/'", 'http://x/$(id)', undefined, 5]) {
            expect(normalizeBeaconUrl(bad)).toBeNull()
        }
    })
})

describe('bucketStatus', () => {
    it('buckets the full ValidatorStatus enum', () => {
        expect(bucketStatus('active_ongoing', false)).toBe('Active')
        expect(bucketStatus('active_exiting', false)).toBe('Active')
        expect(bucketStatus('pending_queued', false)).toBe('Pending')
        expect(bucketStatus('exited_unslashed', false)).toBe('Exited')
        expect(bucketStatus('withdrawal_done', false)).toBe('Exited')
    })
    it('slashed wins over the prefix', () => {
        expect(bucketStatus('active_slashed', false)).toBe('Slashed')
        expect(bucketStatus('exited_slashed', false)).toBe('Slashed')
        expect(bucketStatus('active_ongoing', true)).toBe('Slashed')
    })
})

describe('withdrawalType', () => {
    it('reads the leading byte', () => {
        expect(withdrawalType('0x00abc')).toBe('0x00')
        expect(withdrawalType('0x01' + 'f'.repeat(60))).toBe('0x01')
        expect(withdrawalType('0x02' + 'a'.repeat(60))).toBe('0x02')
    })
    it('is null for junk', () => {
        expect(withdrawalType('')).toBeNull()
        expect(withdrawalType('0x')).toBeNull()
        expect(withdrawalType(null)).toBeNull()
    })
})

describe('toValidatorStat', () => {
    it('maps a raw beacon element, gwei -> ETH, pubkey lowercased', () => {
        const raw = {
            index: '1274903', balance: '32001500000', status: 'active_ongoing',
            validator: { pubkey: '0xABCD', effective_balance: '32000000000', slashed: false, withdrawal_credentials: '0x0100', activation_epoch: '1234' },
        }
        expect(toValidatorStat(raw)).toEqual({
            pubkey: '0xabcd', index: 1274903, status: 'Active', rawStatus: 'active_ongoing', slashed: false,
            balance: 32.0015, effectiveBalance: 32, withdrawalType: '0x01', activationEpoch: '1234',
        })
    })

    it('keeps the raw status, which the coarse bucket cannot express', () => {
        // 'Active' covers both active_ongoing and active_exiting, but only one of those may be
        // exited - so the exit gate reads rawStatus, not the bucket.
        const exiting = toValidatorStat({ index: '1', status: 'active_exiting', validator: { pubkey: '0xa' } })
        expect(exiting.status).toBe('Active')
        expect(exiting.rawStatus).toBe('active_exiting')
    })

    it('leaves rawStatus null when the beacon omitted it', () => {
        expect(toValidatorStat({ index: '1', validator: { pubkey: '0xa' } }).rawStatus).toBeNull()
    })
})

describe('buildBeaconValidatorsScript', () => {
    it('POSTs the ids array with a fail-fast timeout, http-status writeout, and chunk marker', () => {
        const s = buildBeaconValidatorsScript('http://stereum-x:5052', ['0xaa', '0xbb'])
        expect(s).toContain(`-X POST 'http://stereum-x:5052${BEACON_VALIDATORS_PATH}'`)
        expect(s).toContain(`-d '{"ids":["0xaa","0xbb"]}'`)
        expect(s).toContain('-m 10')
        expect(s).toContain(`-w '\\n${HTTP_MARKER}%{http_code}'`)
        expect(s).toContain(CHUNK_MARKER)
    })
    it('chunks the ids', () => {
        const keys = Array.from({ length: 5 }, (_, i) => `0x0${i}`)
        const s = buildBeaconValidatorsScript('http://b:5052', keys, { chunkSize: 2 })
        expect((s.match(new RegExp(CHUNK_MARKER, 'g')) || []).length).toBe(3) // 2+2+1
    })
    it('drops non-hex ids and returns null when none valid / no base', () => {
        expect(buildBeaconValidatorsScript('http://b', ['not-a-key'])).toBeNull()
        expect(buildBeaconValidatorsScript('', ['0xaa'])).toBeNull()
        const s = buildBeaconValidatorsScript('http://b', ['0xaa', 'bad', '0xbb'])
        expect(s).toContain(`"0xaa","0xbb"`)
    })
})

describe('parseBeaconStates', () => {
    const chunk = (arr, code = 200) => `${JSON.stringify({ data: arr })}\n${HTTP_MARKER}${code}`
    it('concatenates chunks into a pubkey-keyed map and collects http codes', () => {
        const stdout = [
            chunk([{ index: '1', balance: '32000000000', status: 'active_ongoing', validator: { pubkey: '0xAA', slashed: false } }]),
            chunk([{ index: '2', balance: '0', status: 'exited_slashed', validator: { pubkey: '0xBB', slashed: true } }]),
        ].join(`\n${CHUNK_MARKER}\n`)
        const { states, codes } = parseBeaconStates(stdout)
        expect(Object.keys(states)).toEqual(['0xaa', '0xbb'])
        expect(states['0xaa'].status).toBe('Active')
        expect(states['0xbb'].status).toBe('Slashed')
        expect(codes).toEqual([200, 200])
    })
    it('captures a non-2xx / 000 code so the caller can detect a failed beacon', () => {
        const { states, codes } = parseBeaconStates(`\n${HTTP_MARKER}000\n${CHUNK_MARKER}\n`)
        expect(states).toEqual({})
        expect(codes).toEqual([0])
    })
    it('skips a malformed chunk without throwing', () => {
        const stdout = `oops not json\n${HTTP_MARKER}500\n${CHUNK_MARKER}\n${chunk([{ index: '3', validator: { pubkey: '0xCC' } }])}`
        const { states, codes } = parseBeaconStates(stdout)
        expect(Object.keys(states)).toEqual(['0xcc'])
        expect(codes).toEqual([500, 200])
    })
})
