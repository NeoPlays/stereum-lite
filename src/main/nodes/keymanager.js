/**
 * Keymanager: pure, unit-testable helpers for talking to a validator client's standard
 * Eth Keymanager REST API (ethereum.github.io/keymanager-APIs) over the same curl sidecar
 * pattern as metrics.js. Values are sourced from stereum-launcher's ValidatorAccountManager
 * (authoritative for stereum-provisioned nodes): each client is reached by CONTAINER NAME
 * `stereum-<id>` at its INTERNAL port on the `stereum` docker network - no host publishing.
 *
 * The SSH/exec side lives in Node.js; everything here is side-effect-free so the request
 * builders, token-command builders, and response parsers are testable without a node.
 *
 * v1 scope here is the READ path (list validators + Web3Signer pubkeys); the request builder
 * is general (method/path/body) so later phases (import/remove/exit) reuse it behind gates.
 */
import { CURL_IMAGE, STEREUM_DOCKER_NETWORK } from "@main/nodes/metrics";

// Per stereum service type: internal port, scheme, whether curl must skip TLS verify (Teku
// serves the validator API over self-signed HTTPS), the command flag(s) that ENABLE the API
// (prefix-matched against config.command), an optional explicit port-flag override, and how
// its bearer token is read. Ports match stereum's ServicePort.validatorPorts exactly.
export const KEYMANAGER_REGISTRY = {
    LighthouseValidatorService: {
        port: 5062, scheme: 'http', insecure: false,
        enableFlags: ['--http'], portFlags: ['--http-port'],
        token: { mode: 'exec', dir: '/opt/app/validator/validators', file: 'api-token.txt' },
    },
    PrysmValidatorService: {
        port: 7500, scheme: 'http', insecure: false,
        enableFlags: ['--http-host', '--http-port', '--keymanager-token-file'], portFlags: ['--http-port'],
        // Prysm's token is read from the HOST side of the wallets volume, and is the LAST
        // non-empty line of the file (the file has a header line above the token).
        token: { mode: 'host-volume', containerPath: '/opt/app/data/wallets', file: 'auth-token', pick: 'last' },
    },
    TekuValidatorService: {
        port: 5052, scheme: 'https', insecure: true,
        enableFlags: ['--validator-api-enabled'], portFlags: ['--validator-api-port'],
        token: { mode: 'exec', dir: '/opt/app/data/validator/key-manager', file: 'validator-api-bearer' },
    },
    NimbusValidatorService: {
        port: 5052, scheme: 'http', insecure: false,
        enableFlags: ['--keymanager'], portFlags: ['--keymanager-port'],
        token: { mode: 'exec', dir: '/opt/app/validators', file: 'api-token.txt' },
    },
    LodestarValidatorService: {
        port: 5062, scheme: 'http', insecure: false,
        enableFlags: ['--keymanager'], portFlags: ['--keymanager.port'],
        token: { mode: 'exec', dir: '/opt/app/validator/validator-db', file: 'api-token.txt' },
    },
    Web3SignerService: {
        port: 9000, scheme: 'http', insecure: false,
        // Web3Signer's HTTP API is always on and needs no bearer token; it is not a keymanager
        // client - its keys are listed via its own /api/v1/eth2/publicKeys (see buildWeb3SignerScript).
        enableFlags: [], portFlags: ['--http-listen-port'],
        token: null, web3signer: true,
    },
}

const commandTokens = (config) => (Array.isArray(config?.command) ? config.command.map(String) : [])

/**
 * Capability of a service to answer a keymanager-style read: whether its type is known and
 * the API flag is present in its command. `reason: 'api-not-enabled'` distinguishes "known
 * client, API off" (fixable) from "not a keymanager client" so the UI can explain itself.
 * @returns {{ capable: boolean, reason: string|null, web3signer: boolean }}
 */
