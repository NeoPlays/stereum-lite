import { describe, it, expect } from 'vitest'
import {
    KEYMANAGER_REGISTRY,
    keymanagerInfo,
    keymanagerCapable,
    keymanagerTarget,
    keymanagerUrl,
    buildCurlConfig,
    buildSidecarStdinCommand,
    buildKeymanagerRequest,
    wrapSidecar,
    buildTokenReadCommand,
    parseToken,
    buildWeb3SignerRequest,
    keymanagerHttpError,
    buildCurlConfigBatch,
    parseBatchResponses,
    isValidFeeRecipient,
    isValidGraffiti,
    graffitiByteLength,
    isWriteSuccess,
    isClearSuccess,
    parseFeeRecipient,
    parseGraffiti,
    parseKeymanagerResponse,
    parseKeystoresList,
    parseWeb3SignerPubkeys,
    isValidPubkey,
    parseDeleteKeystoresResponse,
    protectionCoversAll,
    deleteErrors,
    deleteNotFound,
} from '@main/nodes/keymanager'

const cfg = (service, command = [], volumes = []) => ({ config: { service, command, volumes } })

describe('KEYMANAGER_REGISTRY', () => {
    it('carries stereum-verified ports for every supported type', () => {
        expect(KEYMANAGER_REGISTRY.LighthouseValidatorService.port).toBe(5062)
        expect(KEYMANAGER_REGISTRY.LodestarValidatorService.port).toBe(5062)
        expect(KEYMANAGER_REGISTRY.PrysmValidatorService.port).toBe(7500)
        expect(KEYMANAGER_REGISTRY.NimbusValidatorService.port).toBe(5052)
        expect(KEYMANAGER_REGISTRY.TekuValidatorService.port).toBe(5052)
        expect(KEYMANAGER_REGISTRY.Web3SignerService.port).toBe(9000)
    })
    it('marks only Teku as https/insecure', () => {
        expect(KEYMANAGER_REGISTRY.TekuValidatorService).toMatchObject({ scheme: 'https', insecure: true })
        for (const t of ['LighthouseValidatorService', 'PrysmValidatorService', 'NimbusValidatorService', 'LodestarValidatorService']) {
            expect(KEYMANAGER_REGISTRY[t]).toMatchObject({ scheme: 'http', insecure: false })
        }
    })
})

describe('keymanagerInfo / keymanagerCapable', () => {
    it('is capable when the enable flag is present in the command', () => {
        expect(keymanagerCapable(cfg('LighthouseValidatorService', ['--http', '--http-port=5062']).config)).toBe(true)
        expect(keymanagerCapable(cfg('TekuValidatorService', ['--validator-api-enabled=true']).config)).toBe(true)
        expect(keymanagerCapable(cfg('LodestarValidatorService', ['--keymanager=true']).config)).toBe(true)
    })
    it('reports api-not-enabled for a known client with the flag missing', () => {
        expect(keymanagerInfo(cfg('LighthouseValidatorService', ['--datadir=/x']).config))
            .toEqual({ capable: false, reason: 'api-not-enabled', web3signer: false })
    })
    it('treats Web3Signer as always capable (no flag / no token)', () => {
        expect(keymanagerInfo(cfg('Web3SignerService', []).config)).toEqual({ capable: true, reason: null, web3signer: true })
    })
    it('is not capable for a non-keymanager type', () => {
        expect(keymanagerInfo(cfg('GethService').config)).toEqual({ capable: false, reason: null, web3signer: false })
    })
})

describe('keymanagerTarget', () => {
    it('returns the registry default port', () => {
        expect(keymanagerTarget(cfg('PrysmValidatorService').config)).toEqual({ port: 7500, scheme: 'http', insecure: false })
    })
    it('honours a port override in the command', () => {
        expect(keymanagerTarget(cfg('LighthouseValidatorService', ['--http-port=6000']).config).port).toBe(6000)
        expect(keymanagerTarget(cfg('NimbusValidatorService', ['--keymanager-port', '6001']).config).port).toBe(6001)
    })
})

describe('keymanagerUrl', () => {
    it('builds a container-name URL and tolerates a missing leading slash', () => {
        expect(keymanagerUrl({ serviceId: 'abc', scheme: 'http', port: 5062, path: '/eth/v1/keystores' }))
            .toBe('http://stereum-abc:5062/eth/v1/keystores')
        expect(keymanagerUrl({ serviceId: 'abc', scheme: 'https', port: 5052, path: 'eth/v1/keystores' }))
            .toBe('https://stereum-abc:5052/eth/v1/keystores')
    })
    it('returns null when required params are missing', () => {
        expect(keymanagerUrl({ serviceId: 'abc', port: 5062 })).toBeNull()
        expect(keymanagerUrl({ port: 5062, path: '/x' })).toBeNull()
    })
})

