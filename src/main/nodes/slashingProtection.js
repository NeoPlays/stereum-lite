/**
 * Slashing protection: pure, unit-testable gates for the EIP-3076 interchange file a user
 * supplies when importing validator keystores. No I/O lives here - the import itself is in
 * Node.js - so every rule that stands between the user and a slashing is testable in isolation.
 *
 * The premise: a key that has already signed on this chain MUST arrive with its signing history.
 * Without it the new client's anti-slash DB starts empty, its min()/max() checks have nothing to
 * compare against, and the first double vote is a slashable offence. The keymanager API is no
 * help here - it happily reports `imported` for a key whose history it never received - so the
 * only place this can be caught is before the request is sent.
 */

/** EIP-3076 pins the format at "5". Files in the wild carry it as a string or a bare number. */
export const INTERCHANGE_FORMAT_VERSION = '5'

// The uint64 fields EIP-3076 requires to be JSON STRINGS. A JSON number is an IEEE-754 double in
// every JS runtime, so a slot above 2^53 silently loses precision the moment it is parsed - and a
// wrong-by-one slot is exactly the input an anti-slash check must never be given.
const UINT64_FIELDS = ['slot', 'source_epoch', 'target_epoch']

const asArray = (value) => (Array.isArray(value) ? value : [])

/** Pubkeys are compared lowercased and trimmed: EIP-3076 does not specify hex casing. */
const normalizeKey = (key) => String(key ?? '').trim().toLowerCase()

/**
 * Parse the interchange JSON.
 * @param {string} text
 * @returns {{ ok: true, json: object }|{ ok: false, error: string }}
 */
export function parseInterchange(text) {
    if (typeof text !== 'string') return { ok: false, error: 'No interchange file was provided' }
    if (text.trim() === '') return { ok: false, error: 'The interchange file is empty' }
    let json
    try {
        json = JSON.parse(text)
    } catch (err) {
        return { ok: false, error: `Not valid JSON: ${err?.message ?? 'could not be parsed'}` }
    }
    // A bare array or scalar parses fine but has no metadata/data, and would otherwise surface as
    // three confusing downstream errors instead of one accurate one.
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, error: 'The interchange file must be a JSON object with "metadata" and "data"' }
    }
    return { ok: true, json }
}

/**
 * True when NO slot / source_epoch / target_epoch anywhere in data[] is a JavaScript number.
 *
 * A numeric field means the file was reserialised by something that decoded these as numbers, so
 * any value past 2^53 may ALREADY be corrupted - the damage happened before we saw the file and
 * cannot be detected from the value itself. That makes this a blocking condition, not a warning.
 *
 * Accepts a parsed object or the raw text. Unparseable/shapeless input returns true: there is no
 * violation to find, and parseability is reported separately by validateInterchange.
 */
export function hasStringNumerics(json) {
    let parsed = json
    if (typeof parsed === 'string') {
        const result = parseInterchange(parsed)
        if (!result.ok) return true
        parsed = result.json
    }
    for (const entry of asArray(parsed?.data)) {
        const records = [...asArray(entry?.signed_blocks), ...asArray(entry?.signed_attestations)]
        for (const record of records) {
            for (const field of UINT64_FIELDS) {
                if (typeof record?.[field] === 'number') return false
            }
        }
    }
    return true
}

/**
 * Validate an interchange file against the keys about to be imported and the node's chain.
 *
 * @param {string} text raw file contents
 * @param {{ pubkeys?: string[], genesisValidatorsRoot?: string|null }} options
 *        `pubkeys` are the keys being imported; `genesisValidatorsRoot` is the node's own GVR.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], covered: string[], missing: string[] }}
 */
