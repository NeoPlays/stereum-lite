/**
 * Node monitoring: pure, unit-testable parsers for system metrics (one SSH exec) and
 * client health (a curl sidecar on the stereum network, reaching each client by
 * container name at its internal API port - no host publishing needed).
 */

// ── System metrics ──────────────────────────────────────────────────────────

// Marker-delimited so a missing section can't shift parsing. No sudo needed (all
// world-readable). Disk lives in the separate, heavier slow-polled probe below.
export const SYSTEM_METRICS_CMD = [
    "echo '#cpu1'", "grep '^cpu ' /proc/stat",
    'sleep 0.2',
    "echo '#cpu2'", "grep '^cpu ' /proc/stat",
    "echo '#cores'", 'nproc',
    "echo '#load'", 'cat /proc/loadavg',
    "echo '#mem'", "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
].join('; ')

/** Sum the jiffy fields of a `/proc/stat` `cpu ` line into { idle, total }. */
function parseCpuLine(line) {
    const f = line.trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite)
    const idle = (f[3] || 0) + (f[4] || 0) // idle + iowait
    const total = f.reduce((a, b) => a + b, 0)
    return { idle, total }
}

/**
 * Parse {@link SYSTEM_METRICS_CMD} output; CPU% from the delta of the two /proc/stat samples.
 * @returns {{ cpu:{usagePct:number|null,cores:number|null,load1:number|null},
 *             memory:{usedBytes:number,totalBytes:number,usedPct:number}|null,
 *             disk:{mount:string,usedBytes:number,totalBytes:number,usedPct:number}|null }}
 */
export function parseSystemMetrics(stdout) {
    const sections = {}
    let key = null
    for (const raw of String(stdout).split('\n')) {
        const line = raw.replace(/\r$/, '')
        const m = line.match(/^#(cpu1|cpu2|cores|load|mem)$/)
        if (m) { key = m[1]; sections[key] = []; continue }
        if (key) sections[key].push(line)
    }

    // CPU%
    let usagePct = null
    const c1 = sections.cpu1?.find(l => l.startsWith('cpu '))
    const c2 = sections.cpu2?.find(l => l.startsWith('cpu '))
    if (c1 && c2) {
        const a = parseCpuLine(c1), b = parseCpuLine(c2)
        const totalDelta = b.total - a.total
        const idleDelta = b.idle - a.idle
        if (totalDelta > 0) usagePct = round1(Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)))
    }
    const cores = toNum(sections.cores?.[0])
    const load1 = toNum(sections.load?.[0]?.split(/\s+/)[0])

    // Used = Total - Available (buffers/cache-aware, matches `free`); /proc/meminfo is kB.
    let memory = null
    const memTotalKb = toNum(sections.mem?.find(l => l.startsWith('MemTotal:'))?.match(/(\d+)/)?.[1])
    const memAvailKb = toNum(sections.mem?.find(l => l.startsWith('MemAvailable:'))?.match(/(\d+)/)?.[1])
    if (memTotalKb != null && memAvailKb != null && memTotalKb > 0) {
        const totalBytes = memTotalKb * 1024
        const usedBytes = (memTotalKb - memAvailKb) * 1024
        memory = { usedBytes, totalBytes, usedPct: round1((usedBytes / totalBytes) * 100) }
    }

    return { cpu: { usagePct, cores, load1 }, memory }
}

// ── Disk breakdown (per-service) ──────────────────────────────────────────────