export function keymanagerInfo(config) {
    const entry = KEYMANAGER_REGISTRY[config?.service]
    if (!entry) return { capable: false, reason: null, web3signer: false }
    const cmd = commandTokens(config)
    const enabled = entry.web3signer || entry.enableFlags.length === 0 ||
        entry.enableFlags.some((f) => cmd.some((c) => c.startsWith(f)))
    return { capable: enabled, reason: enabled ? null : 'api-not-enabled', web3signer: Boolean(entry.web3signer) }
}

/** True if this service type can be listed via keymanager (the 5 VCs + Web3Signer). */
export function keymanagerCapable(config) {
    return keymanagerInfo(config).capable
}

/**
 * Whether the Validators tab can list keys for this service at all: either via the keymanager
 * API (VCs + Web3Signer), or via Charon's cluster-lock.json (Obol distributed validators).
 * (SSV lists via the external api.ssv.network and is not yet wired, so it's excluded here.)
 */
export function validatorListable(config) {
    return keymanagerInfo(config).capable || config?.service === 'CharonService'
}

/** First value of `--flag=value` / `--flag value` among flagNames in the command, else undefined. */
function flagValue(command, flagNames) {
    for (let i = 0; i < command.length; i++) {
        const tok = command[i]
        for (const flag of flagNames) {
            if (tok === flag) return command[i + 1]
            if (tok.startsWith(flag + '=')) return tok.slice(flag.length + 1)
        }
    }
    return undefined
}

/**
 * Resolve { port, scheme, insecure } for a service - registry defaults, with a port override
 * read from the command if the operator changed it (mirrors metrics.resolveMaxPeers).
 */
export function keymanagerTarget(config) {
    const entry = KEYMANAGER_REGISTRY[config?.service]
    if (!entry) return null
    const override = parseInt(flagValue(commandTokens(config), entry.portFlags), 10)
    return {
        port: Number.isFinite(override) ? override : entry.port,
        scheme: entry.scheme,
        insecure: entry.insecure,
    }
}

// Seconds a single keymanager request may take before curl gives up.
const KEYMANAGER_TIMEOUT_S = 20

/** Full URL of a keymanager endpoint on a service's container. Null if unusable. */
export function keymanagerUrl({ serviceId, scheme = 'http', port, path }) {
    if (!serviceId || !port || !path) return null
    return `${scheme}://stereum-${serviceId}:${port}${path.startsWith('/') ? path : '/' + path}`
}

/**
 * Escape a value for a curl config file's double-quoted form. curl understands the C-style
 * escapes \\ \" \t \r \n inside quotes, so backslash must be escaped FIRST or it would double
 * up the escapes we add afterwards. Raw newlines have to go: a config file is line-oriented,
 * and an unescaped newline would silently split one directive into two.
 */
function configQuote(value) {
    const escaped = String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\t/g, '\\t')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
    return `"${escaped}"`
}

/**
 * Build a curl config file (`curl -K -`) for one keymanager request.
 *
 * This exists to keep secrets off the command line. The bearer token, keystore JSON, and
 * keystore passwords all travel inside this config, which is piped over SSH stdin, so none of
 * them appear in the host's process list - where `-H 'Authorization: Bearer …'` would sit in
 * plain view of every user on the box.
 *
 * It also fixes a quoting hazard: the old builder interpolated `JSON.stringify(body)` into a
 * single-quoted shell string, and JSON.stringify does not escape single quotes. One apostrophe
 * in a graffiti string or a keystore password would end the quote and corrupt the command.
 * Here every value goes through configQuote instead of the shell.
 *
 * @returns {string|null} config text, or null when the URL parameters are unusable
 */