export function validateInterchange(text, options = {}) {
    // Destructured off a guarded local, not the parameter: a default only fills in `undefined`,
    // so an explicit `null` from a caller that had no options to pass would throw.
    const { pubkeys = [], genesisValidatorsRoot = null } = (options && typeof options === 'object') ? options : {}
    const errors = []
    const warnings = []
    // Deduped so a repeated pubkey cannot report the same key missing twice.
    const wanted = [...new Set(asArray(pubkeys).map(normalizeKey).filter(Boolean))]

    const parsed = parseInterchange(text)
    if (!parsed.ok) {
        // Nothing was read, so every requested key is unprotected - not "covered by an empty set".
        return { ok: false, errors: [parsed.error], warnings, covered: [], missing: wanted }
    }
    const json = parsed.json
    const metadata = (json.metadata && typeof json.metadata === 'object') ? json.metadata : {}

    const version = metadata.interchange_format_version
    if (version === undefined || version === null || version === '') {
        errors.push('Missing metadata.interchange_format_version - this is not an EIP-3076 interchange file')
    } else if (String(version) !== INTERCHANGE_FORMAT_VERSION) {
        // Compared as a string so a numeric 5 passes; the actual value is echoed because "version 4"
        // vs "version 5" is the difference between a readable file and a misread one.
        errors.push(`Unsupported interchange_format_version "${version}" - only version ${INTERCHANGE_FORMAT_VERSION} is supported`)
    }

    const fileRoot = metadata.genesis_validators_root
    if (typeof fileRoot !== 'string' || fileRoot.trim() === '') {
        errors.push('Missing metadata.genesis_validators_root - the file does not say which chain it came from')
    } else if (typeof genesisValidatorsRoot === 'string' && genesisValidatorsRoot.trim() !== '') {
        // The single most important check. History from another chain is worthless: its slots and
        // epochs describe signatures that never happened here, so importing it would leave the key
        // unprotected while LOOKING protected - strictly worse than importing with no history.
        if (normalizeKey(fileRoot) !== normalizeKey(genesisValidatorsRoot)) {
            errors.push(`Wrong chain: the file's genesis_validators_root (${fileRoot}) does not match this node's (${genesisValidatorsRoot})`)
        }
    }

    if (!hasStringNumerics(json)) {
        errors.push('Slot or epoch values are JSON numbers instead of strings - EIP-3076 requires strings because numbers above 2^53 lose precision, so this file may already be corrupted')
    }

    const data = json.data
    if (!Array.isArray(data)) {
        errors.push('Missing "data" array - the file contains no signing history')
        return { ok: false, errors, warnings, covered: [], missing: wanted }
    }

    // Deduped: a second entry for the same pubkey is a malformed file, not extra coverage.
    const covered = [...new Set(data.map((entry) => normalizeKey(entry?.pubkey)).filter(Boolean))]
    const coveredSet = new Set(covered)
    const missing = wanted.filter((key) => !coveredSet.has(key))
    if (missing.length) {
        // Blocking: the client would answer `imported` for these keys and protect none of them.
        errors.push(`${missing.length} of ${wanted.length} key(s) have no entry in the file and would import with no slashing protection at all`)
    }

    // Warn only about entries the user is actually relying on; a big cluster-wide export otherwise
    // buries the one relevant warning under hundreds about keys nobody is importing.
    const wantedSet = new Set(wanted)
    const relevant = (key) => wanted.length === 0 || wantedSet.has(key)
    for (const entry of data) {
        const key = normalizeKey(entry?.pubkey)
        if (!key || !relevant(key)) continue
        const empty = asArray(entry.signed_blocks).length === 0 && asArray(entry.signed_attestations).length === 0
        if (empty) {
            // Schema-valid but protects nothing: the client's checks are min()/max() over this set,
            // and an empty set constrains no future signature.
            warnings.push(`${key} has no signed blocks or attestations - the entry is present but protects nothing`)
        }
    }

    return { ok: errors.length === 0, errors, warnings, covered, missing }
}

/**
 * Counts to show the user what they are about to rely on, or null if the file is unreadable.
 * Never throws. Counts are lengths only - no uint64 value is read, let alone coerced.
 */
export function interchangeSummary(text) {
    const parsed = parseInterchange(text)
    if (!parsed.ok) return null
    const json = parsed.json
    const data = asArray(json.data)
    let blockCount = 0
    let attestationCount = 0
    for (const entry of data) {
        blockCount += asArray(entry?.signed_blocks).length
        attestationCount += asArray(entry?.signed_attestations).length
    }
    const root = json.metadata?.genesis_validators_root
    return {
        pubkeyCount: data.length,
        blockCount,
        attestationCount,
        genesisValidatorsRoot: typeof root === 'string' ? root : null,
    }
}