// Never `du` these: monitoring services bind-mount them (NodeExporter `/`, MetricsExporter
// `/proc`,`/sys`,`/`) and du-ing would walk the whole host, misattributing its disk.
const SYSTEM_MOUNTS = new Set(['/', '/proc', '/sys', '/dev', '/run', '/boot', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var'])

const normalizePath = (p) => p.replace(/\/+$/, '') || '/'

/** Same path, or one is an ancestor of the other (so du-ing both double-counts). */
function pathsOverlap(a, b) {
    const na = normalizePath(a), nb = normalizePath(b)
    return na === nb || nb.startsWith(na + '/') || na.startsWith(nb + '/')
}

/**
 * Host paths of a service's own writable bind mounts (`<host>[:<container>[:opts]]`);
 * drops named/relative volumes, `ro` mounts, and system mounts (safety net when not `ro`).
 * @param {{ volumes?: string[] }} config
 * @returns {string[]} unique absolute host paths
 */
export function serviceVolumePaths(config) {
    const vols = Array.isArray(config?.volumes) ? config.volumes : []
    const paths = []
    for (const v of vols) {
        const parts = String(v).split(':')
        const host = parts[0]
        const options = parts[2] || ''
        if (!host.startsWith('/')) continue
        if (/(^|,)ro(,|$)/.test(options)) continue
        if (SYSTEM_MOUNTS.has(normalizePath(host))) continue
        if (!paths.includes(host)) paths.push(host)
    }
    return paths
}

/** Wrap a value in single quotes for the shell, escaping embedded single quotes. */
export function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'"'"'`)}'`
}

/**
 * Build the disk-breakdown command: `du -sb` per service volume path + one `df`.
 * `du` walks the tree - heavy probe, slow cadence only, not the 5s health poll.
 * @param {{ id:string, config?:object }[]} services
 * @param {string} dfTarget - a path on the filesystem to report totals for
 */
export function buildDiskBreakdownCommand(services = [], dfTarget = '/') {
    const paths = []
    for (const svc of services) {
        for (const p of serviceVolumePaths(svc.config)) if (!paths.includes(p)) paths.push(p)
    }
    const du = paths.length ? `du -sb ${paths.map(shellQuote).join(' ')} 2>/dev/null; ` : ''
    return `${du}echo '#df'; df -B1 --output=target,size,used ${shellQuote(dfTarget)} 2>/dev/null | tail -1`
}

/**
 * Parse the du + df output into a stacked-bar DTO (per-service bytes + other + free).
 * @param {string} stdout
 * @param {{ id:string, config?:object }[]} services
 * @returns {{ mount:string, totalBytes:number, usedBytes:number, freeBytes:number,
 *             otherBytes:number, services:{ id:string, service:string, bytes:number, pct:number }[] }|null}
 */
export function parseDiskBreakdown(stdout, services = []) {
    const lines = String(stdout).split('\n')
    const dfIdx = lines.findIndex(l => l.replace(/\r$/, '') === '#df')
    const duLines = dfIdx >= 0 ? lines.slice(0, dfIdx) : lines
    const dfLines = dfIdx >= 0 ? lines.slice(dfIdx + 1) : []

    // path → bytes from `du -sb`
    const byPath = {}
    for (const raw of duLines) {
        const m = raw.replace(/\r$/, '').match(/^(\d+)\s+(.+)$/)
        if (m) byPath[m[2].trim()] = Number(m[1])
    }

    const dfLine = dfLines.map(l => l.replace(/\r$/, '')).find(l => l.trim())
    if (!dfLine) return null
    const p = dfLine.trim().split(/\s+/)
    const totalBytes = toNum(p[1]), usedBytes = toNum(p[2])
    if (totalBytes == null || usedBytes == null || totalBytes <= 0) return null

    // Count each host path once - services share/nest mounts (engine.jwt, Prysm-devnet
    // EL dir); `claimed` skips overlaps so attributed bytes never exceed real usage.
    const svcOut = []
    let attributed = 0
    const claimed = []
    for (const svc of services) {
        let bytes = 0
        for (const path of serviceVolumePaths(svc.config)) {
            if (claimed.some((c) => pathsOverlap(c, path))) continue
            claimed.push(path)
            bytes += byPath[path] || 0
        }
        if (bytes <= 0) continue
        attributed += bytes
        svcOut.push({ id: svc.id, service: svc.config?.service ?? svc.id, bytes, pct: round1((bytes / totalBytes) * 100) })
    }
    svcOut.sort((a, b) => b.bytes - a.bytes)

    const otherBytes = Math.max(0, usedBytes - attributed)
    const freeBytes = Math.max(0, totalBytes - usedBytes)
    return { mount: p[0], totalBytes, usedBytes, freeBytes, otherBytes, services: svcOut }
}

// ── Client metrics ──────────────────────────────────────────────────────────

/**
 * Service type → probe config. `port` is the *internal* API port, confirmed against
 * stereum-dev/ethereum-node `launcher/src/backend/ethereum-services/*Service.js`
 * (never probe 8551 - JWT-gated engine port). `peerFlags`/`defaultMaxPeers` feed
 * `resolveMaxPeers`; defaults are from client docs - re-check the CLI before editing.
 */
export const CLIENT_REGISTRY = {
    // Execution (JSON-RPC http port - all 8545)
    GethService:       { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--maxpeers'], defaultMaxPeers: 50 },
    NethermindService: { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--Network.MaxActivePeers'], defaultMaxPeers: 50 },
    BesuService:       { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--max-peers'], defaultMaxPeers: 25 },
    ErigonService:     { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--maxpeers'], defaultMaxPeers: 32 },
    RethService:       { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--max-peers'], defaultMaxPeers: 130 },
    EthrexService:     { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--p2p.target-peers'], defaultMaxPeers: 100 },
    // Consensus (Beacon REST port - Prysm's REST gateway is 3500, NOT its gRPC 4000).
    // promClock/promHead: exported slot metrics (clock = wall-clock target, head = synced
    // slot; names from stereum's prometheus.yml.j2 / upstream Monitoring getSyncStatus) -
    // more reliable than the API's sync_distance.
    LighthouseBeaconService: { role: 'consensus', api: 'beacon', port: 5052, peerFlags: ['--target-peers'], defaultMaxPeers: 200, promClock: 'slotclock_present_slot', promHead: 'beacon_head_state_slot' },
    PrysmBeaconService:      { role: 'consensus', api: 'beacon', port: 3500, peerFlags: ['--p2p-max-peers'], defaultMaxPeers: 70, promClock: 'beacon_clock_time_slot', promHead: 'beacon_head_slot' },
    TekuBeaconService:       { role: 'consensus', api: 'beacon', port: 5051, peerFlags: ['--p2p-peer-upper-bound'], defaultMaxPeers: 100, promClock: 'beacon_slot', promHead: 'beacon_head_slot' },
    NimbusBeaconService:     { role: 'consensus', api: 'beacon', port: 5052, peerFlags: ['--max-peers'], defaultMaxPeers: 160, promClock: 'beacon_slot', promHead: 'beacon_head_slot' },
    LodestarBeaconService:   { role: 'consensus', api: 'beacon', port: 9596, peerFlags: ['--targetPeers', '--network.targetPeers'], defaultMaxPeers: 200, promClock: 'beacon_clock_slot', promHead: 'beacon_head_slot' },
    GrandineBeaconService:   { role: 'consensus', api: 'beacon', port: 5052, peerFlags: ['--target-peers'], defaultMaxPeers: 200, promClock: 'beacon_clock_slot', promHead: 'beacon_head_slot' },
}

// Image used for the throwaway probe sidecar.
export const CURL_IMAGE = 'curlimages/curl'

// Network every stereum container joins (controls/roles/manage-service/tasks/main.yml);
// containers resolve each other by name over its embedded DNS.
export const STEREUM_DOCKER_NETWORK = 'stereum'

// Prometheus service type + internal port (PrometheusService.js ServicePortDefinition).
export const PROMETHEUS_SERVICE = 'PrometheusService'
export const PROMETHEUS_PORT = 9090
// Marker for the Prometheus response block in the sidecar output (not a service id).
const PROM_KEY = '__prom__'

// Responses are matched by id, not position - a failed curl emits nothing and would
// otherwise shift every later response one slot up.
const RPC_IDS = { syncing: 1, peers: 2, block: 3 }

/** Container name for a service id (hyphen - matches stereum's convention). */
const containerName = (id) => `stereum-${id}`
/** Per-service delimiter emitted by the probe script so responses can be split back apart. */
const marker = (id) => `===${id}===`

/**
 * Build the sidecar script probing each running client (marker line + raw JSON blocks;
 * `-m 3` per request so one hung client can't stall the batch), plus one Prometheus
 * query block when `promHost` is given; null when nothing to probe.
 * @param {{ id:string, config?:{ service?:string }, container?:{ state?:string } }[]} services
 * @param {{ promHost?: string|null }} [opts]
 * @returns {string|null}
 */
export function buildClientProbeScript(services = [], { promHost = null } = {}) {
    const blocks = []
    const promMetrics = new Set()
    for (const svc of services) {
        const reg = CLIENT_REGISTRY[svc.config?.service]
        if (!reg) continue
        if (svc.container?.state !== 'running') continue
        if (reg.promClock && reg.promHead) { promMetrics.add(reg.promClock); promMetrics.add(reg.promHead) }
        const host = `${containerName(svc.id)}:${reg.port}`
        blocks.push(`echo '${marker(svc.id)}'`)
        if (reg.api === 'jsonrpc') {
            const rpc = (method, reqId) =>
                `curl -s -m 3 -X POST -H 'content-type: application/json' ` +
                `-d '{"jsonrpc":"2.0","method":"${method}","params":[],"id":${reqId}}' http://${host}`
            blocks.push(rpc('eth_syncing', RPC_IDS.syncing))
            blocks.push("echo ''")
            blocks.push(rpc('net_peerCount', RPC_IDS.peers))
            blocks.push("echo ''")
            // eth_blockNumber: head block even when synced (eth_syncing=false has none).
            blocks.push(rpc('eth_blockNumber', RPC_IDS.block))
        } else {
            blocks.push(`curl -s -m 3 http://${host}/eth/v1/node/syncing`)
            blocks.push("echo ''")
            blocks.push(`curl -s -m 3 http://${host}/eth/v1/node/peer_count`)
        }
        blocks.push("echo ''")
    }
    // One Prometheus query for every beacon slot metric in play.
    if (promHost && promMetrics.size) {
        const query = `{__name__=~"${[...promMetrics].join('|')}"}`
        blocks.push(`echo '${marker(PROM_KEY)}'`)
        blocks.push(`curl -s -m 3 -X POST http://${promHost}/api/v1/query -d 'query=${query}'`)
        blocks.push("echo ''")
    }
    return blocks.length ? blocks.join('; ') : null
}

/**
 * Parse probe output into a per-service map; failed probes get `{ ..., error }` (never
 * dropped) so the UI row stays.
 * @param {string} stdout
 * @param {{ id:string, config?:{ service?:string } }[]} services
 * @returns {{ [serviceId:string]: object }}
 */
export function parseClientMetrics(stdout, services = []) {
    // Split on the marker lines into { key → rawBlock } (keys are service ids or __prom__).
    const byId = {}
    let curId = null
    for (const raw of String(stdout).split('\n')) {
        const line = raw.replace(/\r$/, '')
        const m = line.match(/^===(.+)===$/)
        if (m) { curId = m[1]; byId[curId] = []; continue }
        if (curId) byId[curId].push(line)
    }

    // Prometheus instant-vector result (if queried): [{ metric:{__name__,instance,…}, value:[ts,"v"] }]
    let promVector = null
    if (byId[PROM_KEY]) {
        const parsed = extractJsonObjects(byId[PROM_KEY].join('\n'))[0]
        if (parsed?.status === 'success' && Array.isArray(parsed?.data?.result)) promVector = parsed.data.result
    }

    const out = {}
    for (const svc of services) {
        const reg = CLIENT_REGISTRY[svc.config?.service]
        if (!reg) continue
        // maxPeers comes from config, not the probe - present even when the probe failed.
        const base = { role: reg.role, api: reg.api, maxPeers: resolveMaxPeers(svc.config, reg) }
        const block = byId[svc.id]
        const jsons = block ? extractJsonObjects(block.join('\n')) : []

        if (reg.api === 'jsonrpc') {
            if (!block) { out[svc.id] = { ...base, error: 'no response' }; continue }
            try { out[svc.id] = { ...base, ...parseJsonRpc(jsons) } }
            catch (e) { out[svc.id] = { ...base, error: e?.message || 'parse failed' } }
            continue
        }

        // Consensus: prefer Prometheus slot metrics for sync; fall back to the beacon API.
        const prom = promSyncForService(promVector, svc.id, reg)
        let api = null
        try { api = parseBeacon(jsons) } catch { /* API unavailable - may still have Prometheus */ }
        if (prom) {
            out[svc.id] = { ...base, ...prom, peers: api?.peers ?? null, source: 'prometheus' }
        } else if (api) {
            out[svc.id] = { ...base, ...api, source: 'beacon-api' }
        } else {
            out[svc.id] = { ...base, error: 'no response' }
        }
    }
    return out
}

/**
 * CL sync from the Prometheus vector (syncPct = head/clock, matched by metric name +
 * `instance` containing the service id); null → caller falls back to the beacon API.
 * @returns {{ syncing:boolean, syncPct:number, head:number, clock:number }|null}
 */
export function promSyncForService(promVector, serviceId, reg) {
    if (!promVector || !reg?.promClock || !reg?.promHead) return null
    const valueOf = (name) => {
        const row = promVector.find(
            (r) => r.metric?.__name__ === name && String(r.metric?.instance || '').includes(serviceId)
        )
        const v = row ? Number(row.value?.[1]) : NaN
        return Number.isFinite(v) ? v : null
    }
    const head = valueOf(reg.promHead)
    const clock = valueOf(reg.promClock)
    if (head == null || clock == null || clock <= 0) return null
    return {
        syncing: clock - head > 1, // within a slot of the clock = synced
        syncPct: round1(Math.min(100, (head / clock) * 100)),
        head,
        clock,
    }
}

/**
 * Effective max/target peers (peer-bar denominator): configured `command` flag first
 * (`peerFlags`, first match wins), else the client's `defaultMaxPeers`.
 * @returns {number|null}
 */
export function resolveMaxPeers(config, reg) {
    const fromFlag = reg?.peerFlags ? findFlagValue(config?.command, reg.peerFlags) : null
    const n = fromFlag != null ? parseInt(fromFlag, 10) : NaN
    return Number.isFinite(n) ? n : (reg?.defaultMaxPeers ?? null)
}

/**
 * First matching CLI flag value in a `command` array; handles `--flag=v` and `--flag v`,
 * case-insensitive (Nethermind uses `--Network.MaxActivePeers`).
 * @param {string[]} command
 * @param {string[]} flags - candidate flag names incl. leading dashes
 * @returns {string|null}
 */
function findFlagValue(command, flags) {
    if (!Array.isArray(command)) return null
    const names = flags.map(f => f.toLowerCase())
    for (let i = 0; i < command.length; i++) {
        const tok = String(command[i])
        const eq = tok.indexOf('=')
        const key = (eq >= 0 ? tok.slice(0, eq) : tok).toLowerCase()
        if (!names.includes(key)) continue
        if (eq >= 0) return tok.slice(eq + 1)
        const next = command[i + 1]
        if (next != null && !String(next).startsWith('-')) return String(next)
        return null
    }
    return null
}

function parseJsonRpc(jsons) {
    const byId = (reqId) => jsons.find((j) => j?.id === reqId)
    const syncingRes = byId(RPC_IDS.syncing)
    const peerRes = byId(RPC_IDS.peers)
    const blockRes = byId(RPC_IDS.block)
    if (!syncingRes) throw new Error('no eth_syncing response')
    const sync = syncingRes.result
    // eth_syncing: false = synced; object = syncing with currentBlock/highestBlock (hex).
    let syncing, syncPct, head, target
    if (sync === false) {
        syncing = false
        syncPct = 100
        // Synced node is at the head, so target = head (renders "block x / x").
        head = blockRes ? hexToNum(blockRes.result) : null
        target = head
    } else if (sync && typeof sync === 'object') {
        syncing = true
        const cur = hexToNum(sync.currentBlock), high = hexToNum(sync.highestBlock)
        head = cur
        if (high > 0) { syncPct = round1(Math.min(100, (cur / high) * 100)); target = high }
    }
    const peers = peerRes ? hexToNum(peerRes.result) : null
    return { syncing, syncPct, head, target, peers }
}

function parseBeacon(jsons) {
    // Match responses by shape, not position - a timed-out curl would otherwise shift
    // the other response into the wrong slot.
    const syncingRes = jsons.find((j) => j?.data && j.data.is_syncing !== undefined)
    const peerRes = jsons.find((j) => j?.data && j.data.connected !== undefined)
    const d = syncingRes?.data
    if (!d) {
        const peersOnly = toNum(peerRes?.data?.connected)
        if (peersOnly == null) throw new Error('no beacon syncing response')
        // Syncing curl failed but peers made it - keep them (Prometheus usually covers sync).
        return { peers: peersOnly }
    }
    const syncing = d.is_syncing === true
    const head = toNum(d.head_slot)
    const distance = toNum(d.sync_distance)
    // head / (head + distance) - distance 0 => fully synced.
    let syncPct = null
    if (head != null && distance != null) {
        syncPct = distance === 0 ? 100 : round1(Math.min(100, (head / (head + distance)) * 100))
    }
    const peers = toNum(peerRes?.data?.connected)
    return { syncing, syncPct, head, peers }
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Pull top-level `{...}` JSON objects out of a blob (responses are concatenated). */
function extractJsonObjects(text) {
    const objs = []
    let depth = 0, start = -1, inStr = false, esc = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (inStr) {
            if (esc) esc = false
            else if (ch === '\\') esc = true
            else if (ch === '"') inStr = false
            continue
        }
        if (ch === '"') inStr = true
        else if (ch === '{') { if (depth === 0) start = i; depth++ }
        else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(text.slice(start, i + 1))) } catch { /* skip */ } start = -1 } }
    }
    return objs
}

function hexToNum(h) { if (typeof h !== 'string') return 0; const n = parseInt(h, 16); return Number.isFinite(n) ? n : 0 }
function toNum(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null }
function round1(n) { return Math.round(n * 10) / 10 }
