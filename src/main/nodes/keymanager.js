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

/**
 * The inner `sh -c` curl script that hits the keymanager API and appends the HTTP status on
 * a trailing line (so a non-2xx is distinguishable from a transport failure). Pure - Node
 * wraps it in the `docker run --network stereum --entrypoint sh` sidecar and escapes quotes,
 * exactly like buildClientProbeScript. Returns null if the URL params are unusable.
 */
export function buildKeymanagerScript({ serviceId, scheme = 'http', port, insecure = false, method = 'GET', path, token, body }) {
    if (!serviceId || !port || !path) return null
    const p = path.startsWith('/') ? path : '/' + path
    const url = `${scheme}://stereum-${serviceId}:${port}${p}`
    const parts = [
        'curl -sS',
        insecure ? '--insecure' : '',
        `-X ${String(method).toUpperCase()}`,
        `'${url}'`,
        `-H 'Content-Type: application/json'`,
        token ? `-H 'Authorization: Bearer ${token}'` : '',
        body !== undefined ? `-d '${JSON.stringify(body)}'` : '',
        `-w '\\n%{http_code}'`,
    ]
    return parts.filter(Boolean).join(' ')
}

/** Wrap a keymanager script in the curl sidecar command (matches metrics.fetchClientMetrics). */
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

/** Web3Signer lists its keys via its own API (no bearer token) - build that sidecar script. */
export function buildWeb3SignerScript(serviceId, port = KEYMANAGER_REGISTRY.Web3SignerService.port) {
    return buildKeymanagerScript({ serviceId, scheme: 'http', port, method: 'GET', path: '/api/v1/eth2/publicKeys' })
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

/** Parse Web3Signer GET /api/v1/eth2/publicKeys -> [{ pubkey, readonly:true }]. */
export function parseWeb3SignerPubkeys(bodyOrJson) {
    let json = bodyOrJson
    if (typeof bodyOrJson === 'string') { try { json = JSON.parse(bodyOrJson) } catch { return [] } }
    if (!Array.isArray(json)) return []
    return json.filter((p) => typeof p === 'string').map((pubkey) => ({ pubkey, readonly: true }))
}
