import { describe, it, expect } from 'vitest'
import {
    resolveDataDir, isResyncable, isSafeDataDir, updateSyncCommand, supportsCheckpointSync,
    DATA_DIR_CONTAINER_PATHS,
} from '@main/nodes/resync'

const ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'

// A realistic volume list for a given container-side data path.
const vol = (host, container) => `${host}:${container}`

describe('resolveDataDir', () => {
    const cases = [
        ['GethService', '/opt/data/geth'],
        ['ErigonService', '/opt/data/erigon'],
        ['RethService', '/opt/data/reth'],
        ['NethermindService', '/opt/app/data'],
        ['BesuService', '/opt/app/data'],
        ['EthrexService', '/opt/app/data'],
        ['TekuBeaconService', '/opt/app/data'],
        ['GrandineBeaconService', '/opt/app/data'],
        ['LighthouseBeaconService', '/opt/app/beacon'],
        ['PrysmBeaconService', '/opt/app/beacon'],
        ['NimbusBeaconService', '/opt/app/beacon'],
        ['LodestarBeaconService', '/opt/app/beacon'],
    ]
    for (const [service, container] of cases) {
        it(`resolves the host data dir for ${service}`, () => {
            const host = `/opt/stereum/x-${ID}/data`
            const config = { service, volumes: ['/other/jwt:/engine.jwt', vol(host, container)] }
            expect(resolveDataDir(config)).toBe(host)
        })
    }

    it('resolves the Geth legacy /opt/app/geth alias', () => {
        const host = `/opt/stereum/geth-${ID}/data`
        expect(resolveDataDir({ service: 'GethService', volumes: [vol(host, '/opt/app/geth')] })).toBe(host)
    })

    it('returns undefined for an unmapped service type', () => {
        expect(resolveDataDir({ service: 'FlashbotsMevBoostService', volumes: [vol('/x/y/z', '/opt/app/data')] })).toBeUndefined()
    })

    it('returns undefined when no volume matches the wanted container path (devnet Geth)', () => {
        expect(resolveDataDir({ service: 'GethService', volumes: [vol('/opt/stereum/x', '/execution')] })).toBeUndefined()
    })

    it('skips relative / named volumes', () => {
        expect(resolveDataDir({ service: 'GethService', volumes: ['named-vol:/opt/data/geth'] })).toBeUndefined()
    })

    it('handles a missing volumes array', () => {
        expect(resolveDataDir({ service: 'GethService' })).toBeUndefined()
    })
})

describe('isResyncable', () => {
    it('is true for all 12 mapped EL/CL clients that have a matching data volume', () => {
        for (const [service, containers] of Object.entries(DATA_DIR_CONTAINER_PATHS)) {
            expect(isResyncable({ service, volumes: [vol(`/opt/stereum/x-${ID}/data`, containers[0])] })).toBe(true)
        }
    })
    it('is false for a mapped client whose data volume is missing (button must not appear)', () => {
        expect(isResyncable({ service: 'GethService', volumes: [vol('/x/y/z', '/execution')] })).toBe(false)
        expect(isResyncable({ service: 'GethService' })).toBe(false)
    })
    it('is false for External / Op / validator / mevboost / monitoring', () => {
        for (const service of ['ExternalExecutionService', 'ExternalConsensusService', 'OpGethService',
            'OpNodeBeaconService', 'LighthouseValidatorService', 'FlashbotsMevBoostService', 'PrometheusService']) {
            expect(isResyncable({ service })).toBe(false)
        }
    })
})

describe('supportsCheckpointSync', () => {
    it('is true for the 6 consensus clients, false for execution clients', () => {
        for (const s of ['LighthouseBeaconService', 'PrysmBeaconService', 'TekuBeaconService',
            'NimbusBeaconService', 'LodestarBeaconService', 'GrandineBeaconService']) {
            expect(supportsCheckpointSync({ service: s })).toBe(true)
        }
        for (const s of ['GethService', 'NethermindService', 'BesuService', 'ErigonService', 'RethService', 'EthrexService']) {
            expect(supportsCheckpointSync({ service: s })).toBe(false)
        }
    })
})

