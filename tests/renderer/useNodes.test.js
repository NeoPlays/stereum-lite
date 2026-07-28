import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useNodesStore } from '@stores/useNodes'

describe('useNodesStore', () => {
    let invoke, on, listeners
    beforeEach(() => {
        setActivePinia(createPinia())
        invoke = vi.fn()
        listeners = {}
        on = vi.fn((channel, listener) => {
            listeners[channel] = listener
            return () => { delete listeners[channel] }
        })
        globalThis.window = { api: { invoke, on } }
    })

    it('refreshNodes populates state.nodes from get-all-nodes', async () => {
        invoke.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
        const s = useNodesStore()
        await s.refreshNodes()
        expect(invoke).toHaveBeenCalledWith('get-all-nodes')
        expect(s.nodes).toEqual([{ id: 'a' }, { id: 'b' }])
    })

    it('refreshNodes swallows errors (logs only, no throw)', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        invoke.mockRejectedValueOnce(new Error('boom'))
        const s = useNodesStore()
        await expect(s.refreshNodes()).resolves.toBeUndefined()
        expect(s.nodes).toEqual([])
        errSpy.mockRestore()
    })

    it('getNode caches result; second call does not hit IPC', async () => {
        invoke.mockResolvedValueOnce({ id: 'a', name: 'n' })
        const s = useNodesStore()
        const first = await s.getNode('a')
        const second = await s.getNode('a')
        expect(first).toEqual({ id: 'a', name: 'n' })
        expect(second).toEqual({ id: 'a', name: 'n' })
        expect(invoke).toHaveBeenCalledTimes(1)
    })

    it('refreshNode always fetches even when cached', async () => {
        invoke.mockResolvedValueOnce({ id: 'a', v: 1 }).mockResolvedValueOnce({ id: 'a', v: 2 })
        const s = useNodesStore()
        await s.getNode('a')
        const fresh = await s.refreshNode('a')
        expect(invoke).toHaveBeenCalledTimes(2)
        expect(fresh.v).toBe(2)
        expect(s.nodeCache['a'].v).toBe(2)
    })

    it('getNode returns null on error and does not cache', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        invoke.mockRejectedValueOnce(new Error('nope'))
        const s = useNodesStore()
        const res = await s.getNode('a')
        expect(res).toBeNull()
        expect(s.nodeCache['a']).toBeUndefined()
        errSpy.mockRestore()
    })

    it('disconnectNode removes from cache + node list', async () => {
        invoke.mockResolvedValue(undefined)
        const s = useNodesStore()
        s.nodes = [{ id: 'a' }, { id: 'b' }]
        s.nodeCache = { a: { id: 'a' }, b: { id: 'b' } }
        await s.disconnectNode('a')
        expect(s.nodes).toEqual([{ id: 'b' }])
        expect(s.nodeCache).toEqual({ b: { id: 'b' } })
        expect(invoke).toHaveBeenCalledWith('disconnect-node', 'a')
    })

    describe('isDisconnected', () => {
        it('returns true when the node status is "disconnected"', () => {
            const s = useNodesStore()
            s.nodes = [{ id: 'a', status: 'disconnected' }]
            expect(s.isDisconnected('a')).toBe(true)
        })
        it('returns false when the node is connected or reconnecting', () => {
            const s = useNodesStore()
            s.nodes = [{ id: 'a', status: 'connected' }, { id: 'b', status: 'reconnecting' }]
            expect(s.isDisconnected('a')).toBe(false)
            expect(s.isDisconnected('b')).toBe(false)
        })
        it('returns false when the node is not in the list', () => {
            const s = useNodesStore()
            expect(s.isDisconnected('missing')).toBe(false)
        })
    })

    describe('reconnectNode', () => {
        it('invokes the reconnect-node IPC and returns the result', async () => {
            invoke.mockResolvedValueOnce(true)
            const s = useNodesStore()
            const r = await s.reconnectNode('a')
            expect(invoke).toHaveBeenCalledWith('reconnect-node', 'a')
            expect(r).toBe(true)
        })
        it('returns false on error', async () => {
            const err = vi.spyOn(console, 'error').mockImplementation(() => {})
            invoke.mockRejectedValueOnce(new Error('bad'))
            const s = useNodesStore()
            const r = await s.reconnectNode('a')
            expect(r).toBe(false)
            err.mockRestore()
        })
    })

    describe('lazy reconnect in _fetchNode', () => {
        it('attempts reconnect before giving up when the node is disconnected', async () => {
            const s = useNodesStore()
            s.nodes = [{ id: 'a', status: 'disconnected' }]
            invoke
                .mockResolvedValueOnce(true) // reconnect-node
                .mockResolvedValueOnce({ id: 'a', name: 'n' }) // get-node
            const r = await s.refreshNode('a')
            expect(invoke.mock.calls[0]).toEqual(['reconnect-node', 'a'])
            expect(invoke.mock.calls[1]).toEqual(['get-node', 'a'])
            expect(r).toEqual({ id: 'a', name: 'n' })
        })

        it('returns null when reconnect fails and never calls get-node', async () => {
            const s = useNodesStore()
            s.nodes = [{ id: 'a', status: 'disconnected' }]
            invoke.mockResolvedValueOnce(false) // reconnect-node fails
            const r = await s.refreshNode('a')
            expect(r).toBeNull()
            expect(invoke).toHaveBeenCalledTimes(1)
        })

        it('skips the reconnect attempt when the node is connected', async () => {
            const s = useNodesStore()
            s.nodes = [{ id: 'a', status: 'connected' }]
            invoke.mockResolvedValueOnce({ id: 'a' })
            await s.refreshNode('a')
            expect(invoke).toHaveBeenCalledTimes(1)
            expect(invoke.mock.calls[0]).toEqual(['get-node', 'a'])
        })
    })

    describe('node-status-changed subscription', () => {
        it('subscribes once on refreshNodes via window.api.on', async () => {
            invoke.mockResolvedValue([])
            const s = useNodesStore()
            await s.refreshNodes()
            await s.refreshNodes()
            expect(on).toHaveBeenCalledTimes(1)
            expect(on).toHaveBeenCalledWith('node-status-changed', expect.any(Function))
        })

        it('updates nodes[].status and connected flag when an event arrives', async () => {
            invoke.mockResolvedValueOnce([{ id: 'a', status: 'connected', connected: true }])
            const s = useNodesStore()
            await s.refreshNodes()
            listeners['node-status-changed']({ id: 'a', status: 'reconnecting' })
            expect(s.nodes[0].status).toBe('reconnecting')
            expect(s.nodes[0].connected).toBe(false)
            listeners['node-status-changed']({ id: 'a', status: 'connected' })
            expect(s.nodes[0].connected).toBe(true)
        })

        it('purges nodeCache[id] on disconnect so the next read goes back through IPC', async () => {
            invoke.mockResolvedValueOnce([{ id: 'a', status: 'connected', connected: true }])
            const s = useNodesStore()
            await s.refreshNodes()
            s.nodeCache.a = { id: 'a', stale: true }
            listeners['node-status-changed']({ id: 'a', status: 'disconnected' })
            expect(s.nodeCache.a).toBeUndefined()
        })
    })
})
