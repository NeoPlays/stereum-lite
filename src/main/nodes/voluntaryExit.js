/**
 * Voluntary exit: pure, unit-testable helpers for the two-step exit flow. The SSH/sidecar side
 * lives in Node.js; everything here is side-effect-free so the eligibility gate, the payload
 * shape, and the outcome wording are testable without a node.
 *
 * An exit is TWO requests against TWO different APIs, and conflating them is the classic bug:
 *   1. POST <VC keymanager>/eth/v1/validator/{pubkey}/voluntary_exit
 *      The validator client SIGNS ONLY - it does not broadcast. It answers 200 with
 *      `{"data":{"message":{"epoch","validator_index"},"signature"}}`.
 *   2. POST <beacon node>/eth/v1/beacon/pool/voluntary_exits with step 1's `data` UNWRAPPED.
 *      Success is 200 with an EMPTY body.
 *
 * Two hazards this module encodes so they cannot be re-learned the hard way:
 * - The step-1 `epoch` query parameter is deliberately OMITTED. Letting the client use its own
 *   slot clock is the only reliable choice: a past epoch drags Teku's signing fork backward and
 *   a future one is rejected as FutureEpoch.
 * - Step 2's body is the `data` object itself. Re-wrapping it in `{"data":...}` yields a 400
 *   whose text reads like a signature failure, which sends debugging in entirely the wrong
 *   direction. exitBroadcastBody exists so that unwrapping rule is written down exactly once.
 *
 * uint64 fields (`epoch`, `validator_index`) are JSON STRINGS and stay strings end to end. A
 * Number cannot hold a uint64 exactly, so reparsing one is silent corruption of a signed message.
 */
export const SHARD_COMMITTEE_PERIOD = 256
export const SLOTS_PER_EPOCH = 32

// The uint64 max, used by the beacon spec as "never" for activation/exit epochs.
export const FAR_FUTURE_EPOCH = '18446744073709551615'

export const VOLUNTARY_EXIT_PATH = (pubkey) => `/eth/v1/validator/${pubkey}/voluntary_exit`
export const EXIT_POOL_PATH = '/eth/v1/beacon/pool/voluntary_exits'

// 32 slots x 12s. Only ever used to phrase a wait as human time, never for consensus math.
const EPOCH_MINUTES = 6.4

/**
 * Epoch containing a slot. Slots are uint64 on the wire but the real values are ~1e7 and grow by
 * one per 12s, so Number stays exact here for millennia - unlike the signed `epoch`/`validator_index`
 * fields, which we never convert. Garbage (empty string, NaN, negative, wrong type) yields null so
 * a caller cannot silently treat "no data" as epoch 0.
 */
export function epochFromSlot(slot) {
    if (typeof slot !== 'string' && typeof slot !== 'number') return null
    const raw = typeof slot === 'string' ? slot.trim() : slot
    if (raw === '') return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.floor(n / SLOTS_PER_EPOCH)
}

/** Epoch value as a number, or null when absent/garbage/the far-future sentinel. */
function toEpochNumber(value) {
    if (value === null || value === undefined) return null
    const text = String(value).trim()
    // Number('') is 0, which would read a missing epoch as "activated at genesis" and wave the
    // exit straight through the SHARD_COMMITTEE_PERIOD gate. Unknown must stay unknown.
    if (text === '' || text === FAR_FUTURE_EPOCH) return null
    const n = Number(text)
    if (!Number.isFinite(n) || n < 0) return null
    return n
}

const isFarFuture = (value) => String(value ?? '').trim() === FAR_FUTURE_EPOCH

/** Phrase a number of epochs as approximate wall-clock time, for the wait-longer message. */
function approxDuration(epochs) {
    const minutes = epochs * EPOCH_MINUTES
    if (minutes < 90) return `${Math.round(minutes)} minutes`
    return `${(minutes / 60).toFixed(1)} hours`
}

/**
 * Can this validator be exited right now?
 *
 * `validator` is our normalized shape (beaconValidators.toValidatorStat) plus `rawStatus` where
 * the raw beacon status survived: { pubkey, index, status, slashed, activationEpoch,
 * withdrawalType, rawStatus? }. `rawStatus` is preferred because the coarse bucket cannot tell
 * `active_ongoing` from `active_exiting` - and an already-exiting validator must not be re-exited.
 *
 * Every blocking reason names the actual observed state, so the UI never has to say "not eligible"
 * without saying why. Absence of beacon data is itself blocking: an exit we cannot verify is one
 * we must not send.
 *
 * @returns {{ eligible: boolean, reasons: string[], warnings: string[] }}
 */
