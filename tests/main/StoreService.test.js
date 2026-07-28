import { describe, it, expect, beforeEach, vi } from 'vitest'

const { fakeStore, readFileSync } = vi.hoisted(() => ({
    fakeStore: {
        path: '/tmp/stereum-lite/config.json',
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
        onDidChange: vi.fn(),
    },
    readFileSync: vi.fn(),
}))

vi.mock('electron-store', () => ({
    default: function FakeStore() { return fakeStore },
}))
vi.mock('electron-log', () => ({ default: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('fs', () => ({
    readFileSync: (...args) => readFileSync(...args),
    default: { readFileSync: (...args) => readFileSync(...args) },
}))

import storage from '@main/store/StoreService'

// Wait for the singleton's async init() to settle.
await new Promise(r => setImmediate(r))

describe('StoreService', () => {
    beforeEach(() => {
        fakeStore.get.mockReset()
        fakeStore.set.mockReset()
        fakeStore.delete.mockReset()
        fakeStore.clear.mockReset()
        fakeStore.onDidChange.mockReset()
        readFileSync.mockReset()
    })

    it('get/set/delete/clear delegate to electron-store', async () => {
        fakeStore.get.mockReturnValueOnce('value')
        expect(storage.get('k')).toBe('value')
        expect(fakeStore.get).toHaveBeenCalledWith('k')

        storage.set('k', 'v')
        expect(fakeStore.set).toHaveBeenCalledWith('k', 'v')

        storage.delete('k')
        expect(fakeStore.delete).toHaveBeenCalledWith('k')

        storage.clear()
        expect(fakeStore.clear).toHaveBeenCalled()
    })

    it('onDidChange forwards the callback', async () => {
        const cb = () => {}
        storage.onDidChange('server', cb)
        expect(fakeStore.onDidChange).toHaveBeenCalledWith('server', cb)
    })

    describe('importFromStereum', () => {
        it('maps stereum-launcher config to server entries and persists', async () => {
                readFileSync.mockReturnValueOnce(JSON.stringify({
                'config-v2': { savedConnections: [
                    { name: 'A', host: '1.1.1.1', port: 22, user: 'root', keylocation: '/k' },
                    { name: 'B', host: '2.2.2.2' }, // defaults exercised
                ]}
            }))
            fakeStore.get.mockReturnValueOnce(null).mockReturnValueOnce([
                { name: 'A', host: '1.1.1.1', port: 22, username: 'root', privateKey: '/k' },
                { name: 'B', host: '2.2.2.2', port: 22, username: 'root', privateKey: '' },
            ])
            const result = storage.importFromStereum()
            expect(readFileSync).toHaveBeenCalledWith('/tmp/stereum-launcher/config.json', 'utf8')
            const setCall = fakeStore.set.mock.calls[0]
            expect(setCall[0]).toBe('server')
            expect(setCall[1]).toEqual([
                { name: 'A', host: '1.1.1.1', port: 22, username: 'root', privateKey: '/k' },
                { name: 'B', host: '2.2.2.2', port: 22, username: 'root', privateKey: '' },
            ])
            expect(result).toEqual(setCall[1])
        })

        it('dedupes by name against existing entries', async () => {
                readFileSync.mockReturnValueOnce(JSON.stringify({
                'config-v2': { savedConnections: [
                    { name: 'A', host: '1.1.1.1', user: 'root' },
                    { name: 'NEW', host: '3.3.3.3', user: 'root' },
                ]}
            }))
            fakeStore.get
                .mockReturnValueOnce([{ name: 'A', host: 'orig', port: 22, username: 'root', privateKey: '' }])
                .mockReturnValueOnce([
                    { name: 'A', host: 'orig', port: 22, username: 'root', privateKey: '' },
                    { name: 'NEW', host: '3.3.3.3', port: 22, username: 'root', privateKey: '' },
                ])
            storage.importFromStereum()
            const persisted = fakeStore.set.mock.calls[0][1]
            expect(persisted.find(s => s.name === 'A').host).toBe('orig')
            expect(persisted.find(s => s.name === 'NEW')).toBeTruthy()
            expect(persisted).toHaveLength(2)
        })
    })
})