export function buildCurlConfig({ url, method = 'GET', headers = {}, body, insecure = false, timeoutS = KEYMANAGER_TIMEOUT_S }) {
    if (!url) return null
    const lines = [
        `url = ${configQuote(url)}`,
        `request = ${configQuote(String(method).toUpperCase())}`,
    ]
    for (const [name, value] of Object.entries(headers)) {
        if (value != null && value !== '') lines.push(`header = ${configQuote(`${name}: ${value}`)}`)
    }
    // `data` forces a request body; only add it when there is one, or curl would POST an empty
    // string on requests that must have no body at all (DELETE feerecipient, GET).
    if (body !== undefined) lines.push(`data = ${configQuote(typeof body === 'string' ? body : JSON.stringify(body))}`)
    if (insecure) lines.push('insecure')
    lines.push(`max-time = ${configQuote(timeoutS)}`, 'silent', 'show-error')
    return lines.join('\n') + '\n'
}

/**
 * The sidecar that consumes the config on stdin. `-i` is load-bearing: without it docker closes
 * the container's stdin and curl reads an empty config. `-w` stays on argv because the format
 * string is a fixed literal with nothing secret in it, and parseKeymanagerResponse depends on
 * that trailing status line.
 */
export function buildSidecarStdinCommand() {
    return `docker run --rm -i --network ${STEREUM_DOCKER_NETWORK} --entrypoint curl ${CURL_IMAGE} -K - -w '\\n%{http_code}'`
}

/** The same sidecar for a batched config, which carries its own per-request write-out. */
export function buildBatchSidecarCommand() {
    return `docker run --rm -i --network ${STEREUM_DOCKER_NETWORK} --entrypoint curl ${CURL_IMAGE} -K -`
}

// Delimiter curl prints after each request in a batch. Carries the request key so responses are
// matched by IDENTITY, never by position - a request that fails to connect still prints its
// marker (with code 000), but relying on order would break the moment one ever did not.
const BATCH_MARKER_PREFIX = '===KM_RESP:'
const BATCH_MARKER_SUFFIX = '==='

/**
 * Build one curl config holding MANY requests, separated by curl's `next` directive.
 *
 * This is how a bulk action over N pubkeys becomes a single SSH exec instead of N round trips
 * (N=1000 at ~200ms each would be minutes). Each section carries its own `write-out`, because
 * an argv-level `-w` only applies to the first request in a `next` chain - verified against a
 * real curl, and the reason this is not just `-w` on the command line.
 *
 * @param {{ key: string, url: string, method?: string, headers?: object, body?: any, insecure?: boolean }[]} requests
 * @returns {string|null} config text, or null if no request is usable
 */
export function buildCurlConfigBatch(requests = []) {
    const sections = []
    for (const r of requests) {
        if (!r?.url) continue
        const base = buildCurlConfig({ url: r.url, method: r.method, headers: r.headers, body: r.body, insecure: r.insecure })
        if (!base) continue
        // The key is a pubkey (public, non-secret), so embedding it in the marker is safe.
        const marker = `\\n${BATCH_MARKER_PREFIX}${sanitizeMarkerKey(r.key)}:%{http_code}${BATCH_MARKER_SUFFIX}\\n`
        sections.push(`${base.trimEnd()}\nwrite-out = "${marker}"`)
    }
    if (!sections.length) return null
    return sections.join('\n\nnext\n\n') + '\n'
}

/** Keys land inside a curl format string, so keep them to characters that cannot disturb it. */
function sanitizeMarkerKey(key) {
    return String(key ?? '').replace(/[^0-9a-zA-Z_-]/g, '')
}

/**
 * Split a batched sidecar's stdout into `{ [key]: { httpCode, body } }`.
 * Bodies are whatever preceded each marker. A key with no marker never answered at all.
 */
export function parseBatchResponses(stdout) {
    const text = String(stdout ?? '')
    const re = new RegExp(`${BATCH_MARKER_PREFIX}([0-9a-zA-Z_-]*):(\\d+)${BATCH_MARKER_SUFFIX}`, 'g')
    const out = {}
    let lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
        const [, key, code] = m
        out[key] = { httpCode: parseInt(code, 10), body: text.slice(lastIndex, m.index).trim() }
        lastIndex = re.lastIndex
    }
    return out
}

