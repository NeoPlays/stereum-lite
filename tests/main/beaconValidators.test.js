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
    configuredBeaconBases,
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

describe('configuredBeaconBases', () => {
    const svc = (id, service, command, env) => ({ id, config: { service, command, env } })
    const RUNNING = { state: 'running' }
    const CL_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'

    it('reads the endpoint out of each validator client flag form', () => {
        const cases = [
            ['LighthouseValidatorService', ['--beacon-nodes=http://remote:5052']],
            ['LodestarValidatorService', ['--beaconNodes=http://remote:5052']],
            ['TekuValidatorService', ['--beacon-node-api-endpoint=http://remote:5052']],
            ['NimbusValidatorService', ['--beacon-node=http://remote:5052']],
            ['PrysmValidatorService', ['--beacon-rest-api-provider=http://remote:5052']],
            ['CharonService', ['--beacon-node-endpoints=http://remote:5052']],
            // Space-separated is just as valid as `=`.
            ['LighthouseValidatorService', ['--beacon-nodes', 'http://remote:5052']],
        ]
        for (const [service, command] of cases) {
            expect(configuredBeaconBases([svc('v1', service, command)])).toEqual(['http://remote:5052'])
        }
    })

    it('splits a comma-separated failover list into ordered candidates', () => {
        const bases = configuredBeaconBases([
            svc('v1', 'TekuValidatorService', ['--beacon-node-api-endpoint=http://a:5052,http://b:5052']),
        ])
        expect(bases).toEqual(['http://a:5052', 'http://b:5052'])
    })

    it('ignores Prysm gRPC provider, which cannot answer a REST query', () => {
        expect(configuredBeaconBases([
            svc('v1', 'PrysmValidatorService', ['--beacon-rpc-provider=stereum-x:4000']),
        ])).toEqual([])
    })

    it('drops a local container endpoint whose container is not running', () => {
        const services = [svc('v1', 'LighthouseValidatorService', [`--beacon-nodes=http://stereum-${CL_ID}:5052`])]
        expect(configuredBeaconBases(services, { [CL_ID]: { state: 'exited' } })).toEqual([])
        // Running, or simply unknown to us, is kept.
        expect(configuredBeaconBases(services, { [CL_ID]: RUNNING })).toEqual([`http://stereum-${CL_ID}:5052`])
        expect(configuredBeaconBases(services, {})).toEqual([`http://stereum-${CL_ID}:5052`])
    })

    it('drops loopback, which from the sidecar container means the sidecar itself', () => {
        expect(configuredBeaconBases([
            svc('v1', 'LighthouseValidatorService', ['--beacon-nodes=http://127.0.0.1:5052']),
            svc('v2', 'LodestarValidatorService', ['--beaconNodes=http://localhost:5052']),
        ])).toEqual([])
    })

    it('falls back to an ExternalConsensusService link, after the validator client flags', () => {
        const bases = configuredBeaconBases([
            svc('ext', 'ExternalConsensusService', [], { link: 'https://beacon.example.com/' }),
            svc('v1', 'LighthouseValidatorService', ['--beacon-nodes=http://remote:5052']),
        ])
        expect(bases).toEqual(['http://remote:5052', 'https://beacon.example.com'])
    })

    it('dedupes the same endpoint named by several clients, and ignores junk', () => {
        expect(configuredBeaconBases([
            svc('v1', 'LighthouseValidatorService', ['--beacon-nodes=http://remote:5052']),
            svc('v2', 'NimbusValidatorService', ['--beacon-node=http://remote:5052']),
            svc('v3', 'LodestarValidatorService', ['--beaconNodes=not a url']),
            svc('v4', 'GethService', ['--http']),
            { id: 'v5' },
        ])).toEqual(['http://remote:5052'])
    })
})
