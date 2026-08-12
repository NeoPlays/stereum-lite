import { describe, it, expect } from 'vitest'
import {
    KEYMANAGER_REGISTRY,
    keymanagerInfo,
    keymanagerCapable,
    keymanagerTarget,
    buildKeymanagerScript,
    wrapSidecar,
    buildTokenReadCommand,
    parseToken,
    buildWeb3SignerScript,
    parseKeymanagerResponse,
    parseKeystoresList,
    parseWeb3SignerPubkeys,
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

describe('buildKeymanagerScript', () => {
    it('builds an authed GET with the status marker', () => {
        const s = buildKeymanagerScript({ serviceId: 'abc', scheme: 'http', port: 5062, method: 'GET', path: '/eth/v1/keystores', token: 'TOK' })
        expect(s).toContain(`'http://stereum-abc:5062/eth/v1/keystores'`)
        expect(s).toContain(`-H 'Authorization: Bearer TOK'`)
        expect(s).toContain(`-w '\\n%{http_code}'`)
        expect(s).not.toContain('--insecure')
    })
    it('adds --insecure for https (Teku) and a JSON body for writes', () => {
        const s = buildKeymanagerScript({ serviceId: 'abc', scheme: 'https', insecure: true, port: 5052, method: 'POST', path: '/eth/v1/keystores', token: 'T', body: { a: 1 } })
        expect(s).toContain('--insecure')
        expect(s).toContain(`-X POST`)
        expect(s).toContain(`-d '{"a":1}'`)
    })
    it('omits the auth header when there is no token (Web3Signer)', () => {
        const s = buildKeymanagerScript({ serviceId: 'abc', port: 9000, path: '/api/v1/eth2/publicKeys' })
        expect(s).not.toContain('Authorization')
    })
    it('returns null when required params are missing', () => {
        expect(buildKeymanagerScript({ serviceId: 'abc', port: 5062 })).toBeNull()
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

describe('buildWeb3SignerScript', () => {
    it('hits the web3signer pubkeys endpoint with no auth', () => {
        const s = buildWeb3SignerScript('w1')
        expect(s).toContain(`'http://stereum-w1:9000/api/v1/eth2/publicKeys'`)
        expect(s).not.toContain('Authorization')
    })
})
