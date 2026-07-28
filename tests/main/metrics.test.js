import { describe, it, expect } from 'vitest'
import {
    parseSystemMetrics,
    buildClientProbeScript,
    parseClientMetrics,
    promSyncForService,
    resolveMaxPeers,
    serviceVolumePaths,
    buildDiskBreakdownCommand,
    parseDiskBreakdown,
    CLIENT_REGISTRY,
} from '@main/nodes/metrics'

// ── parseSystemMetrics ────────────────────────────────────────────────────────

// Two /proc/stat samples: busy climbs 100 jiffies, idle climbs 300 → 25% usage.
const SYSTEM_OUTPUT = [
    '#cpu1',
    'cpu  1000 0 500 8000 200 0 100 0 0 0',
    '#cpu2',
    'cpu  1050 0 550 8300 200 0 100 0 0 0',
    '#cores',
    '4',
    '#load',
    '0.42 0.30 0.25 1/234 5678',
    '#mem',
    'MemTotal:       16384000 kB',
    'MemAvailable:    8192000 kB',
].join('\n')

describe('parseSystemMetrics', () => {
    it('computes CPU% from the delta between the two samples', () => {
        const { cpu } = parseSystemMetrics(SYSTEM_OUTPUT)
        // idleDelta=300, totalDelta=400 → (1 - 300/400)*100 = 25
        expect(cpu.usagePct).toBe(25)
        expect(cpu.cores).toBe(4)
        expect(cpu.load1).toBe(0.42)
    })

    it('parses memory as total − available, in bytes', () => {
        const { memory } = parseSystemMetrics(SYSTEM_OUTPUT)
        expect(memory.totalBytes).toBe(16384000 * 1024)
        expect(memory.usedBytes).toBe((16384000 - 8192000) * 1024)
        expect(memory.usedPct).toBe(50)
    })

    it('degrades gracefully when sections are missing', () => {
        const r = parseSystemMetrics('#cpu1\ncpu  1 2 3 4\n')
        expect(r.cpu.usagePct).toBeNull() // only one sample → no delta
        expect(r.cpu.cores).toBeNull()
        expect(r.memory).toBeNull()
    })

    it('clamps CPU% to [0,100] on a zero/negative delta', () => {
        const flat = '#cpu1\ncpu  1000 0 500 8000\n#cpu2\ncpu  1000 0 500 8000\n'
        expect(parseSystemMetrics(flat).cpu.usagePct).toBeNull() // totalDelta 0
    })
})

// ── buildClientProbeScript ────────────────────────────────────────────────────

