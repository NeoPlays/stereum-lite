/**
 * Distributed-validator (DVT) key reads: pure, unit-testable helpers for surfacing the
 * REAL validator pubkeys of an Obol cluster - which are NOT the share keystores loaded into
 * the VC, but the distributed-validator pubkeys recorded in Charon's cluster-lock.json.
 *
 * Mirrors stereum's ValidatorAccountManager.getDVTKeys (CharonService case): read
 * `<charon-data-dir>/.charon/cluster-lock.json` off the host and take
 * distributed_validators[].distributed_public_key (already 0x-prefixed). The exec side lives
 * in Node.listValidators; everything here is side-effect-free.
 *
 * (SSV's list comes from the external api.ssv.network REST API keyed by the operator id, not
 * from the node - deliberately not implemented here yet; see the Validators tab notes.)
 */
import { shellQuote } from "@main/nodes/metrics";

// Charon bind-mounts its working dir at this container path; the lockfile sits under it.
export const CHARON_CONTAINER_DIR = '/opt/charon'

/** Host path of the volume mounted at /opt/charon (Charon's data dir), or undefined. */
export function resolveCharonDataDir(config) {
    if (config?.service !== 'CharonService') return undefined
    for (const v of (config?.volumes || [])) {
        const [host, container] = String(v).split(':')
        if (container === CHARON_CONTAINER_DIR && host?.startsWith('/')) return host.replace(/\/+$/, '')
    }
    return undefined
}

/** `sudo cat <hostDir>/.charon/cluster-lock.json`, or null if the Charon volume is unresolved. */
export function buildClusterLockReadCommand(config) {
    const dir = resolveCharonDataDir(config)
    if (!dir) return null
    return `sudo cat ${shellQuote(dir + '/.charon/cluster-lock.json')}`
}

/**
 * Parse cluster-lock.json -> the distributed validator pubkeys.
 * @returns {{ pubkey: string, readonly: boolean }[]}
 */
export function parseClusterLock(stdout) {
    let json
    try { json = JSON.parse(stdout) } catch { return [] }
    const dvs = json?.distributed_validators
    if (!Array.isArray(dvs)) return []
    return dvs
        .map((dv) => dv?.distributed_public_key)
        .filter((k) => typeof k === 'string' && k)
        .map((pubkey) => ({ pubkey, readonly: false }))
}
