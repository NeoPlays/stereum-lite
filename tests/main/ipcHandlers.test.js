import { describe, it, expect, beforeEach, vi } from 'vitest'

const { handlers, fakeStorage, fakeNode, fakeNodeManager, fakeTaskManager, fakeWindow, fakeBrowserWindow, fakeNet, manifestState } = vi.hoisted(() => {
    const send = vi.fn()
    const fakeWindow = { webContents: { send } }
    // manifestState lets tests control the next fake HTTP response without re-mocking
    const manifestState = { body: '{}', statusCode: 200, error: null, calls: 0 }
    const fakeNet = {
        request: vi.fn((url) => {
            manifestState.calls++
            manifestState.lastUrl = url
            const reqHandlers = {}
            return {
                on(event, cb) { reqHandlers[event] = cb },
                end() {
                    Promise.resolve().then(() => {
                        if (manifestState.error) {
                            reqHandlers.error?.(manifestState.error)
                            return
                        }
                        const resHandlers = {}
                        const res = {
                            statusCode: manifestState.statusCode,
                            on(event, cb) { resHandlers[event] = cb },
                        }
                        reqHandlers.response?.(res)
                        Promise.resolve().then(() => {
                            resHandlers.data?.(Buffer.from(manifestState.body))
                            resHandlers.end?.()
                        })
                    })
                },
            }
        }),
    }
    return {
        handlers: {},
        fakeStorage: {
            importFromStereum: vi.fn(() => ['server-list']),
            get: vi.fn(),
            set: vi.fn(),
        },
        fakeNode: {
            id: 'node-id',
            sshService: { connect: vi.fn() },
            onStatusChange: vi.fn(),
            reconnect: vi.fn(),
            startService: vi.fn(),
            stopService: vi.fn(),
            restartService: vi.fn(),
            resyncService: vi.fn(),
            fetchContainerStatuses: vi.fn(),
            fetchSystemMetrics: vi.fn(),
            fetchClientMetrics: vi.fn(),
            fetchDiskBreakdown: vi.fn(),
            fetchRawServiceConfig: vi.fn(),
            writeServiceConfig: vi.fn(),
            fetchControlsCommit: vi.fn(),
            fetchOsInfo: vi.fn(),
            fetchUpgradablePackages: vi.fn(),
            updateOS: vi.fn(),
            updatePackage: vi.fn(),
            updateServices: vi.fn(),
            updateStereum: vi.fn(),
            restartChangedServices: vi.fn(),
            runFullUpdate: vi.fn(),
            streamServiceLogs: vi.fn(),
        },
        fakeNodeManager: {
            addNode: vi.fn(),
            getAllNodes: vi.fn(),
            getNode: vi.fn(),
            findNode: vi.fn(),
            findNodeByEndpoint: vi.fn(),
            disconnectNode: vi.fn(),
        },
        // Fire-and-forget: run(label, fn) invokes fn and returns a task id synchronously.
        fakeTaskManager: {
            onUpdate: vi.fn(),
            run: vi.fn((label, fn) => { fn(); return 'task-123' }),
            list: vi.fn(() => [{ id: 't1', label: 'x', status: 'succeeded' }]),
        },
        fakeWindow,
        fakeBrowserWindow: { getAllWindows: vi.fn(() => [fakeWindow]) },
        fakeNet,
        manifestState,
    }
})

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn((channel, fn) => { handlers[channel] = fn }),
    },
    BrowserWindow: fakeBrowserWindow,
    net: fakeNet,
}))
vi.mock('@main/store/StoreService', () => ({ default: fakeStorage }))
vi.mock('@main/nodes/Node', () => ({ Node: function FakeNodeCtor() { return fakeNode } }))
vi.mock('@main/nodes/NodeManager', () => ({ default: fakeNodeManager }))
vi.mock('@main/tasks/TaskManager', () => ({ default: fakeTaskManager }))