export function exitEligibility(validator, { currentEpoch = null, beaconSyncing = false, beaconOptimistic = false } = {}) {
    const reasons = []
    const warnings = []
    const v = validator || {}

    const haveBeaconData = v.index !== null && v.index !== undefined
    if (!haveBeaconData) {
        // No index means the beacon node never returned a state for this key (deposit not yet
        // processed, wrong network, or an unreachable beacon). Nothing below can be verified.
        reasons.push('No beacon-chain data for this validator, so its exit eligibility cannot be verified.')
    } else {
        const raw = typeof v.rawStatus === 'string' && v.rawStatus.trim() !== '' ? v.rawStatus.trim() : null
        if (raw) {
            if (raw !== 'active_ongoing') {
                reasons.push(`Validator status is "${raw}", not "active_ongoing" - only an active validator can submit a voluntary exit.`)
            }
        } else if (v.slashed === true) {
            reasons.push('Validator is slashed and is already being exited by the chain.')
        } else if (v.status !== 'Active') {
            reasons.push(`Validator is ${String(v.status ?? 'in an unknown state').toLowerCase()}, not active - only an active validator can submit a voluntary exit.`)
        }

        // SHARD_COMMITTEE_PERIOD. This is the single most common real-world rejection: a freshly
        // activated validator cannot exit for 256 epochs (~27 hours) after activation.
        const current = toEpochNumber(currentEpoch)
        const activation = toEpochNumber(v.activationEpoch)
        if (isFarFuture(v.activationEpoch)) {
            reasons.push('Validator has no activation epoch yet (far-future sentinel), so it has never been active.')
        } else if (activation === null || current === null) {
            reasons.push('Activation or current epoch is unknown, so the 256-epoch activation period cannot be verified.')
        } else {
            const earliest = activation + SHARD_COMMITTEE_PERIOD
            if (current < earliest) {
                const remaining = earliest - current
                reasons.push(`Validator was activated too recently: ${remaining} more ${remaining === 1 ? 'epoch' : 'epochs'} (roughly ${approxDuration(remaining)}) must pass before it may exit, ${SHARD_COMMITTEE_PERIOD} epochs after activation epoch ${activation}.`)
            }
        }
    }

    // Independent of the validator: a beacon node that is syncing or optimistic may be reporting a
    // stale or unverified head, which makes any of the checks above untrustworthy.
    if (beaconSyncing) {
        reasons.push('Beacon node is still syncing, so its view of this validator may be out of date.')
    }
    if (beaconOptimistic) {
        reasons.push('Beacon node is optimistic (its execution client has not verified the head), so its view of this validator may be wrong.')
    }

    // Warn, never block: the exit itself succeeds with 0x00 credentials, but the withdrawal cannot
    // happen until a separate BLSToExecutionChange sets an execution address.
    if (v.withdrawalType === '0x00') {
        warnings.push('Withdrawal credentials are 0x00 (BLS): the validator will exit, but its balance stays locked until a BLSToExecutionChange sets an execution withdrawal address.')
    }

    return { eligible: reasons.length === 0, reasons, warnings }
}

/**
 * Extract the signed exit from a step-1 (validator client) response.
 *
 * Validation is about the uint64 fields: a NUMBER where the spec says string means some layer
 * already ran it through JSON.parse into a float, and a 20-digit validator index cannot survive
 * that. Rejecting it loudly beats broadcasting a message whose index quietly shifted by one.
 * On success the `data` object is returned untouched - re-serialising it would risk the same loss.
 *
 * @returns {{ ok: true, signedExit: object }|{ ok: false, error: string }}
 */
export function parseSignedExit(body) {
    let json = body
    if (typeof body === 'string') {
        try { json = JSON.parse(body) } catch { return { ok: false, error: 'Unreadable voluntary exit response from the validator client' } }
    }
    const data = json?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'Voluntary exit response had no "data" object' }
    }
    const message = data.message
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return { ok: false, error: 'Signed exit had no "message" object' }
    }
    for (const field of ['epoch', 'validator_index']) {
        const value = message[field]
        if (value === undefined || value === null || value === '') {
            return { ok: false, error: `Signed exit is missing "message.${field}"` }
        }
        if (typeof value !== 'string') {
            return { ok: false, error: `Signed exit "message.${field}" must be a JSON string (uint64), got ${typeof value} - precision was already lost upstream` }
        }
    }
    if (typeof data.signature !== 'string' || data.signature === '') {
        return { ok: false, error: 'Signed exit is missing "signature"' }
    }
    return { ok: true, signedExit: data }
}

/**
 * The body to POST to the beacon node's exit pool: the signed exit ITSELF.
 *
 * Not `{ data: signedExit }`. The beacon node answers a wrapped body with a 400 that reads like a
 * signature problem, so this identity function exists purely to state the rule once and pin it
 * with a test.
 */
export function exitBroadcastBody(signedExit) {
    return signedExit
}

/** The exit pool accepts with 200 and an empty body. 202 is not used by this endpoint. */
export function isExitAccepted(httpCode) {
    return httpCode === 200
}

/**
 * Human-readable outcome of the step-2 broadcast. Beacon nodes disagree on error wording, so a
 * present `message` is surfaced verbatim and never branched on - the node's own text is more
 * accurate than anything we could infer from it.
 */
export function exitStatusMessage(httpCode, body) {
    if (isExitAccepted(httpCode)) {
        // Deliberately not "exited": 200 only means the exit entered the gossip pool. It takes
        // effect when a proposer includes it in a block, and the validator keeps duties until then.
        return 'Exit accepted into the beacon node exit pool. It is not on chain yet - the validator keeps its duties until the exit is included in a block.'
    }
    let message = ''
    try {
        const json = JSON.parse(body)
        if (typeof json?.message === 'string') message = json.message
    } catch { /* not JSON - fall through to the bare status */ }
    if (!httpCode) return message || 'Beacon node did not respond to the exit broadcast'
    return message ? `HTTP ${httpCode}: ${message}` : `Beacon node rejected the exit (HTTP ${httpCode})`
}
