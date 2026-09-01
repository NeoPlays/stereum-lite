/**
 * Beacon validator stats: pure, unit-testable helpers to enrich validator pubkeys with their
 * on-chain state (index, status, balance, withdrawal creds, activation epoch) from the beacon
 * REST API - `POST /eth/v1/beacon/states/head/validators` with `{ids:[pubkey|index]}`.
 *
 * POST (not GET) is used deliberately: the spec caps GET `?id=` at 64 items, so a solo VC or
 * Charon cluster with hundreds/thousands of keys must POST the id array. Requests are chunked
 * and marker-delimited so one curl sidecar answers the whole set. Balances are gwei -> ETH.
 *
 * The exec side lives in Node.getValidatorStates. Both solo VC pubkeys and Charon's cluster-lock
 * distributed_public_key are real on-chain validators and enrich identically; key SHARES do not.
 */
export const BEACON_VALIDATORS_PATH = '/eth/v1/beacon/states/head/validators'
export const CHUNK_MARKER = '===VSTATE_CHUNK==='
export const HTTP_MARKER = '===VSTATE_HTTP==='
const REQUEST_TIMEOUT_S = 10
const HEX_PUBKEY = /^0x[0-9a-fA-F]{2,}$/

/**
 * Trim + validate a user-supplied beacon base URL (the "stats beacon" override), returning it
 * without a trailing slash or null. Allowlists only scheme/host/port/path chars so it is safe
 * to embed in the sidecar curl command.
 */
export function normalizeBeaconUrl(url) {
    if (typeof url !== 'string') return null
    const trimmed = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[A-Za-z0-9._:/-]+$/i.test(trimmed)) return null
    return trimmed
}

/** Coarse status bucket for the UI facets. Slashed wins over the active/exited prefix. */
export function bucketStatus(status, slashed) {
    const s = String(status || '')
    // Note: only `active_slashed`/`exited_slashed` are slashed - NOT `exited_unslashed`
    // (which contains the substring "slashed"), so match the `_slashed` suffix, not includes().
    if (slashed === true || slashed === 'true' || s.endsWith('_slashed')) return 'Slashed'
    if (s.startsWith('active')) return 'Active'
    if (s.startsWith('pending')) return 'Pending'
    if (s.startsWith('exited') || s.startsWith('withdrawal')) return 'Exited'
    return 'Unknown'
}

/** Withdrawal-credentials prefix: 0x00 (BLS), 0x01 (execution), 0x02 (compounding), or null. */
export function withdrawalType(creds) {
    if (typeof creds !== 'string' || !creds.startsWith('0x') || creds.length < 4) return null
    return '0x' + creds.slice(2, 4)
}

const gweiToEth = (g) => (g == null ? null : Number(g) / 1e9)

/** Map one raw beacon `data[]` element to our stat shape (pubkey lowercased). */
export function toValidatorStat(raw) {
    const v = raw?.validator || {}
    return {
        pubkey: String(v.pubkey || '').toLowerCase(),
        index: raw?.index != null ? Number(raw.index) : null,
        status: bucketStatus(raw?.status, v.slashed),
        // The coarse bucket cannot tell `active_ongoing` from `active_exiting`, and re-exiting an
        // already-exiting validator must be blocked, so the beacon's own wording is kept alongside.
        rawStatus: typeof raw?.status === 'string' ? raw.status : null,
        slashed: v.slashed === true || v.slashed === 'true',
        balance: gweiToEth(raw?.balance),
        effectiveBalance: gweiToEth(v.effective_balance),
        withdrawalType: withdrawalType(v.withdrawal_credentials),
        activationEpoch: v.activation_epoch ?? null,
    }
}

/**
 * The inner `sh -c` script that POSTs each chunk of pubkeys, writes the HTTP status after each
 * response (so connection/HTTP failures aren't masked by the process exit code), and prints a
 * marker between chunks. Pubkeys are validated hex (anything else is dropped - it has no beacon
 * state anyway). Per-request `-m` so one dead/slow host fails fast instead of hanging the exec.
 * Returns null if the base URL is falsy or no valid pubkeys remain.
 */
export function buildBeaconValidatorsScript(base, pubkeys, { chunkSize = 200 } = {}) {
    if (!base) return null
    const ids = (Array.isArray(pubkeys) ? pubkeys : []).filter((p) => HEX_PUBKEY.test(String(p)))
    if (!ids.length) return null
    const curls = []
    for (let i = 0; i < ids.length; i += chunkSize) {
        const body = `{"ids":[${ids.slice(i, i + chunkSize).map((p) => `"${p}"`).join(',')}]}`
        curls.push(`curl -sS -m ${REQUEST_TIMEOUT_S} -X POST '${base}${BEACON_VALIDATORS_PATH}' -H 'Content-Type: application/json' -d '${body}' -w '\\n${HTTP_MARKER}%{http_code}' ; printf '\\n${CHUNK_MARKER}\\n'`)
    }
    return curls.join(' ; ')
}

/**
 * Parse the sidecar stdout (marker-delimited beacon responses) into `{ states, codes }`.
 * `codes` is the per-chunk HTTP status (000 = curl never connected), so the caller can tell a
 * genuinely-empty answer from an unreachable/erroring beacon. A malformed chunk is tolerated.
 * @returns {{ states: { [pubkey]: object }, codes: number[] }}
 */
export function parseBeaconStates(stdout) {
    const states = {}
    const codes = []
    for (const part of String(stdout ?? '').split(CHUNK_MARKER)) {
        if (!part.trim()) continue
        let body = part
        const hi = part.indexOf(HTTP_MARKER)
        if (hi !== -1) {
            body = part.slice(0, hi)
            const m = part.slice(hi + HTTP_MARKER.length).match(/\d{3}/)
            if (m) codes.push(parseInt(m[0], 10))
        }
        let json
        try { json = JSON.parse(body.trim()) } catch { continue }
        if (!Array.isArray(json?.data)) continue
        for (const raw of json.data) {
            const stat = toValidatorStat(raw)
            if (stat.pubkey) states[stat.pubkey] = stat
        }
    }
    return { states, codes }
}
