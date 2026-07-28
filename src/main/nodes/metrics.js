/**
 * Node monitoring - host system metrics + per-client (execution/consensus) health.
 *
 * Two concerns live here, both as pure parsers so they can be unit-tested against
 * captured fixtures (same pattern as `parseSubTasks`):
 *   - system:  one SSH exec over /proc + df  → { cpu, memory, disk }
 *   - clients: one `docker run` curl sidecar  → { [serviceId]: { syncing, peers, … } }
 *
 * The client probe runs a throwaway `curlimages/curl` container attached to the
 * stereum docker network, so it can reach each client by its container name
 * (`stereum-<id>`) over docker's embedded DNS at the client's *internal* API port -
 * independent of whether the RPC port is published to the host.
 */

// ── System metrics ──────────────────────────────────────────────────────────

// Marker-delimited so parsing is positional-independent and resilient to a missing
// section (same delimiter trick as the client probe below). No sudo: every source
// here is world-readable. Disk is NOT here - it's the separate, heavier disk-breakdown
// probe (per-service `du`), polled on a slower cadence than these cheap counters.
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
 * Parse the marker-delimited output of {@link SYSTEM_METRICS_CMD} into a DTO.
 * CPU% comes from the delta between the two `/proc/stat` samples.
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

    // Memory (kB in /proc/meminfo → bytes). Used = Total − Available (the modern,
    // buffers/cache-aware definition, matching `free`'s "available").
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