describe('buildCurlConfig', () => {
    const lines = (cfgText) => cfgText.trim().split('\n')

    it('emits url/request/header/data directives', () => {
        const c = buildCurlConfig({
            url: 'http://stereum-abc:5062/eth/v1/keystores',
            method: 'post',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer TOK' },
            body: { a: 1 },
        })
        expect(lines(c)).toEqual(expect.arrayContaining([
            'url = "http://stereum-abc:5062/eth/v1/keystores"',
            'request = "POST"',
            'header = "Content-Type: application/json"',
            'header = "Authorization: Bearer TOK"',
            'data = "{\\"a\\":1}"',
            'silent',
            'show-error',
        ]))
    })

    it('adds insecure only for https/self-signed targets (Teku)', () => {
        expect(buildCurlConfig({ url: 'https://x/y', insecure: true })).toContain('\ninsecure\n')
        expect(buildCurlConfig({ url: 'http://x/y' })).not.toContain('\ninsecure\n')
    })

    it('omits data entirely when there is no body', () => {
        // A stray `data` would turn a bodyless DELETE into one carrying an empty string.
        expect(buildCurlConfig({ url: 'http://x/y', method: 'DELETE' })).not.toContain('data =')
    })

    it('escapes quotes and backslashes so a hostile value cannot break out', () => {
        const c = buildCurlConfig({ url: 'http://x/y', method: 'POST', body: { graffiti: 'a"b\\c' } })
        const dataLine = lines(c).find((l) => l.startsWith('data ='))
        // Every quote inside the value is escaped, so the line still has exactly two bare quotes.
        expect(dataLine.match(/(?<!\\)"/g)).toHaveLength(2)
        expect(dataLine).toContain('\\\\')
    })

    it("survives an apostrophe, the character that broke the old shell-quoted builder", () => {
        const c = buildCurlConfig({ url: 'http://x/y', method: 'POST', body: { graffiti: "it's mine" } })
        expect(c).toContain("it's mine")
    })

    it('escapes newlines so a value cannot forge a second directive', () => {
        const c = buildCurlConfig({ url: 'http://x/y', method: 'POST', body: 'a\ninsecure\nb' })
        const directives = lines(c).filter((l) => l === 'insecure')
        expect(directives).toHaveLength(0)
        expect(c).toContain('\\n')
    })

    it('returns null without a url', () => {
        expect(buildCurlConfig({ method: 'GET' })).toBeNull()
    })
})

describe('buildSidecarStdinCommand', () => {
    it('runs curl on the stereum network reading its config from stdin', () => {
        const cmd = buildSidecarStdinCommand()
        expect(cmd).toContain('--network stereum')
        expect(cmd).toContain('--entrypoint curl')
        expect(cmd).toContain('-K -')
        expect(cmd).toContain("-w '\\n%{http_code}'")
    })
    it('passes -i so the container stdin stays open for the config', () => {
        expect(buildSidecarStdinCommand()).toMatch(/docker run --rm -i /)
    })
})

describe('buildKeymanagerRequest', () => {
    const target = { scheme: 'http', port: 5062, insecure: false }

    it('returns the sidecar command plus the config to pipe in', () => {
        const r = buildKeymanagerRequest({ serviceId: 'abc', target, method: 'GET', path: '/eth/v1/keystores', token: 'TOK' })
        expect(r.command).toContain('-K -')
        expect(r.input).toContain('url = "http://stereum-abc:5062/eth/v1/keystores"')
        expect(r.input).toContain('header = "Authorization: Bearer TOK"')
    })

    it('keeps the token out of the command line', () => {
        const r = buildKeymanagerRequest({ serviceId: 'abc', target, path: '/eth/v1/keystores', token: 'SUPERSECRET' })
        expect(r.command).not.toContain('SUPERSECRET')
    })

    it('sends Content-Type only when there is a body', () => {
        const withBody = buildKeymanagerRequest({ serviceId: 'a', target, method: 'POST', path: '/p', body: { x: 1 } })
        const noBody = buildKeymanagerRequest({ serviceId: 'a', target, method: 'GET', path: '/p' })
        expect(withBody.input).toContain('Content-Type: application/json')
        expect(noBody.input).not.toContain('Content-Type')
    })

    it('carries insecure through for a Teku target', () => {
        const r = buildKeymanagerRequest({ serviceId: 'a', target: { scheme: 'https', port: 5052, insecure: true }, path: '/p' })
        expect(r.input).toContain('insecure')
    })

    it('returns null when the endpoint cannot be resolved', () => {
        expect(buildKeymanagerRequest({ serviceId: 'a', target, method: 'GET' })).toBeNull()
    })
})

describe('keymanagerHttpError', () => {
    it('surfaces the client message verbatim', () => {
        expect(keymanagerHttpError({ httpCode: 403, body: '{"message":"token invalid"}' }))
            .toBe('HTTP 403: token invalid')
    })
    it('falls back to the bare status for a non-JSON body', () => {
        expect(keymanagerHttpError({ httpCode: 500, body: '<html>oops' })).toBe('Keymanager HTTP 500')
    })
    it('reports unreachable when curl never connected', () => {
        expect(keymanagerHttpError({ httpCode: 0, body: '' })).toContain('unreachable')
    })
})

describe('wrapSidecar', () => {
    it('wraps in the stereum-network curl sidecar and escapes single quotes', () => {
        const cmd = wrapSidecar(`curl -H 'X: y'`)
        expect(cmd).toContain('docker run --rm --network stereum --entrypoint sh')
        expect(cmd).toContain(`'"'"'`) // the ' inside the script got escaped
    })
})

describe('buildTokenReadCommand', () => {
    it('uses docker exec with the right dir/file for exec-mode clients', () => {
        expect(buildTokenReadCommand({ id: 'i', ...cfg('LighthouseValidatorService') }))
            .toBe('docker exec -u 0 -w /opt/app/validator/validators stereum-i cat api-token.txt')
        expect(buildTokenReadCommand({ id: 'i', ...cfg('TekuValidatorService') }))
            .toBe('docker exec -u 0 -w /opt/app/data/validator/key-manager stereum-i cat validator-api-bearer')
    })
    it('reads Prysm from the host side of the wallets volume', () => {
        const svc = { id: 'i', ...cfg('PrysmValidatorService', [], ['/opt/stereum/prysm-i/wallets:/opt/app/data/wallets']) }
        expect(buildTokenReadCommand(svc)).toBe('cat /opt/stereum/prysm-i/wallets/auth-token')
    })
    it('returns null for Prysm when the wallets volume is unresolvable, and for Web3Signer', () => {
        expect(buildTokenReadCommand({ id: 'i', ...cfg('PrysmValidatorService') })).toBeNull()
        expect(buildTokenReadCommand({ id: 'i', ...cfg('Web3SignerService') })).toBeNull()
    })
})

describe('parseToken', () => {
    it('takes the last non-empty line for Prysm', () => {
        expect(parseToken('PrysmValidatorService', 'header line\n\nTHE_TOKEN\n')).toBe('THE_TOKEN')
    })
    it('trims for other clients', () => {
        expect(parseToken('LighthouseValidatorService', '  api-abc123\n')).toBe('api-abc123')
    })
})

describe('parseKeymanagerResponse', () => {
    it('splits body from the trailing http code', () => {
        expect(parseKeymanagerResponse('{"data":[]}\n200')).toEqual({ httpCode: 200, body: '{"data":[]}' })
    })
    it('reports code 0 when nothing/no code was returned', () => {
        expect(parseKeymanagerResponse('')).toEqual({ httpCode: 0, body: '' })
        expect(parseKeymanagerResponse('boom\n000')).toEqual({ httpCode: 0, body: 'boom' })
    })
})

describe('parseKeystoresList', () => {
    it('maps validating_pubkey/derivation_path/readonly', () => {
        const body = JSON.stringify({ data: [
            { validating_pubkey: '0xaa', derivation_path: 'm/12381/3600/0/0/0', readonly: false },
            { validating_pubkey: '0xbb' },
        ] })
        expect(parseKeystoresList(body)).toEqual([
            { pubkey: '0xaa', derivationPath: 'm/12381/3600/0/0/0', readonly: false },
            { pubkey: '0xbb', derivationPath: null, readonly: false },
        ])
    })
    it('returns [] for malformed / non-object bodies', () => {
        expect(parseKeystoresList('not json')).toEqual([])
        expect(parseKeystoresList({ data: 'x' })).toEqual([])
    })
})

describe('parseWeb3SignerPubkeys', () => {
    it('maps the flat pubkey array to readonly entries', () => {
        expect(parseWeb3SignerPubkeys('["0xaa","0xbb"]')).toEqual([
            { pubkey: '0xaa', readonly: true },
            { pubkey: '0xbb', readonly: true },
        ])
    })
    it('returns [] for non-arrays', () => {
        expect(parseWeb3SignerPubkeys('{}')).toEqual([])
    })
})

describe('buildWeb3SignerRequest', () => {
    it('hits the web3signer pubkeys endpoint with no auth', () => {
        const r = buildWeb3SignerRequest('w1')
        expect(r.input).toContain('url = "http://stereum-w1:9000/api/v1/eth2/publicKeys"')
        expect(r.input).not.toContain('Authorization')
    })
})

describe('buildCurlConfigBatch / parseBatchResponses', () => {
    const reqs = [
        { key: '0xaaa', url: 'http://stereum-s:5062/eth/v1/validator/0xaaa/feerecipient', method: 'GET' },
        { key: '0xbbb', url: 'http://stereum-s:5062/eth/v1/validator/0xbbb/feerecipient', method: 'GET' },
    ]

    it('joins requests with the next directive and a per-request write-out', () => {
        const cfg = buildCurlConfigBatch(reqs)
        expect(cfg.match(/\nnext\n/g)).toHaveLength(1)
        // An argv-level -w only applies to the first request in a next chain, so each section
        // must carry its own write-out or later responses arrive unlabelled.
        expect(cfg.match(/write-out = /g)).toHaveLength(2)
    })

    it('labels each response with its key so matching is by identity, not position', () => {
        const cfg = buildCurlConfigBatch(reqs)
        expect(cfg).toContain('KM_RESP:0xaaa:%{http_code}')
        expect(cfg).toContain('KM_RESP:0xbbb:%{http_code}')
    })

    it('parses bodies and codes back out, keyed by request key', () => {
        const stdout = '{"data":{"ethaddress":"0x1"}}\n===KM_RESP:0xaaa:200===\n{"message":"nope"}\n===KM_RESP:0xbbb:403===\n'
        expect(parseBatchResponses(stdout)).toEqual({
            '0xaaa': { httpCode: 200, body: '{"data":{"ethaddress":"0x1"}}' },
            '0xbbb': { httpCode: 403, body: '{"message":"nope"}' },
        })
    })

    it('keeps responses correct even when one request never connected', () => {
        // curl still emits the marker with code 000, so the later key must not shift up.
        const stdout = '\n===KM_RESP:0xaaa:000===\n{"data":{}}\n===KM_RESP:0xbbb:200===\n'
        const out = parseBatchResponses(stdout)
        expect(out['0xaaa'].httpCode).toBe(0)
        expect(out['0xbbb'].httpCode).toBe(200)
    })

    it('skips unusable requests and returns null when none remain', () => {
        expect(buildCurlConfigBatch([{ key: 'a' }])).toBeNull()
        expect(buildCurlConfigBatch([])).toBeNull()
    })
})

describe('fee recipient / graffiti helpers', () => {
    it('accepts a real address and rejects malformed or zero ones', () => {
        expect(isValidFeeRecipient('0x' + 'a'.repeat(40))).toBe(true)
        expect(isValidFeeRecipient('0x' + '0'.repeat(40))).toBe(false) // spec rejects the burn address
        expect(isValidFeeRecipient('0xabc')).toBe(false)
        expect(isValidFeeRecipient(null)).toBe(false)
    })

    it('measures graffiti in bytes, not characters', () => {
        expect(graffitiByteLength('abc')).toBe(3)
        expect(graffitiByteLength('🚀')).toBe(4)          // one char, four bytes
        expect(isValidGraffiti('a'.repeat(32))).toBe(true)
        expect(isValidGraffiti('a'.repeat(33))).toBe(false)
        expect(isValidGraffiti('🚀'.repeat(8))).toBe(true)  // 32 bytes exactly
        expect(isValidGraffiti('🚀'.repeat(9))).toBe(false)
    })

    it('treats any 2xx as a successful write (Prysm answers 200 where the spec says 202/204)', () => {
        expect(isWriteSuccess(202)).toBe(true)
        expect(isWriteSuccess(204)).toBe(true)
        expect(isWriteSuccess(200)).toBe(true)
        expect(isWriteSuccess(403)).toBe(false)
    })

    it('treats 404 on a clear as success, since nothing was set', () => {
        expect(isClearSuccess(404)).toBe(true)
        expect(isClearSuccess(204)).toBe(true)
        expect(isClearSuccess(500)).toBe(false)
    })

    it('reads a fee recipient, and reads Prysm 400 as unset rather than an error', () => {
        expect(parseFeeRecipient(200, '{"data":{"ethaddress":"0xabc"}}')).toEqual({ value: '0xabc' })
        expect(parseFeeRecipient(400, '{"message":"No fee recipient set"}')).toEqual({ unset: true })
        expect(parseFeeRecipient(500, '{"message":"boom"}').error).toContain('500')
    })

    it('reads graffiti, and reads 404 as an unsupported client build', () => {
        expect(parseGraffiti(200, '{"data":{"graffiti":"hi"}}')).toEqual({ value: 'hi' })
        expect(parseGraffiti(404, '')).toEqual({ unsupported: true })
        expect(parseGraffiti(200, 'not json').error).toBeTruthy()
    })
})

describe('parseDeleteKeystoresResponse', () => {
    const PROTECTION = JSON.stringify({ metadata: { interchange_format_version: '5' }, data: [{ pubkey: '0xAAA' }] })

    it('correlates statuses to the requested pubkeys by index', () => {
        const body = JSON.stringify({
            data: [{ status: 'deleted' }, { status: 'not_found' }],
            slashing_protection: PROTECTION,
        })
        const r = parseDeleteKeystoresResponse(body, ['0xaaa', '0xbbb'])
        expect(r.results).toEqual([
            { pubkey: '0xaaa', status: 'deleted', message: '' },
            { pubkey: '0xbbb', status: 'not_found', message: '' },
        ])
    })

    it('rejects a length mismatch instead of misattributing a status to the wrong key', () => {
        const body = JSON.stringify({ data: [{ status: 'deleted' }] })
        const r = parseDeleteKeystoresResponse(body, ['0xaaa', '0xbbb'])
        expect(r.error).toContain('1 results for 2 keys')
        expect(r.results).toBeUndefined()
    })

    it('keeps the protection blob as the exact string the client produced', () => {
        // Reparsing risks mangling uint64 fields, which EIP-3076 keeps as strings on purpose.
        const body = JSON.stringify({ data: [{ status: 'deleted' }], slashing_protection: PROTECTION })
        expect(parseDeleteKeystoresResponse(body, ['0xaaa']).slashingProtection).toBe(PROTECTION)
    })

    it('treats a missing status as an error rather than a success', () => {
        const body = JSON.stringify({ data: [{}] })
        expect(parseDeleteKeystoresResponse(body, ['0xaaa']).results[0].status).toBe('error')
    })

    it('reports unreadable and shapeless responses', () => {
        expect(parseDeleteKeystoresResponse('not json', ['0xa']).error).toBeTruthy()
        expect(parseDeleteKeystoresResponse('{}', ['0xa']).error).toContain('no results')
    })

    it('separates keys that could not be stopped from keys never held', () => {
        const results = [
            { pubkey: '0xa', status: 'error' },
            { pubkey: '0xb', status: 'not_found' },
            { pubkey: '0xc', status: 'not_active' },
        ]
        expect(deleteErrors(results).map((r) => r.pubkey)).toEqual(['0xa'])
        expect(deleteNotFound(results).map((r) => r.pubkey)).toEqual(['0xb'])
    })
})

describe('protectionCoversAll', () => {
    const blob = (pubkeys) => JSON.stringify({ data: pubkeys.map((p) => ({ pubkey: p })) })

    it('is true only when every key appears in the record', () => {
        expect(protectionCoversAll(blob(['0xa', '0xb']), ['0xa', '0xb'])).toBe(true)
        expect(protectionCoversAll(blob(['0xa']), ['0xa', '0xb'])).toBe(false)
    })

    it('compares pubkeys case-insensitively, since EIP-3076 does not fix casing', () => {
        expect(protectionCoversAll(blob(['0xABC']), ['0xabc'])).toBe(true)
    })

    it('is false for a missing or unparseable record', () => {
        expect(protectionCoversAll(null, ['0xa'])).toBe(false)
        expect(protectionCoversAll('not json', ['0xa'])).toBe(false)
    })
})

describe('isValidPubkey', () => {
    it('accepts a 96-hex BLS pubkey in either case', () => {
        expect(isValidPubkey('0x' + 'a'.repeat(96))).toBe(true)
        expect(isValidPubkey('0x' + 'A'.repeat(96))).toBe(true)
    })
    it('rejects anything that could disturb a URL path or a curl marker', () => {
        expect(isValidPubkey('0x' + 'a'.repeat(95))).toBe(false)
        expect(isValidPubkey('0xaaa/../../etc')).toBe(false)
        expect(isValidPubkey('../../secret')).toBe(false)
        expect(isValidPubkey('')).toBe(false)
        expect(isValidPubkey(null)).toBe(false)
    })
})
