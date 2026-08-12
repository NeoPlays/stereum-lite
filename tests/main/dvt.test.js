import { describe, it, expect } from 'vitest'
import {
    CHARON_CONTAINER_DIR,
    resolveCharonDataDir,
    buildClusterLockReadCommand,
    parseClusterLock,
} from '@main/nodes/dvt'

const charon = (volumes = []) => ({ service: 'CharonService', volumes })

describe('resolveCharonDataDir', () => {
    it('returns the host side of the /opt/charon volume', () => {
        expect(resolveCharonDataDir(charon(['/opt/stereum/charon-x/data:/opt/charon'])))
            .toBe('/opt/stereum/charon-x/data')
    })
    it('is undefined for a non-Charon service or a missing volume', () => {
        expect(resolveCharonDataDir({ service: 'GethService', volumes: ['/a:/opt/charon'] })).toBeUndefined()
        expect(resolveCharonDataDir(charon(['/a:/opt/other']))).toBeUndefined()
    })
})

describe('buildClusterLockReadCommand', () => {
    it('reads the lockfile under .charon on the host, quoted', () => {
        expect(buildClusterLockReadCommand(charon(['/opt/stereum/charon-x/data:/opt/charon'])))
            .toBe("sudo cat '/opt/stereum/charon-x/data/.charon/cluster-lock.json'")
    })
    it('is null when the Charon data dir is unresolvable', () => {
        expect(buildClusterLockReadCommand(charon([]))).toBeNull()
    })
    it('uses the shared container path constant', () => {
        expect(CHARON_CONTAINER_DIR).toBe('/opt/charon')
    })
})

describe('parseClusterLock', () => {
    it('extracts distributed_public_key from every distributed validator', () => {
        const lock = JSON.stringify({
            distributed_validators: [
                { distributed_public_key: '0xaa', public_shares: ['0xshare1'] },
                { distributed_public_key: '0xbb' },
            ],
        })
        expect(parseClusterLock(lock)).toEqual([
            { pubkey: '0xaa', readonly: false },
            { pubkey: '0xbb', readonly: false },
        ])
    })
    it('returns [] for malformed json or a missing array', () => {
        expect(parseClusterLock('not json')).toEqual([])
        expect(parseClusterLock('{}')).toEqual([])
        expect(parseClusterLock(JSON.stringify({ distributed_validators: 'x' }))).toEqual([])
    })
})