// System / pseudo filesystems that monitoring services bind-mount for host inspection
// - never `du` these. PrometheusNodeExporter mounts `/` (`/:/host:ro,rslave`) and
// MetricsExporter mounts `/proc`, `/sys`, `/` (all `ro`). du-ing them would walk the
// whole host and misattribute all of its disk to that one service.
const SYSTEM_MOUNTS = new Set(['/', '/proc', '/sys', '/dev', '/run', '/boot', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var'])

const normalizePath = (p) => p.replace(/\/+$/, '') || '/'

/** Same path, or one is an ancestor of the other (so du-ing both double-counts). */
function pathsOverlap(a, b) {
    const na = normalizePath(a), nb = normalizePath(b)
    return na === nb || nb.startsWith(na + '/') || na.startsWith(nb + '/')
}

/**
 * Host-side paths of a service's bind-mount volumes, filtered to what's safe and
 * meaningful to measure. A stereum volume is stored as `<host>[:<container>[:opts]]`
 * (opts e.g. `ro,rslave`). We keep absolute host paths that are the service's own
 * writable data and drop:
 *   - named/relative volumes (no host dir),
 *   - read-only mounts (host-inspection, not the service's data),
 *   - system/pseudo filesystems (safety net if a system mount isn't flagged `ro`).
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
function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'"'"'`)}'`
}

/**
 * Build the disk-breakdown command: one `du -sb` over every service's host volume
 * paths (bytes + path per line), then a `df` for the filesystem holding them. `du`
 * walks the tree, so this is the heavy probe - run it on a slow cadence, not the
 * 5s health poll. Missing paths are ignored (`2>/dev/null`).
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
 * Parse the du + df output into a stacked-bar DTO. Each service's footprint is the
 * sum of `du` over its host paths; `other` is used space not attributable to a
 * service; `free` is total − used.
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

    // Count each host path once, even when several services mount it (the CL mounts
    // the EL's engine.jwt; Prysm-devnet mounts the EL's working dir) or a service
    // mounts both a dir and something inside it - `claimed` skips overlapping paths so
    // attributed bytes never exceed real usage.
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
 * Map a stereum service type (`config.service`) → how to read its health.
 * `port` is the client's *internal* (in-container) API port; `api` selects the
 * probe/parse strategy. Execution clients speak JSON-RPC (eth_syncing +
 * net_peerCount); consensus clients speak the Beacon REST API
 * (/eth/v1/node/syncing + /eth/v1/node/peer_count).
 *
 * Ports confirmed against stereum-dev/ethereum-node's launcher service definitions
 * (`launcher/src/backend/ethereum-services/*Service.js` command args / endpoint
 * getters). All EL clients serve HTTP-RPC on 8545 (8551 is the JWT-gated engine port
 * - never probe it). Beacon REST ports vary: Teku 5051, Lodestar 9596, Prysm's REST
 * gateway 3500 (its gRPC is 4000 - use 3500 for the /eth/v1 routes).
 *
 * `peerFlags` / `defaultMaxPeers` drive the peer progress-bar denominator:
 * `resolveMaxPeers` reads the configured flag from the service's command args first,
 * then falls back to the client's built-in default. Confirmed defaults (client docs /
 * current-stable source): Geth 50, Nethermind 50, Besu 25 (`--max-peers` cap),
 * Erigon 32, Reth 130 (inbound 30 + outbound 100 - no single default flag; unified
 * `--max-peers` read when set), Ethrex 100, Lighthouse 200, Prysm 70 (stereum pins
 * `--p2p-max-peers=100` in-config → read from command), Teku 100 (`--p2p-peer-upper-bound`),
 * Nimbus 160, Lodestar 200, Grandine 200 (stereum pins `--target-peers=80` in-config).
 * Do not hand-edit without re-checking the client's CLI.
 */
export const CLIENT_REGISTRY = {
    // Execution (JSON-RPC http port - all 8545)
    GethService:       { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--maxpeers'], defaultMaxPeers: 50 },
    NethermindService: { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--Network.MaxActivePeers'], defaultMaxPeers: 50 },
    BesuService:       { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--max-peers'], defaultMaxPeers: 25 },
    ErigonService:     { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--maxpeers'], defaultMaxPeers: 32 },
    RethService:       { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--max-peers'], defaultMaxPeers: 130 },
    EthrexService:     { role: 'execution', api: 'jsonrpc', port: 8545, peerFlags: ['--p2p.target-peers'], defaultMaxPeers: 100 },
    // Consensus (Beacon REST API port). `promClock`/`promHead` are the Prometheus slot
    // metrics stereum's clients export (see prometheus.yml.j2 / upstream Monitoring
    // getSyncStatus): clock = wall-clock target slot, head = node's synced slot. Sync %
    // from these is more reliable than the API's self-reported sync_distance, so it's
    // preferred when Prometheus is up, with the beacon API as fallback.
    LighthouseBeaconService: { role: 'consensus', api: 'beacon', port: 5052, peerFlags: ['--target-peers'], defaultMaxPeers: 200, promClock: 'slotclock_present_slot', promHead: 'beacon_head_state_slot' },
    PrysmBeaconService:      { role: 'consensus', api: 'beacon', port: 3500, peerFlags: ['--p2p-max-peers'], defaultMaxPeers: 70, promClock: 'beacon_clock_time_slot', promHead: 'beacon_head_slot' },
    TekuBeaconService:       { role: 'consensus', api: 'beacon', port: 5051, peerFlags: ['--p2p-peer-upper-bound'], defaultMaxPeers: 100, promClock: 'beacon_slot', promHead: 'beacon_head_slot' },
    NimbusBeaconService:     { role: 'consensus', api: 'beacon', port: 5052, peerFlags: ['--max-peers'], defaultMaxPeers: 160, promClock: 'beacon_slot', promHead: 'beacon_head_slot' },
    LodestarBeaconService:   { role: 'consensus', api: 'beacon', port: 9596, peerFlags: ['--targetPeers', '--network.targetPeers'], defaultMaxPeers: 200, promClock: 'beacon_clock_slot', promHead: 'beacon_head_slot' },
    GrandineBeaconService:   { role: 'consensus', api: 'beacon', port: 5052, peerFlags: ['--target-peers'], defaultMaxPeers: 200, promClock: 'beacon_clock_slot', promHead: 'beacon_head_slot' },
}

// Image used for the throwaway probe sidecar.
export const CURL_IMAGE = 'curlimages/curl'

// The docker network every stereum service container joins - confirmed at
// controls/roles/manage-service/tasks/main.yml (`docker_network: name: stereum`).
// Containers resolve each other by name (`stereum-<uuid>`) over its embedded DNS.
export const STEREUM_DOCKER_NETWORK = 'stereum'

// Prometheus service type + internal port (PrometheusService.js ServicePortDefinition).
export const PROMETHEUS_SERVICE = 'PrometheusService'
export const PROMETHEUS_PORT = 9090
// Marker for the Prometheus response block in the sidecar output (not a service id).
const PROM_KEY = '__prom__'

// JSON-RPC request ids for the execution-client probe - parseJsonRpc matches
// responses by id rather than position (a failed curl emits nothing, which would
// otherwise shift every later response one slot up).
const RPC_IDS = { syncing: 1, peers: 2, block: 3 }

/** Container name for a service id (hyphen - matches stereum's convention). */
const containerName = (id) => `stereum-${id}`
/** Per-service delimiter emitted by the probe script so responses can be split back apart. */
const marker = (id) => `===${id}===`

/**
 * Build the sidecar shell script that probes every probeable running client, or
 * null when there's nothing to probe. Each client emits a `===<id>===` marker line
 * followed by its raw JSON responses, separated by a blank line. Per-request `-m 3`
 * so one hung client can't stall the batch.
 *
 * When `promHost` (`stereum-<id>:9090`) is given and a consensus client is running,
 * an extra `===__prom__===` block queries Prometheus once for all the beacon slot
 * metrics - the preferred, more reliable sync source (see parseClientMetrics).
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
            // Distinct request ids (RPC_IDS) - responses are matched back by id, so a
            // single timed-out curl drops its own value instead of shifting the rest.
            const rpc = (method, reqId) =>
                `curl -s -m 3 -X POST -H 'content-type: application/json' ` +
                `-d '{"jsonrpc":"2.0","method":"${method}","params":[],"id":${reqId}}' http://${host}`
            blocks.push(rpc('eth_syncing', RPC_IDS.syncing))
            blocks.push("echo ''")
            blocks.push(rpc('net_peerCount', RPC_IDS.peers))
            blocks.push("echo ''")
            // eth_blockNumber gives the head block even when synced (eth_syncing=false
            // reports no block number), so the sync bar always has a value to show.
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
 * Parse the delimited probe output back into a per-service result map. A client that
 * returned nothing / unparseable JSON gets `{ ..., error }` rather than dropping out,
 * so the UI can show "unavailable" instead of the row vanishing.
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
        // maxPeers is a property of the client's *config*, not its probe response -
        // resolve it up front so it's present even when the probe itself failed.
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
 * Compute a consensus client's sync from the Prometheus vector: syncPct = head/clock
 * where clock is the wall-clock target slot. Returns null when Prometheus wasn't
 * queried or this client's metrics aren't present (→ caller falls back to the API).
 * Matches by metric name + the scrape `instance` label containing the service id.
 * `head` is the node's synced slot; `clock` is the target (current) slot.
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
 * The effective max/target peer count for a client - the denominator of the peer
 * progress bar. Reads the configured value from the service's `command` flags
 * (registry `peerFlags`, first match wins) and falls back to the client's documented
 * default (`defaultMaxPeers`) when the flag isn't passed.
 * @returns {number|null}
 */
export function resolveMaxPeers(config, reg) {
    const fromFlag = reg?.peerFlags ? findFlagValue(config?.command, reg.peerFlags) : null
    const n = fromFlag != null ? parseInt(fromFlag, 10) : NaN
    return Number.isFinite(n) ? n : (reg?.defaultMaxPeers ?? null)
}

/**
 * Find the value of the first matching CLI flag in a stereum `command` array. Handles
 * both `--flag=value` and `--flag value` (value in the next element) forms, and is
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
    // false => fully synced; object => syncing with currentBlock/highestBlock (hex).
    // `head` is the imported block, `target` the network head (for a "block x / y" read).
    let syncing, syncPct, head, target
    if (sync === false) {
        syncing = false
        syncPct = 100
        // Synced: eth_syncing reports no block number - take the head from eth_blockNumber.
        // The node IS at the head, so target === head (renders "block x / x", symmetric
        // with the consensus client which always shows head / clock).
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
    // Match responses by shape, not position - if the syncing curl times out, the
    // peer_count response would otherwise be read as the sync response (and vice
    // versa peers would silently go null, blanking the peer bar for a poll).
    const syncingRes = jsons.find((j) => j?.data && j.data.is_syncing !== undefined)
    const peerRes = jsons.find((j) => j?.data && j.data.connected !== undefined)
    const d = syncingRes?.data
    if (!d) {
        const peersOnly = toNum(peerRes?.data?.connected)
        if (peersOnly == null) throw new Error('no beacon syncing response')
        // Syncing curl failed but peers made it - keep them (Prometheus usually still
        // supplies sync; without it the row shows peers with an "unknown" sync pill).
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
