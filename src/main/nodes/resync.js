/**
 * Resync: pure, unit-testable helpers for wiping a client's chain data and re-syncing
 * from scratch (genesis) or a checkpoint URL. The destructive side (SSH exec) lives in
 * Node.resyncService; everything here is side-effect-free so the safety gates are testable.
 *
 * Data dir is resolved by config.service -> the CONTAINER side of a `host:container` volume,
 * returning the HOST path. Only the 12 concrete EL/CL clients are mapped; any type absent
 * from the map is not resyncable (its container path is unknown, so a wipe would be unsafe).
 * Devnet configs deliberately map nowhere here - their jwt lives inside the data dir, so a
 * wipe would be destructive; leaving them unmapped hard-blocks resync for them.
 */
export const DATA_DIR_CONTAINER_PATHS = {
    GethService:             ['/opt/data/geth', '/opt/app/geth'], // second is a legacy alias on migrated nodes
    ErigonService:           ['/opt/data/erigon'],
    RethService:             ['/opt/data/reth'],
    NethermindService:       ['/opt/app/data'],
    BesuService:             ['/opt/app/data'],
    EthrexService:           ['/opt/app/data'],
    TekuBeaconService:       ['/opt/app/data'],
    GrandineBeaconService:   ['/opt/app/data'],
    LighthouseBeaconService: ['/opt/app/beacon'],
    PrysmBeaconService:      ['/opt/app/beacon'],
    NimbusBeaconService:     ['/opt/app/beacon'],
    LodestarBeaconService:   ['/opt/app/beacon'],
}

// CL checkpoint-sync flags (single `--flag=value` token). Absence of a checkpoint flag IS
// genesis sync; the two genesis flags below are only for clients that need an explicit opt-in.
export const CHECKPOINT_FLAGS = {
    LighthouseBeaconService: '--checkpoint-sync-url=',
    LodestarBeaconService:   '--checkpointSyncUrl=',
    PrysmBeaconService:      '--checkpoint-sync-url=',
    NimbusBeaconService:     '--trusted-node-url=',
    TekuBeaconService:       '--initial-state=',
    GrandineBeaconService:   '--checkpoint-sync-url=',
}
export const GENESIS_FLAGS = {
    LighthouseBeaconService: '--allow-insecure-genesis-sync',
    TekuBeaconService:       '--ignore-weak-subjectivity-period-enabled',
}

// Never wipe under these first-path-segments even if the anchor check passes. Only true OS
// dirs - NOT /mnt, /media, /home, /srv, which legitimately hold installs or mounted data
// disks. Accidental wipes are already caught by the depth>=3, anchor, and id-in-path gates.
const SYSTEM_ROOTS = new Set([
    'proc', 'sys', 'dev', 'run', 'boot', 'etc', 'usr', 'bin', 'sbin',
    'lib', 'lib64', 'var', 'root', 'tmp',
])

/** Host path of a client's chain-data volume, or undefined if the type is unmapped / no volume matches. */
export function resolveDataDir(config) {
    const wanted = DATA_DIR_CONTAINER_PATHS[config?.service]
    if (!wanted) return undefined
    for (const v of (config?.volumes || [])) {
        const [host, container] = String(v).split(':')
        if (!host || !host.startsWith('/')) continue // reject relative / named volumes
        if (wanted.includes(container)) return host
    }
    return undefined
}

/**
 * The client has a resolvable, wipeable local data dir. Keyed off resolveDataDir (not just the
 * type) so the UI button never appears for a client whose data volume can't be found - clicking
 * it would only fail the safety gate at run time. Excludes External/Op/validator/monitoring.
 */
export function isResyncable(config) {
    return Boolean(resolveDataDir(config))
}

const stripTrail = (s) => s.replace(/\/+$/, '')

/**
 * Hard gate before any `rm`: every predicate must hold. Remote `test -d` is NOT a safety
 * check (`test -d /` is rc 0), so an unresolved/`/`/shallow/malformed path must be rejected
 * here before a shell string is ever built. Depth and the system-root denylist are enforced
 * unconditionally so a hostile controls_install_path (e.g. `/`) cannot widen the anchor.
 */
export function isSafeDataDir(dir, { serviceId, controlsPath } = {}) {
    if (typeof dir !== 'string') return false
    if (dir.trim() === '' || dir !== dir.trim()) return false
    // Allowlist the character set real stereum data dirs use, so any shell/glob metacharacter
    // (incl. bracket globs `[ ]` that root would re-expand from the `/*` wipe) is rejected by
    // default rather than by an easy-to-miss denylist.
    if (!/^[A-Za-z0-9._/-]+$/.test(dir)) return false
    if (!dir.startsWith('/')) return false // absolute (posix)
    if (dir.includes('//')) return false
    const segs = dir.split('/').filter(Boolean)
    if (segs.some((s) => s === '.' || s === '..')) return false // no traversal segments
    if (segs.length < 3) return false
    if (SYSTEM_ROOTS.has(segs[0])) return false
    if (dir === '/') return false
    // Anchor to /opt/stereum or the node's controls path. A controls path of `/` strips to ''
    // and must NOT widen the anchor to "any absolute path" - require a non-empty anchor.
    const cp = typeof controlsPath === 'string' ? stripTrail(controlsPath) : ''
    const anchored = dir.startsWith('/opt/stereum/') || (cp !== '' && dir.startsWith(cp + '/'))
    if (!anchored) return false
    if (!serviceId || !dir.includes(serviceId)) return false // real stereum data dirs embed the UUID
    return true
}

/**
 * Rewrite a CL client's command for the requested sync mode (returns a new array).
 * Remove any existing checkpoint flag, remove any genesis flag, then re-add: a URL adds the
 * checkpoint flag; no URL adds the genesis flag (only for the two clients that have one).
 * The remove-then-add order handles switching genesis<->checkpoint in both directions.
 */
export function updateSyncCommand(command, service, url) {
    const checkpointFlag = CHECKPOINT_FLAGS[service]
    const genesisFlag = GENESIS_FLAGS[service]
    let out = Array.isArray(command) ? [...command] : []
    if (checkpointFlag) out = out.filter((c) => !String(c).startsWith(checkpointFlag))
    if (genesisFlag) out = out.filter((c) => String(c) !== genesisFlag)
    if (url && checkpointFlag) out.push(checkpointFlag + url)
    else if (!url && genesisFlag) out.push(genesisFlag)
    return out
}

/** Whether a client type takes a checkpoint-sync URL (consensus clients only). */
export function supportsCheckpointSync(config) {
    return Boolean(CHECKPOINT_FLAGS[config?.service])
}