/**
 * Wrap a multi-request shell script in the `sh -c` curl sidecar.
 *
 * ONLY for scripts that carry no secrets - the script lands on the command line, visible in the
 * host process list. Used by the beacon validator-state probe, which loops several requests and
 * sends nothing but public pubkeys. Anything with a token, keystore, or password must go through
 * buildKeymanagerRequest and its stdin config instead.
 */
export function wrapSidecar(script) {
    const escaped = script.replace(/'/g, `'"'"'`)
    return `docker run --rm --network ${STEREUM_DOCKER_NETWORK} --entrypoint sh ${CURL_IMAGE} -c '${escaped}'`
}

/** Host path of a service's volume whose container side is `containerPath`, or undefined. */
function hostVolumePath(config, containerPath) {
    for (const v of (config?.volumes || [])) {
        const [host, container] = String(v).split(':')
        if (container === containerPath && host?.startsWith('/')) return host
    }
    return undefined
}

/**
 * The command that reads a service's bearer token, per stereum's getApiToken: `docker exec`
 * for most clients, a host-side `cat` for Prysm. Returns null for Web3Signer (no token) or
 * when a Prysm wallets volume can't be resolved.
 */
export function buildTokenReadCommand(service) {
    const entry = KEYMANAGER_REGISTRY[service?.config?.service]
    if (!entry || !entry.token) return null
    const t = entry.token
    if (t.mode === 'exec') {
        return `docker exec -u 0 -w ${t.dir} stereum-${service.id} cat ${t.file}`
    }
    if (t.mode === 'host-volume') {
        const host = hostVolumePath(service.config, t.containerPath)
        if (!host) return null
        return `cat ${host.replace(/\/+$/, '')}/${t.file}`
    }
    return null
}

/** Extract the token from the read command's stdout (Prysm: last non-empty line; else trim). */
export function parseToken(serviceType, stdout) {
    const s = String(stdout ?? '')
    const pick = KEYMANAGER_REGISTRY[serviceType]?.token?.pick
    if (pick === 'last') return s.split('\n').filter((l) => l.trim() !== '').pop()?.trim() ?? ''
    return s.trim()
}

/**
 * Everything needed to run one keymanager request: the sidecar command and the config to pipe
 * into its stdin. Callers do `sshService.exec(command, true, { input })`.
 * @returns {{ command: string, input: string }|null}
 */
export function buildKeymanagerRequest({ serviceId, target, method = 'GET', path, token, body }) {
    const url = keymanagerUrl({ serviceId, scheme: target?.scheme, port: target?.port, path })
    if (!url) return null
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const input = buildCurlConfig({ url, method, headers, body, insecure: Boolean(target?.insecure) })
    return { command: buildSidecarStdinCommand(), input }
}

/** Web3Signer lists its keys via its own API and needs no bearer token. */
export function buildWeb3SignerRequest(serviceId, port = KEYMANAGER_REGISTRY.Web3SignerService.port) {
    return buildKeymanagerRequest({
        serviceId,
        target: { scheme: 'http', port, insecure: false },
        method: 'GET',
        path: '/api/v1/eth2/publicKeys',
    })
}

/**
 * Split the sidecar stdout into { httpCode, body } using the trailing `%{http_code}` line.
 * A missing/zero code (curl never connected) yields httpCode 0.
 */
export function parseKeymanagerResponse(stdout) {
    const text = String(stdout ?? '')
    const nl = text.lastIndexOf('\n')
    const codeStr = (nl === -1 ? text : text.slice(nl + 1)).trim()
    const code = parseInt(codeStr.match(/^\d{3}$/)?.[0] ?? '', 10)
    return { httpCode: Number.isFinite(code) ? code : 0, body: nl === -1 ? '' : text.slice(0, nl) }
}

/**
 * Parse GET /eth/v1/keystores -> [{ pubkey, derivationPath, readonly }].
 * Accepts the raw body string or a parsed object; returns [] on anything unexpected.
 */
export function parseKeystoresList(bodyOrJson) {
    let json = bodyOrJson
    if (typeof bodyOrJson === 'string') { try { json = JSON.parse(bodyOrJson) } catch { return [] } }
    const data = json?.data
    if (!Array.isArray(data)) return []
    return data.map((k) => ({
        pubkey: k.validating_pubkey ?? k.pubkey,
        derivationPath: k.derivation_path ?? null,
        readonly: Boolean(k.readonly),
    })).filter((k) => k.pubkey)
}

/**
 * Human-readable error for a non-2xx keymanager response. Clients disagree on the error body
 * (the spec says `{message}`, Lighthouse adds `{code, stacktraces}`), so the message is shown
 * verbatim when present and never branched on - a client's own wording beats anything we invent.
 */
export function keymanagerHttpError({ httpCode, body } = {}, fallback = 'Client API unreachable (is it running?)') {
    if (!httpCode) return fallback
    let message = ''
    try {
        const json = JSON.parse(body)
        if (typeof json?.message === 'string') message = json.message
    } catch { /* not JSON - fall through to the bare status */ }
    return message ? `HTTP ${httpCode}: ${message}` : `Keymanager HTTP ${httpCode}`
}

// ---------------------------------------------------------------------------------------------
// Keystore removal. DELETE carries a body, which is unusual but is what the spec mandates.
// ---------------------------------------------------------------------------------------------

export const KEYSTORES_PATH = '/eth/v1/keystores'

// Spec statuses for a delete. `not_active` means the key was present but not actively signing,
// which still yields protection data and is NOT a failure. `error` means the key was found and
// could NOT be stopped - the one status that must block any follow-on import, because the key
// may still be signing somewhere.
export const DELETE_OK_STATUSES = ['deleted', 'not_active']

/**
 * Parse DELETE /eth/v1/keystores.
 *
 * The response's `data[]` has no pubkey field, so entries correlate to the REQUEST order by
 * index and nothing else. Mismatched lengths are treated as a protocol failure rather than
 * quietly zipping a short array, which would attribute one key's status to another.
 *
 * @param {string} body - raw response body
 * @param {string[]} pubkeys - exactly the pubkeys sent, in order
 */
export function parseDeleteKeystoresResponse(body, pubkeys = []) {
    let json
    try { json = JSON.parse(body) } catch { return { error: 'Unreadable delete response' } }
    const data = json?.data
    if (!Array.isArray(data)) return { error: 'Delete response had no results' }
    if (data.length !== pubkeys.length) {
        return { error: `Client returned ${data.length} results for ${pubkeys.length} keys` }
    }
    const results = pubkeys.map((pubkey, i) => ({
        pubkey,
        status: String(data[i]?.status ?? 'error'),
        message: data[i]?.message ?? '',
    }))
    // The blob is a JSON string per spec. Keep it as the exact string the client produced -
    // reparsing and re-serialising risks mangling the uint64 fields, which are strings on purpose.
    const slashingProtection = typeof json.slashing_protection === 'string' ? json.slashing_protection : null
    return { results, slashingProtection }
}

/** Keys the client could not stop signing. Any of these must block a follow-on import. */
export const deleteErrors = (results = []) => results.filter((r) => r.status === 'error')

/** Keys the client had never heard of, so the protection blob says nothing about them. */
export const deleteNotFound = (results = []) => results.filter((r) => r.status === 'not_found')

/** Does this protection blob actually cover every key we asked to remove? */
export function protectionCoversAll(slashingProtection, pubkeys = []) {
    if (!slashingProtection) return false
    let json
    try { json = JSON.parse(slashingProtection) } catch { return false }
    const covered = new Set((json?.data || []).map((d) => String(d?.pubkey ?? '').toLowerCase()))
    return pubkeys.every((p) => covered.has(String(p).toLowerCase()))
}

// ---------------------------------------------------------------------------------------------
// Per-validator settings: fee recipient and graffiti.
// ---------------------------------------------------------------------------------------------

/**
 * A BLS validator pubkey: 0x + 96 hex. Checked before a pubkey is ever interpolated into a URL
 * path or a curl write-out marker. The values come from the client's own keystore listing, so
 * this is defence in depth rather than a known hole - but a path segment is the wrong place to
 * find out you trusted the wrong string.
 */
export const isValidPubkey = (pubkey) => /^0x[0-9a-fA-F]{96}$/.test(String(pubkey ?? ''))

export const feeRecipientPath = (pubkey) => `/eth/v1/validator/${pubkey}/feerecipient`
export const graffitiPath = (pubkey) => `/eth/v1/validator/${pubkey}/graffiti`

/** The consensus graffiti field is 32 BYTES, not 32 characters - emoji cost 4 each. */
export const GRAFFITI_MAX_BYTES = 32
export const graffitiByteLength = (text) => Buffer.byteLength(String(text ?? ''), 'utf8')
export const isValidGraffiti = (text) => graffitiByteLength(text) <= GRAFFITI_MAX_BYTES

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** A settable fee recipient: 20-byte hex address, and not the burn address (spec rejects it). */
export function isValidFeeRecipient(address) {
    const a = String(address ?? '').trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false
    return a.toLowerCase() !== ZERO_ADDRESS
}

/**
 * Did a keymanager WRITE succeed?
 *
 * The spec says 202 for POST and 204 for DELETE, but Prysm answers 200 for both. Rather than
 * branch per client, accept any 2xx - no client uses a 2xx to mean failure.
 */
export const isWriteSuccess = (httpCode) => httpCode >= 200 && httpCode < 300

/**
 * Did a graffiti/fee-recipient CLEAR succeed? Prysm returns 404 when there was nothing set,
 * which is the requested end state, so it counts as success. This is only safe because we gate
 * the action on a prior successful GET: a 404 from a client that lacks the route entirely never
 * reaches here, because such a service is not offered the action in the first place.
 */
export const isClearSuccess = (httpCode) => isWriteSuccess(httpCode) || httpCode === 404

/**
 * Parse GET feerecipient. Returns `{ value }`, or `{ unset: true }`.
 *
 * Prysm answers 400 "No fee recipient set" instead of 200 when nothing is configured, so that
 * specific code means unset rather than an error. Note the value is the EFFECTIVE one: the spec
 * gives no way to tell a per-key override from the client's process-wide default.
 */
export function parseFeeRecipient(httpCode, body) {
    if (httpCode === 400 || httpCode === 404) return { unset: true }
    if (httpCode !== 200) return { error: keymanagerHttpError({ httpCode, body }) }
    try {
        const address = JSON.parse(body)?.data?.ethaddress
        return typeof address === 'string' ? { value: address } : { unset: true }
    } catch { return { error: 'Unreadable fee recipient response' } }
}

/**
 * Parse GET graffiti. A 404 means this build has no graffiti route (it landed in Lighthouse
 * 4.6 / Teku 23.12 / Nimbus 24.3 / Lodestar 1.12 / Prysm 5.1), which the caller turns into
 * "unsupported" so the UI can hide the action rather than fail it later.
 */
export function parseGraffiti(httpCode, body) {
    if (httpCode === 404) return { unsupported: true }
    if (httpCode !== 200) return { error: keymanagerHttpError({ httpCode, body }) }
    try {
        const graffiti = JSON.parse(body)?.data?.graffiti
        return typeof graffiti === 'string' ? { value: graffiti } : { unset: true }
    } catch { return { error: 'Unreadable graffiti response' } }
}

/** Parse Web3Signer GET /api/v1/eth2/publicKeys -> [{ pubkey, readonly:true }]. */
export function parseWeb3SignerPubkeys(bodyOrJson) {
    let json = bodyOrJson
    if (typeof bodyOrJson === 'string') { try { json = JSON.parse(bodyOrJson) } catch { return [] } }
    if (!Array.isArray(json)) return []
    return json.filter((p) => typeof p === 'string').map((pubkey) => ({ pubkey, readonly: true }))
}