describe('isSafeDataDir', () => {
    const opts = { serviceId: ID, controlsPath: '/opt/stereum' }
    const good = `/opt/stereum/geth-${ID}/data`

    it('accepts a real stereum data dir', () => {
        expect(isSafeDataDir(good, opts)).toBe(true)
    })
    it('accepts a dir under a custom controls_install_path that embeds the id', () => {
        expect(isSafeDataDir(`/mnt/data/stereum/geth-${ID}/data`, { serviceId: ID, controlsPath: '/mnt/data/stereum' })).toBe(true)
    })

    it('rejects empty / whitespace / non-string', () => {
        expect(isSafeDataDir('', opts)).toBe(false)
        expect(isSafeDataDir('   ', opts)).toBe(false)
        expect(isSafeDataDir(undefined, opts)).toBe(false)
        expect(isSafeDataDir(` ${good} `, opts)).toBe(false) // edge whitespace
    })
    it('rejects the filesystem root and shallow paths', () => {
        expect(isSafeDataDir('/', opts)).toBe(false)
        expect(isSafeDataDir('/opt', opts)).toBe(false)
        expect(isSafeDataDir('/opt/stereum', opts)).toBe(false) // depth 2, also lacks id
    })
    it('rejects system-root paths even if deep and id-bearing', () => {
        expect(isSafeDataDir(`/proc/x/${ID}`, { serviceId: ID, controlsPath: '/' })).toBe(false)
        expect(isSafeDataDir(`/var/lib/${ID}`, { serviceId: ID, controlsPath: '/' })).toBe(false)
    })
    it('rejects traversal and double-slash paths', () => {
        expect(isSafeDataDir(`/opt/stereum/../${ID}/data`, opts)).toBe(false)
        expect(isSafeDataDir(`/opt/stereum//geth-${ID}/data`, opts)).toBe(false)
    })
    it('rejects shell metacharacters and globs', () => {
        for (const bad of [`/opt/stereum/g ${ID}/data`, `/opt/stereum/g;${ID}`, `/opt/stereum/$(${ID})`,
            `/opt/stereum/\`${ID}\``, `/opt/stereum/*${ID}`]) {
            expect(isSafeDataDir(bad, opts)).toBe(false)
        }
    })
    it('rejects a valid-looking dir that lacks the serviceId', () => {
        expect(isSafeDataDir('/opt/stereum/geth-other/data', opts)).toBe(false)
    })
    it('rejects when not anchored to /opt/stereum or the controls path', () => {
        expect(isSafeDataDir(`/random/place/${ID}/data`, opts)).toBe(false)
    })
    it('a hostile controls_install_path of "/" cannot widen the anchor to any absolute path', () => {
        expect(isSafeDataDir('/etc/passwd', { serviceId: ID, controlsPath: '/' })).toBe(false)
        // Even a non-system, deep, but id-less path stays rejected.
        expect(isSafeDataDir('/data/foo/bar', { serviceId: ID, controlsPath: '/' })).toBe(false)
        // Regression: a deep, id-bearing, non-system path must NOT pass just because controlsPath='/'
        // collapses the anchor - it is not under /opt/stereum and '/' is not a real anchor.
        expect(isSafeDataDir(`/home/ethereum/${ID}/chaindata`, { serviceId: ID, controlsPath: '/' })).toBe(false)
    })
    it('rejects bracket-glob characters (root would re-expand them from the /* wipe)', () => {
        expect(isSafeDataDir(`/opt/stereum/geth-${ID}/data[0-9]`, opts)).toBe(false)
    })
    it('requires a serviceId to be provided', () => {
        expect(isSafeDataDir(good, { controlsPath: '/opt/stereum' })).toBe(false)
    })
})

describe('updateSyncCommand', () => {
    it('adds a checkpoint flag for each CL client (url given)', () => {
        const flags = {
            LighthouseBeaconService: '--checkpoint-sync-url=',
            LodestarBeaconService: '--checkpointSyncUrl=',
            PrysmBeaconService: '--checkpoint-sync-url=',
            NimbusBeaconService: '--trusted-node-url=',
            TekuBeaconService: '--initial-state=',
            GrandineBeaconService: '--checkpoint-sync-url=',
        }
        for (const [service, flag] of Object.entries(flags)) {
            const out = updateSyncCommand(['--datadir=/x'], service, 'https://cp.example')
            expect(out).toContain(`${flag}https://cp.example`)
            expect(out).toContain('--datadir=/x')
        }
    })

    it('replaces an existing checkpoint flag rather than duplicating it', () => {
        const out = updateSyncCommand(
            ['--datadir=/x', '--checkpoint-sync-url=https://old'], 'LighthouseBeaconService', 'https://new')
        expect(out.filter((c) => c.startsWith('--checkpoint-sync-url='))).toEqual(['--checkpoint-sync-url=https://new'])
    })

    it('genesis (no url): adds the insecure-genesis flag for Lighthouse and Teku only', () => {
        expect(updateSyncCommand([], 'LighthouseBeaconService', null)).toContain('--allow-insecure-genesis-sync')
        expect(updateSyncCommand([], 'TekuBeaconService', null)).toContain('--ignore-weak-subjectivity-period-enabled')
        // The other four have no genesis flag - just no checkpoint flag.
        for (const s of ['PrysmBeaconService', 'NimbusBeaconService', 'LodestarBeaconService', 'GrandineBeaconService']) {
            expect(updateSyncCommand(['--datadir=/x'], s, null)).toEqual(['--datadir=/x'])
        }
    })

    it('switches checkpoint -> genesis: removes the url, adds the genesis flag', () => {
        const out = updateSyncCommand(
            ['--checkpoint-sync-url=https://old'], 'LighthouseBeaconService', null)
        expect(out).not.toContain('--checkpoint-sync-url=https://old')
        expect(out).toContain('--allow-insecure-genesis-sync')
    })

    it('switches genesis -> checkpoint: removes the genesis flag, adds the url', () => {
        const out = updateSyncCommand(
            ['--allow-insecure-genesis-sync'], 'LighthouseBeaconService', 'https://cp')
        expect(out).not.toContain('--allow-insecure-genesis-sync')
        expect(out).toContain('--checkpoint-sync-url=https://cp')
    })

    it('is idempotent when applied twice', () => {
        const once = updateSyncCommand(['--datadir=/x'], 'PrysmBeaconService', 'https://cp')
        const twice = updateSyncCommand(once, 'PrysmBeaconService', 'https://cp')
        expect(twice).toEqual(once)
    })

    it('handles a non-array command safely', () => {
        expect(updateSyncCommand(undefined, 'LighthouseBeaconService', 'https://cp')).toEqual(['--checkpoint-sync-url=https://cp'])
    })
})