const geth = { id: 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', config: { service: 'GethService' }, container: { state: 'running' } }
const lh = { id: 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', config: { service: 'LighthouseBeaconService' }, container: { state: 'running' } }

describe('buildClientProbeScript', () => {
    it('returns null when there is nothing probeable', () => {
        expect(buildClientProbeScript([])).toBeNull()
        expect(buildClientProbeScript([{ id: 'x', config: { service: 'GrafanaService' }, container: { state: 'running' } }])).toBeNull()
    })

    it('skips clients that are not running', () => {
        expect(buildClientProbeScript([{ ...geth, container: { state: 'exited' } }])).toBeNull()
    })

    it('emits a marker + JSON-RPC probes for an execution client at its internal port', () => {
        const script = buildClientProbeScript([geth])
        expect(script).toContain(`===${geth.id}===`)
        expect(script).toContain(`http://stereum-${geth.id}:8545`)
        expect(script).toContain('eth_syncing')
        expect(script).toContain('net_peerCount')
        expect(script).toContain('eth_blockNumber')
    })

    it('gives each JSON-RPC request a distinct id so responses can be matched back', () => {
        const script = buildClientProbeScript([geth])
        expect(script).toContain('"method":"eth_syncing","params":[],"id":1')
        expect(script).toContain('"method":"net_peerCount","params":[],"id":2')
        expect(script).toContain('"method":"eth_blockNumber","params":[],"id":3')
    })

    it('emits beacon REST probes for a consensus client', () => {
        const script = buildClientProbeScript([lh])
        expect(script).toContain(`http://stereum-${lh.id}:5052/eth/v1/node/syncing`)
        expect(script).toContain(`http://stereum-${lh.id}:5052/eth/v1/node/peer_count`)
    })

    it('uses each consensus client its confirmed non-5052 port', () => {
        const mk = (service) => ({ id: '00000000-0000-0000-0000-000000000000', config: { service }, container: { state: 'running' } })
        expect(buildClientProbeScript([mk('TekuBeaconService')])).toContain(':5051/eth/v1/node/syncing')
        expect(buildClientProbeScript([mk('PrysmBeaconService')])).toContain(':3500/eth/v1/node/syncing')
        expect(buildClientProbeScript([mk('LodestarBeaconService')])).toContain(':9596/eth/v1/node/syncing')
    })

    it('adds a single Prometheus query for beacon slot metrics when promHost is given', () => {
        const script = buildClientProbeScript([lh], { promHost: 'stereum-prom:9090' })
        expect(script).toContain('===__prom__===')
        expect(script).toContain('http://stereum-prom:9090/api/v1/query')
        expect(script).toContain('slotclock_present_slot')
        expect(script).toContain('beacon_head_state_slot')
    })
    it('omits the Prometheus block when no consensus client is running', () => {
        expect(buildClientProbeScript([geth], { promHost: 'stereum-prom:9090' })).not.toContain('__prom__')
    })
})

describe('promSyncForService', () => {
    const reg = CLIENT_REGISTRY.LighthouseBeaconService
    const vec = (head, clock, inst = 'stereum-abc:5054') => [
        { metric: { __name__: 'beacon_head_state_slot', instance: inst }, value: [1, String(head)] },
        { metric: { __name__: 'slotclock_present_slot', instance: inst }, value: [1, String(clock)] },
    ]
    it('computes head/clock and marks synced within a slot', () => {
        expect(promSyncForService(vec(2000, 2000, 'stereum-abc:5054'), 'abc', reg)).toMatchObject({ syncing: false, syncPct: 100, head: 2000 })
        expect(promSyncForService(vec(1900, 2000, 'stereum-abc:5054'), 'abc', reg)).toMatchObject({ syncing: true, syncPct: 95 })
    })
    it('returns null when no vector, instance mismatch, or non-beacon registry entry', () => {
        expect(promSyncForService(null, 'abc', reg)).toBeNull()
        expect(promSyncForService(vec(1, 1, 'stereum-other:5054'), 'abc', reg)).toBeNull()
        expect(promSyncForService([], 'x', CLIENT_REGISTRY.GethService)).toBeNull()
    })
})

// ── parseClientMetrics ────────────────────────────────────────────────────────

describe('parseClientMetrics', () => {
    it('parses a synced execution client (eth_syncing=false) with head from eth_blockNumber', () => {
        const out = [
            `===${geth.id}===`,
            '{"jsonrpc":"2.0","id":1,"result":false}',
            '',
            '{"jsonrpc":"2.0","id":2,"result":"0x2a"}',
            '',
            '{"jsonrpc":"2.0","id":3,"result":"0x14f6a1"}', // 1373857
        ].join('\n')
        const r = parseClientMetrics(out, [geth])[geth.id]
        expect(r).toMatchObject({ role: 'execution', syncing: false, syncPct: 100, peers: 42, head: 1373857 })
    })

    it('parses a syncing execution client with a progress percentage', () => {
        const out = [
            `===${geth.id}===`,
            '{"id":1,"result":{"currentBlock":"0x32","highestBlock":"0x64"}}', // 50 / 100
            '',
            '{"id":2,"result":"0x5"}',
        ].join('\n')
        const r = parseClientMetrics(out, [geth])[geth.id]
        expect(r).toMatchObject({ syncing: true, syncPct: 50, head: 50, target: 100, peers: 5 })
    })

    it('a synced execution client uses its own head as target (renders block x / x)', () => {
        const out = `===${geth.id}===\n{"id":1,"result":false}\n\n{"id":2,"result":"0xa"}\n\n{"id":3,"result":"0x14f6a1"}`
        const r = parseClientMetrics(out, [geth])[geth.id]
        expect(r.syncing).toBe(false)
        expect(r.head).toBe(1373857)
        expect(r.target).toBe(1373857)
    })

    it('parses a beacon client sync + peer count', () => {
        const out = [
            `===${lh.id}===`,
            '{"data":{"head_slot":"1900","sync_distance":"100","is_syncing":true}}',
            '',
            '{"data":{"connected":"64"}}',
        ].join('\n')
        const r = parseClientMetrics(out, [lh])[lh.id]
        // 1900 / (1900+100) = 95%
        expect(r).toMatchObject({ role: 'consensus', syncing: true, syncPct: 95, peers: 64 })
    })

    it('includes maxPeers from the client default when the config sets no flag', () => {
        const out = `===${geth.id}===\n{"id":1,"result":false}\n\n{"id":2,"result":"0xa"}\n`
        const r = parseClientMetrics(out, [geth])[geth.id]
        expect(r.maxPeers).toBe(50) // geth default
        expect(r.peers).toBe(10)
    })

    it('prefers the max-peers value configured in the command over the default', () => {
        const prysm = {
            id: 'cccccccc-0000-0000-0000-cccccccccccc',
            config: { service: 'PrysmBeaconService', command: ['--accept-terms-of-use', '--p2p-max-peers=100'] },
            container: { state: 'running' },
        }
        const out = `===${prysm.id}===\n{"data":{"is_syncing":false,"head_slot":"100","sync_distance":"0"}}\n\n{"data":{"connected":"88"}}\n`
        const r = parseClientMetrics(out, [prysm])[prysm.id]
        expect(r.maxPeers).toBe(100) // stereum's configured value, not the 70 default
        expect(r.peers).toBe(88)
    })

    it('carries maxPeers even when the probe errored', () => {
        const r = parseClientMetrics('', [geth])[geth.id]
        expect(r).toMatchObject({ error: 'no response', maxPeers: 50 })
    })

    const promBlock = (head, clock, inst) => JSON.stringify({
        status: 'success',
        data: { resultType: 'vector', result: [
            { metric: { __name__: 'beacon_head_state_slot', instance: inst }, value: [1, String(head)] },
            { metric: { __name__: 'slotclock_present_slot', instance: inst }, value: [1, String(clock)] },
        ] },
    })

    it('prefers Prometheus slot metrics for beacon sync, peers still from the API', () => {
        const out = [
            `===${lh.id}===`,
            '{"data":{"head_slot":"1900","sync_distance":"100","is_syncing":true}}', // API would say 95%
            '',
            '{"data":{"connected":"64"}}',
            '',
            '===__prom__===',
            promBlock(1980, 2000, `stereum-${lh.id}:5054`), // 1980/2000 = 99%
            '',
        ].join('\n')
        const r = parseClientMetrics(out, [lh])[lh.id]
        expect(r).toMatchObject({ source: 'prometheus', syncPct: 99, head: 1980, clock: 2000, peers: 64 })
    })

    it('falls back to the beacon API when Prometheus lacks this client', () => {
        const out = [
            `===${lh.id}===`,
            '{"data":{"head_slot":"1900","sync_distance":"100","is_syncing":true}}',
            '',
            '{"data":{"connected":"64"}}',
            '',
            '===__prom__===',
            promBlock(5, 5, 'stereum-someone-else:5054'), // instance doesn't match lh.id
            '',
        ].join('\n')
        const r = parseClientMetrics(out, [lh])[lh.id]
        expect(r).toMatchObject({ source: 'beacon-api', syncPct: 95, peers: 64 })
    })

    // A timed-out curl's JSON is simply absent: responses must be matched by request id (EL) / shape (CL), never by position.
    it('a missing net_peerCount response leaves peers null without shifting eth_blockNumber into its place', () => {
        const out = `===${geth.id}===\n{"id":1,"result":false}\n\n{"id":3,"result":"0x14f6a1"}`
        const r = parseClientMetrics(out, [geth])[geth.id]
        expect(r).toMatchObject({ syncing: false, head: 1373857, peers: null })
    })

    it('a missing beacon syncing response keeps the peer count (Prometheus still supplies sync)', () => {
        const out = [
            `===${lh.id}===`,
            '{"data":{"connected":"64"}}', // only the peer_count curl answered
            '',
            '===__prom__===',
            promBlock(1980, 2000, `stereum-${lh.id}:5054`),
            '',
        ].join('\n')
        const r = parseClientMetrics(out, [lh])[lh.id]
        expect(r).toMatchObject({ source: 'prometheus', syncPct: 99, peers: 64 })
        expect(r.error).toBeUndefined()
    })

    it('a missing beacon syncing response without Prometheus still reports peers (sync unknown)', () => {
        const out = `===${lh.id}===\n{"data":{"connected":"64"}}\n`
        const r = parseClientMetrics(out, [lh])[lh.id]
        expect(r).toMatchObject({ source: 'beacon-api', peers: 64 })
        expect(r.syncing).toBeUndefined()
        expect(r.error).toBeUndefined()
    })

    it('a missing beacon peer_count response keeps sync intact with peers null', () => {
        const out = `===${lh.id}===\n{"data":{"head_slot":"1900","sync_distance":"0","is_syncing":false}}\n`
        const r = parseClientMetrics(out, [lh])[lh.id]
        expect(r).toMatchObject({ syncing: false, syncPct: 100, peers: null })
    })

    it('marks a client that returned nothing as errored rather than dropping it', () => {
        const r = parseClientMetrics('', [geth])[geth.id]
        expect(r).toMatchObject({ role: 'execution', error: 'no response' })
    })

    it('captures a parse error instead of throwing for a garbage response', () => {
        const out = `===${geth.id}===\nconnection refused\n`
        const r = parseClientMetrics(out, [geth])[geth.id]
        expect(r.error).toBeTruthy()
    })
})

describe('resolveMaxPeers', () => {
    const reg = { peerFlags: ['--maxpeers'], defaultMaxPeers: 50 }

    it('reads the --flag=value form', () => {
        expect(resolveMaxPeers({ command: ['--http', '--maxpeers=30'] }, reg)).toBe(30)
    })
    it('reads the --flag value (separate element) form', () => {
        expect(resolveMaxPeers({ command: ['--maxpeers', '80', '--http'] }, reg)).toBe(80)
    })
    it('is case-insensitive (Nethermind-style flags)', () => {
        const nm = { peerFlags: ['--Network.MaxActivePeers'], defaultMaxPeers: 50 }
        expect(resolveMaxPeers({ command: ['--network.maxactivepeers=12'] }, nm)).toBe(12)
    })
    it('falls back to the client default when the flag is absent', () => {
        expect(resolveMaxPeers({ command: ['--http'] }, reg)).toBe(50)
        expect(resolveMaxPeers({}, reg)).toBe(50)
        expect(resolveMaxPeers(undefined, reg)).toBe(50)
    })
    it('ignores a trailing flag with no value and uses the default', () => {
        expect(resolveMaxPeers({ command: ['--maxpeers', '--http'] }, reg)).toBe(50)
    })
    it('returns null when neither a flag value nor a default exists', () => {
        expect(resolveMaxPeers({ command: [] }, { peerFlags: ['--x'] })).toBeNull()
    })
    it('takes the first matching alias', () => {
        const aliased = { peerFlags: ['--target-peers', '--p2p-target-peers'], defaultMaxPeers: 100 }
        expect(resolveMaxPeers({ command: ['--p2p-target-peers=42'] }, aliased)).toBe(42)
    })
})

describe('serviceVolumePaths', () => {
    it('extracts absolute host paths before the first colon, deduped', () => {
        const config = { volumes: ['/opt/stereum/geth-x/data:/opt/data/geth', '/opt/stereum/geth-x/engine.jwt:/engine.jwt', '/opt/stereum/geth-x/data:/dup'] }
        expect(serviceVolumePaths(config)).toEqual(['/opt/stereum/geth-x/data', '/opt/stereum/geth-x/engine.jwt'])
    })
    it('skips named/relative volumes and handles missing volumes', () => {
        expect(serviceVolumePaths({ volumes: ['named_vol:/data', './rel:/x'] })).toEqual([])
        expect(serviceVolumePaths({})).toEqual([])
        expect(serviceVolumePaths(undefined)).toEqual([])
    })
    it('drops read-only host-inspection mounts (PrometheusNodeExporter / MetricsExporter)', () => {
        // PrometheusNodeExporter: `/` mounted ro,rslave - must never be du-ed.
        expect(serviceVolumePaths({ volumes: ['/:/host:ro,rslave'] })).toEqual([])
        // MetricsExporter: /sys, /proc, / all ro.
        expect(serviceVolumePaths({ volumes: ['/sys:/host/sys:ro', '/proc:/host/proc:ro', '/:/host/rootfs:ro'] })).toEqual([])
    })
    it('drops system/pseudo filesystems even if not flagged ro (safety net)', () => {
        expect(serviceVolumePaths({ volumes: ['/:/host', '/proc:/x', '/var:/y', '/etc:/z'] })).toEqual([])
        // a trailing slash on root is normalized
        expect(serviceVolumePaths({ volumes: ['//:/host'] })).toEqual([])
    })
    it('keeps a writable data dir that merely has a rw option', () => {
        expect(serviceVolumePaths({ volumes: ['/opt/stereum/geth-x/data:/d:rw'] })).toEqual(['/opt/stereum/geth-x/data'])
    })
})

describe('buildDiskBreakdownCommand', () => {
    const svc = { id: 'geth-1', config: { service: 'GethService', volumes: ['/opt/stereum/geth-1/data:/d'] } }
    it('du -sb over every host path then df of the target, quoted', () => {
        const cmd = buildDiskBreakdownCommand([svc], '/opt/stereum')
        expect(cmd).toContain("du -sb '/opt/stereum/geth-1/data'")
        expect(cmd).toContain("#df")
        expect(cmd).toContain("df -B1 --output=target,size,used '/opt/stereum'")
    })
    it('omits du when no service has measurable volumes', () => {
        const cmd = buildDiskBreakdownCommand([{ id: 'x', config: {} }], '/')
        expect(cmd.startsWith('du')).toBe(false)
        expect(cmd).toContain("#df")
    })
    it('never du-s the root filesystem for a host-monitoring service', () => {
        const nodeExporter = { id: 'ne', config: { service: 'PrometheusNodeExporterService', volumes: ['/:/host:ro,rslave'] } }
        const cmd = buildDiskBreakdownCommand([nodeExporter], '/opt/stereum')
        expect(cmd.startsWith('du')).toBe(false) // nothing measurable → df only
        expect(cmd).not.toContain("du -sb '/'")
    })
})

describe('parseDiskBreakdown', () => {
    const services = [
        { id: 'geth-1', config: { service: 'GethService', volumes: ['/opt/stereum/geth-1/data:/d', '/opt/stereum/geth-1/jwt:/j'] } },
        { id: 'lh-1', config: { service: 'LighthouseBeaconService', volumes: ['/opt/stereum/lh-1/data:/d'] } },
    ]
    const out = [
        '600000000000\t/opt/stereum/geth-1/data',
        '1024\t/opt/stereum/geth-1/jwt',
        '150000000000\t/opt/stereum/lh-1/data',
        '#df',
        '/opt/stereum   1000000000000   800000000000',
    ].join('\n')

    it('sums du per service, computes other/free against df totals', () => {
        const r = parseDiskBreakdown(out, services)
        expect(r.mount).toBe('/opt/stereum')
        expect(r.totalBytes).toBe(1000000000000)
        expect(r.usedBytes).toBe(800000000000)
        expect(r.freeBytes).toBe(200000000000)
        // services sorted desc: geth 600000001024, lh 150000000000
        expect(r.services[0]).toMatchObject({ id: 'geth-1', service: 'GethService', bytes: 600000001024 })
        expect(r.services[1]).toMatchObject({ id: 'lh-1', bytes: 150000000000 })
        // other = used - attributed = 800e9 - 750000001024
        expect(r.otherBytes).toBe(800000000000 - 750000001024)
    })

    it('omits services with zero measured usage', () => {
        const r = parseDiskBreakdown('#df\n/  1000  400', [{ id: 'ghost', config: { service: 'GethService', volumes: ['/nope:/d'] } }])
        expect(r.services).toEqual([])
        expect(r.otherBytes).toBe(400)
    })

    it('returns null without a usable df line', () => {
        expect(parseDiskBreakdown('600\t/x\n#df\n', services)).toBeNull()
    })

    it('counts a shared path (EL engine.jwt mounted by the CL) only once', () => {
        const shared = [
            { id: 'geth', config: { service: 'GethService', volumes: ['/opt/stereum/geth/data:/d', '/opt/stereum/geth/engine.jwt:/j'] } },
            { id: 'lh', config: { service: 'LighthouseBeaconService', volumes: ['/opt/stereum/lh/beacon:/d', '/opt/stereum/geth/engine.jwt:/j'] } },
        ]
        const out = [
            '600\t/opt/stereum/geth/data',
            '4096\t/opt/stereum/geth/engine.jwt',
            '300\t/opt/stereum/lh/beacon',
            '#df', '/  10000  5000',
        ].join('\n')
        const r = parseDiskBreakdown(out, shared)
        const geth = r.services.find((s) => s.id === 'geth')
        const lh = r.services.find((s) => s.id === 'lh')
        expect(geth.bytes).toBe(600 + 4096) // geth claims the jwt first
        expect(lh.bytes).toBe(300)          // lh's duplicate jwt mount is not re-counted
        expect(r.otherBytes).toBe(5000 - (600 + 4096 + 300))
    })

    it('does not double-count when a service mounts a dir and a path inside it', () => {
        const nested = [{ id: 'geth', config: { service: 'GethService', volumes: ['/opt/stereum/geth:/data', '/opt/stereum/geth/engine.jwt:/j'] } }]
        const out = ['700\t/opt/stereum/geth', '4096\t/opt/stereum/geth/engine.jwt', '#df', '/  10000  1000'].join('\n')
        const r = parseDiskBreakdown(out, nested)
        expect(r.services[0].bytes).toBe(700) // parent only; the nested jwt is already inside it
    })

    it('leaves host-monitoring services out of attribution entirely', () => {
        const svcs = [{ id: 'ne', config: { service: 'PrometheusNodeExporterService', volumes: ['/:/host:ro,rslave'] } }]
        const r = parseDiskBreakdown('#df\n/  10000  9000', svcs)
        expect(r.services).toEqual([])
        expect(r.otherBytes).toBe(9000) // all of used is "other", none pinned to the exporter
    })
})

describe('CLIENT_REGISTRY', () => {
    it('covers ethrex and grandine', () => {
        expect(CLIENT_REGISTRY.EthrexService).toMatchObject({ role: 'execution', port: 8545 })
        expect(CLIENT_REGISTRY.GrandineBeaconService).toMatchObject({ role: 'consensus', port: 5052 })
    })
    it('every client carries a peer flag + default for the peer progress bar', () => {
        for (const [service, reg] of Object.entries(CLIENT_REGISTRY)) {
            expect(Array.isArray(reg.peerFlags), `${service} peerFlags`).toBe(true)
            expect(reg.peerFlags.length, `${service} peerFlags`).toBeGreaterThan(0)
            expect(typeof reg.defaultMaxPeers, `${service} defaultMaxPeers`).toBe('number')
        }
    })
})