vi.mock('electron-log', () => ({ default: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { initializeIpcHandlers } from '@main/ipcHandlers'

const event = {} // first arg passed to handlers by electron

describe('ipcHandlers', () => {
    beforeEach(() => {
        for (const k of Object.keys(handlers)) delete handlers[k]
        vi.clearAllMocks()
        initializeIpcHandlers()
    })

    it('registers all expected channels', () => {
        expect(Object.keys(handlers).sort()).toEqual([
            'disconnect-node',
            'fetch-updates-manifest',
            'get-all-nodes',
            'get-client-metrics',
            'get-container-statuses',
            'get-controls-commit',
            'get-disk-usage',
            'get-node',
            'get-os-info',
            'get-raw-service-config',
            'get-system-metrics',
            'get-tasks',
            'get-upgradable-packages',
            'import-server-from-stereum',
            'ping',
            'reconnect-node',
            'run-node-task',
            'service-logs-start',
            'service-logs-stop',
            'ssh-login',
            'store-get',
            'store-set',
            'write-service-config',
        ])
    })

    it('store-get/store-set forward to storage', async () => {
        fakeStorage.get.mockReturnValueOnce('value')
        expect(await handlers['store-get'](event, 'k')).toBe('value')
        expect(fakeStorage.get).toHaveBeenCalledWith('k')

        await handlers['store-set'](event, 'k', 'v')
        expect(fakeStorage.set).toHaveBeenCalledWith('k', 'v')
    })

    it('import-server-from-stereum returns storage result', async () => {
        const r = await handlers['import-server-from-stereum'](event)
        expect(r).toEqual(['server-list'])
    })

    it('ssh-login connects and adds node on success', async () => {
        fakeNodeManager.findNodeByEndpoint.mockReturnValueOnce(null)
        fakeNode.sshService.connect.mockResolvedValueOnce({ code: 0, message: 'ok' })
        const r = await handlers['ssh-login'](event, { host: 'h', port: 22, username: 'u' })
        expect(r).toEqual({ code: 0, message: 'ok' })
        expect(fakeNodeManager.addNode).toHaveBeenCalledWith(fakeNode)
    })

    it('ssh-login returns code 1 and does not add node on failure', async () => {
        fakeNodeManager.findNodeByEndpoint.mockReturnValueOnce(null)
        fakeNode.sshService.connect.mockRejectedValueOnce(new Error('refused'))
        const r = await handlers['ssh-login'](event, { host: 'h', port: 22, username: 'u' })
        expect(r.code).toBe(1)
        expect(r.message).toBe('refused')
        expect(fakeNodeManager.addNode).not.toHaveBeenCalled()
    })

    it('ssh-login returns code 2 and does not create a new node when endpoint is already connected', async () => {
        fakeNodeManager.findNodeByEndpoint.mockReturnValueOnce({ id: 'existing' })
        const r = await handlers['ssh-login'](event, { host: '1.1.1.1', port: 22, username: 'root' })
        expect(r.code).toBe(2)
        expect(r.nodeId).toBe('existing')
        expect(r.message).toMatch(/already connected/i)
        expect(fakeNode.sshService.connect).not.toHaveBeenCalled()
        expect(fakeNodeManager.addNode).not.toHaveBeenCalled()
    })

    it('ssh-login subscribes onStatusChange and broadcasts node-status-changed to all windows', async () => {
        fakeNodeManager.findNodeByEndpoint.mockReturnValueOnce(null)
        fakeNode.sshService.connect.mockResolvedValueOnce({ code: 0 })
        await handlers['ssh-login'](event, { host: 'h', port: 22, username: 'u' })
        expect(fakeNode.onStatusChange).toHaveBeenCalledTimes(1)
        // Invoke the registered callback as if SSHService emitted a state change
        const cb = fakeNode.onStatusChange.mock.calls[0][0]
        cb('reconnecting')
        expect(fakeBrowserWindow.getAllWindows).toHaveBeenCalled()
        expect(fakeWindow.webContents.send).toHaveBeenCalledWith('node-status-changed', { id: fakeNode.id, status: 'reconnecting' })
    })

    it('reconnect-node delegates to node.reconnect() and returns its result', async () => {
        fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
        fakeNode.reconnect.mockResolvedValueOnce(true)
        const r = await handlers['reconnect-node'](event, 'node-id')
        expect(r).toBe(true)
        expect(fakeNode.reconnect).toHaveBeenCalledTimes(1)
    })

    it('reconnect-node returns false when node missing', async () => {
        fakeNodeManager.findNode.mockReturnValueOnce(null)
        const r = await handlers['reconnect-node'](event, 'missing')
        expect(r).toBe(false)
    })

    it('reconnect-node returns false when reconnect throws', async () => {
        fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
        fakeNode.reconnect.mockRejectedValueOnce(new Error('boom'))
        const r = await handlers['reconnect-node'](event, 'node-id')
        expect(r).toBe(false)
    })

    it('get-all-nodes delegates to nodeManager', async () => {
        fakeNodeManager.getAllNodes.mockReturnValueOnce([{ id: 'a' }])
        expect(await handlers['get-all-nodes'](event)).toEqual([{ id: 'a' }])
    })

    it('get-node delegates and propagates errors', async () => {
        fakeNodeManager.getNode.mockResolvedValueOnce({ id: 'a' })
        expect(await handlers['get-node'](event, 'a')).toEqual({ id: 'a' })

        fakeNodeManager.getNode.mockRejectedValueOnce(new Error('bad'))
        await expect(handlers['get-node'](event, 'a')).rejects.toThrow('bad')
    })

    it('disconnect-node delegates and swallows errors', async () => {
        await handlers['disconnect-node'](event, 'a')
        expect(fakeNodeManager.disconnectNode).toHaveBeenCalledWith('a')

        fakeNodeManager.disconnectNode.mockImplementationOnce(() => { throw new Error('x') })
        await expect(handlers['disconnect-node'](event, 'a')).resolves.toBeUndefined()
    })

    describe('run-node-task (generic async dispatch)', () => {
        // action -> [node method, args sent from renderer, expected method args]
        const cases = [
            ['start-service', 'startService', ['s'], ['s']],
            ['stop-service', 'stopService', ['s'], ['s']],
            ['restart-service', 'restartService', ['s'], ['s']],
            ['resync-service', 'resyncService', ['s', 'https://cp'], ['s', 'https://cp']],
            ['restart-changed-services', 'restartChangedServices', [120, true], [120, { prune: true }]],
            ['update-os', 'updateOS', [], []],
            ['update-package', 'updatePackage', ['curl'], ['curl']],
            ['update-services', 'updateServices', [['s1', 's2']], [['s1', 's2']]],
            ['update-stereum', 'updateStereum', [null], [null]],
            ['run-full-update', 'runFullUpdate', [null, true], [null, { prune: true }]],
        ]
        for (const [action, method, args, expected] of cases) {
            it(`dispatches "${action}" to node.${method} through the task manager`, () => {
                fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
                const r = handlers['run-node-task'](event, 'n', action, args)
                expect(fakeTaskManager.run).toHaveBeenCalledWith(expect.any(String), expect.any(Function), { nodeId: 'n' })
                expect(fakeNode[method]).toHaveBeenCalledWith(...expected)
                expect(r).toEqual({ taskId: 'task-123' })
            })
        }

        it('defaults resyncService url to null when only the id is sent', () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            handlers['run-node-task'](event, 'n', 'resync-service', ['s'])
            expect(fakeNode.resyncService).toHaveBeenCalledWith('s', null)
        })

        it('defaults updateServices to null when no ids are sent', () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            handlers['run-node-task'](event, 'n', 'update-services', [])
            expect(fakeNode.updateServices).toHaveBeenCalledWith(null)
        })

        it('throws when the node is missing', () => {
            fakeNodeManager.findNode.mockReturnValueOnce(null)
            expect(() => handlers['run-node-task'](event, 'n', 'update-os', [])).toThrow('Node not found')
        })

        it('throws on an unknown action', () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            expect(() => handlers['run-node-task'](event, 'n', 'rm-rf', [])).toThrow(/Unknown task action/)
        })
    })

    it('get-container-statuses delegates / errors when missing', async () => {
        fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
        fakeNode.fetchContainerStatuses.mockResolvedValueOnce({ a: { state: 'running' } })
        expect(await handlers['get-container-statuses'](event, 'n')).toEqual({ a: { state: 'running' } })

        fakeNodeManager.findNode.mockReturnValueOnce(null)
        await expect(handlers['get-container-statuses'](event, 'n')).rejects.toThrow('Node not found')
    })

    it('get-raw-service-config delegates / errors when missing', async () => {
        fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
        fakeNode.fetchRawServiceConfig.mockResolvedValueOnce('yaml')
        expect(await handlers['get-raw-service-config'](event, 'n', 's')).toBe('yaml')

        fakeNodeManager.findNode.mockReturnValueOnce(null)
        await expect(handlers['get-raw-service-config'](event, 'n', 's')).rejects.toThrow('Node not found')
    })

    it('write-service-config delegates / errors when missing', async () => {
        fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
        await handlers['write-service-config'](event, 'n', 's', 'content')
        expect(fakeNode.writeServiceConfig).toHaveBeenCalledWith('s', 'content')

        fakeNodeManager.findNode.mockReturnValueOnce(null)
        await expect(handlers['write-service-config'](event, 'n', 's', 'c')).rejects.toThrow('Node not found')
    })

    describe('get-controls-commit / get-upgradable-packages', () => {
        it('get-controls-commit delegates and propagates errors', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchControlsCommit.mockResolvedValueOnce('deadbeef')
            expect(await handlers['get-controls-commit'](event, 'n')).toBe('deadbeef')

            fakeNodeManager.findNode.mockReturnValueOnce(null)
            await expect(handlers['get-controls-commit'](event, 'n')).rejects.toThrow('Node not found')
        })

        it('get-os-info delegates and propagates errors', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchOsInfo.mockResolvedValueOnce('Ubuntu 22.04.3 LTS')
            expect(await handlers['get-os-info'](event, 'n')).toBe('Ubuntu 22.04.3 LTS')

            fakeNodeManager.findNode.mockReturnValueOnce(null)
            await expect(handlers['get-os-info'](event, 'n')).rejects.toThrow('Node not found')
        })

        it('get-upgradable-packages delegates and propagates errors', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchUpgradablePackages.mockResolvedValueOnce([{ name: 'curl' }])
            expect(await handlers['get-upgradable-packages'](event, 'n')).toEqual([{ name: 'curl' }])

            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchUpgradablePackages.mockRejectedValueOnce(new Error('dpkg lock'))
            await expect(handlers['get-upgradable-packages'](event, 'n')).rejects.toThrow('dpkg lock')
        })

        it('get-system-metrics delegates and propagates errors', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchSystemMetrics.mockResolvedValueOnce({ cpu: { usagePct: 12 } })
            expect(await handlers['get-system-metrics'](event, 'n')).toEqual({ cpu: { usagePct: 12 } })

            fakeNodeManager.findNode.mockReturnValueOnce(null)
            await expect(handlers['get-system-metrics'](event, 'n')).rejects.toThrow('Node not found')
        })

        it('get-client-metrics delegates and propagates errors', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchClientMetrics.mockResolvedValueOnce({ 'svc-1': { role: 'execution', peers: 40 } })
            expect(await handlers['get-client-metrics'](event, 'n')).toEqual({ 'svc-1': { role: 'execution', peers: 40 } })

            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchClientMetrics.mockRejectedValueOnce(new Error('docker fail'))
            await expect(handlers['get-client-metrics'](event, 'n')).rejects.toThrow('docker fail')
        })

        it('get-disk-usage delegates and propagates errors', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            fakeNode.fetchDiskBreakdown.mockResolvedValueOnce({ totalBytes: 1000, services: [] })
            expect(await handlers['get-disk-usage'](event, 'n')).toEqual({ totalBytes: 1000, services: [] })

            fakeNodeManager.findNode.mockReturnValueOnce(null)
            await expect(handlers['get-disk-usage'](event, 'n')).rejects.toThrow('Node not found')
        })
    })

    describe('service log streaming', () => {
        it('service-logs-start returns a sessionId and broadcasts log data lines to all windows', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            // Capture the streamServiceLogs opts so we can synthesize log lines
            let capturedOpts
            const abort = vi.fn()
            fakeNode.streamServiceLogs.mockImplementationOnce(async (serviceId, opts) => {
                capturedOpts = opts
                return { abort }
            })

            const sessionId = await handlers['service-logs-start'](event, 'node-id', 'svc-1', 100)
            expect(typeof sessionId).toBe('string')
            expect(fakeNode.streamServiceLogs).toHaveBeenCalledWith('svc-1', expect.objectContaining({ tail: 100 }))

            // Emit a line - should broadcast to every BrowserWindow
            capturedOpts.onLine('hello')
            expect(fakeWindow.webContents.send).toHaveBeenCalledWith('service-log-data', { sessionId, line: 'hello' })
        })

        it('service-logs-start throws when the node is missing', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(null)
            await expect(handlers['service-logs-start'](event, 'missing', 'svc', 50)).rejects.toThrow('Node not found')
        })

        it('service-logs-stop aborts the in-flight stream', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            const abort = vi.fn()
            fakeNode.streamServiceLogs.mockResolvedValueOnce({ abort })
            const sessionId = await handlers['service-logs-start'](event, 'node-id', 'svc', 50)
            await handlers['service-logs-stop'](event, sessionId)
            expect(abort).toHaveBeenCalledTimes(1)
        })

        it('service-logs-stop is a no-op for unknown sessions', () => {
            expect(() => handlers['service-logs-stop'](event, 'no-such-session')).not.toThrow()
        })

        it('onClose broadcasts service-log-closed and removes the session (subsequent stop is a no-op)', async () => {
            fakeNodeManager.findNode.mockReturnValueOnce(fakeNode)
            let capturedOpts
            const abort = vi.fn()
            fakeNode.streamServiceLogs.mockImplementationOnce(async (_, opts) => { capturedOpts = opts; return { abort } })
            const sessionId = await handlers['service-logs-start'](event, 'node-id', 'svc', 50)

            capturedOpts.onClose({ rc: 0 })
            expect(fakeWindow.webContents.send).toHaveBeenCalledWith('service-log-closed', { sessionId, rc: 0, error: undefined })

            await handlers['service-logs-stop'](event, sessionId)
            expect(abort).not.toHaveBeenCalled()
        })

        it('disconnecting a node aborts every active log session belonging to it', async () => {
            fakeNodeManager.findNode.mockReturnValue(fakeNode)
            const abortA = vi.fn(), abortB = vi.fn()
            fakeNode.streamServiceLogs
                .mockResolvedValueOnce({ abort: abortA })
                .mockResolvedValueOnce({ abort: abortB })

            await handlers['service-logs-start'](event, 'node-id', 'svc-a', 50)
            await handlers['service-logs-start'](event, 'node-id', 'svc-b', 50)

            await handlers['disconnect-node'](event, 'node-id')
            expect(abortA).toHaveBeenCalledTimes(1)
            expect(abortB).toHaveBeenCalledTimes(1)
            expect(fakeNodeManager.disconnectNode).toHaveBeenCalledWith('node-id')
        })

        it('disconnecting one node leaves another node\'s sessions intact', async () => {
            fakeNodeManager.findNode.mockReturnValue(fakeNode)
            const abortKeep = vi.fn(), abortKill = vi.fn()
            fakeNode.streamServiceLogs
                .mockResolvedValueOnce({ abort: abortKeep })
                .mockResolvedValueOnce({ abort: abortKill })
            await handlers['service-logs-start'](event, 'keep-node', 'svc', 50)
            await handlers['service-logs-start'](event, 'kill-node', 'svc', 50)

            await handlers['disconnect-node'](event, 'kill-node')
            expect(abortKill).toHaveBeenCalledTimes(1)
            expect(abortKeep).not.toHaveBeenCalled()
        })
    })

    describe('fetch-updates-manifest', () => {
        beforeEach(async () => {
            // Reset the module-level cache between manifest tests by re-importing fresh.
            vi.resetModules()
            for (const k of Object.keys(handlers)) delete handlers[k]
            const fresh = await import('@main/ipcHandlers')
            fresh.initializeIpcHandlers()
            manifestState.calls = 0
            manifestState.error = null
            manifestState.statusCode = 200
            manifestState.body = '{}'
        })

        it('fetches the manifest URL via electron.net and returns parsed JSON', async () => {
            manifestState.body = JSON.stringify({ stereum: [{ name: '2.4.6', commit: 'abc' }] })
            const r = await handlers['fetch-updates-manifest'](event)
            expect(r).toEqual({ stereum: [{ name: '2.4.6', commit: 'abc' }] })
            expect(manifestState.lastUrl).toBe('https://stereum.com/downloads/updates.json')
        })

        it('caches the response - subsequent calls do not hit the network', async () => {
            manifestState.body = JSON.stringify({ ok: true })
            await handlers['fetch-updates-manifest'](event)
            await handlers['fetch-updates-manifest'](event)
            await handlers['fetch-updates-manifest'](event)
            expect(manifestState.calls).toBe(1)
        })

        it('rejects on non-2xx HTTP status', async () => {
            manifestState.statusCode = 500
            await expect(handlers['fetch-updates-manifest'](event)).rejects.toThrow(/HTTP 500/)
        })

        it('rejects on transport error', async () => {
            manifestState.error = new Error('ECONNREFUSED')
            await expect(handlers['fetch-updates-manifest'](event)).rejects.toThrow('ECONNREFUSED')
        })

        it('rejects on malformed JSON', async () => {
            manifestState.body = 'not json'
            await expect(handlers['fetch-updates-manifest'](event)).rejects.toThrow(/parse failed/)
        })
    })

    describe('task manager wiring', () => {
        it('get-tasks returns the task list', async () => {
            const r = await handlers['get-tasks'](event)
            expect(fakeTaskManager.list).toHaveBeenCalled()
            expect(r).toEqual([{ id: 't1', label: 'x', status: 'succeeded' }])
        })

        it('subscribes once and broadcasts task-updated to all windows', () => {
            expect(fakeTaskManager.onUpdate).toHaveBeenCalledTimes(1)
            const listener = fakeTaskManager.onUpdate.mock.calls[0][0]
            listener({ id: 't9', status: 'running' })
            expect(fakeWindow.webContents.send).toHaveBeenCalledWith('task-updated', { id: 't9', status: 'running' })
        })

        it('labels the task with the action and node, and returns its id immediately', () => {
            fakeNodeManager.findNode.mockReturnValueOnce({ ...fakeNode, name: 'prod-1' })
            const r = handlers['run-node-task'](event, 'n1', 'start-service', ['svc'])
            expect(fakeTaskManager.run).toHaveBeenCalledWith(
                expect.stringContaining('Start service · prod-1'),
                expect.any(Function),
                { nodeId: 'n1' },
            )
            expect(r).toEqual({ taskId: 'task-123' })
        })
    })
})
