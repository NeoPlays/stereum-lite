import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('fs', () => {
    const readFileSync = vi.fn(() => 'KEY')
    return { readFileSync, default: { readFileSync } }
})
vi.mock('electron-log', () => ({ default: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

const { FakeClient, FakeStream } = vi.hoisted(() => {
    const { EventEmitter } = require('events')
    class FakeStream extends EventEmitter {
        constructor() { super(); this.stderr = new EventEmitter() }
    }
    class FakeClient extends EventEmitter {
        constructor() {
            super()
            FakeClient.instances.push(this)
            this.connectArgs = []
            this.connect = (...a) => { this.connectArgs.push(a) }
            this.end = () => {}
            this.exec = () => {} // overridden per-test
        }
    }
    FakeClient.instances = []
    return { FakeClient, FakeStream }
})

vi.mock('ssh2', () => ({ Client: FakeClient }))

import { SSHService, SSHParams, SSHConnection } from '@main/ssh/SSHService'

function makeParams() {
    return new SSHParams('h', 22, 'u', 'p', '/k', '')
}

// Drive a client through a successful ready handshake, including the hostname exec.
function driveReady(client, hostname = 'box') {
    client.exec = vi.fn((_cmd, cb) => {
        const stream = new FakeStream()
        cb(null, stream)
        setImmediate(() => {
            stream.emit('data', Buffer.from(hostname))
            stream.emit('close', 0)
        })
    })
    setImmediate(() => client.emit('ready'))
}

describe('SSHConnection', () => {
    it('assigns a unique id and starts at sessionCount 0', () => {
        const a = new SSHConnection({})
        const b = new SSHConnection({})
        expect(a.id).not.toBe(b.id)
        expect(a.sessionCount).toBe(0)
    })
})

describe('SSHService', () => {
    beforeEach(() => {
        FakeClient.instances.length = 0
        vi.useRealTimers() // guard against any prior test leaving fake timers active
    })

    describe('connect', () => {
        it('resolves on ready and pushes a connection to the pool', async () => {
            const svc = new SSHService(makeParams())
            const p = svc.connect()
            const client = FakeClient.instances[0]
            driveReady(client, 'my-host')
            const result = await p
            expect(result.code).toBe(0)
            expect(svc.connections).toHaveLength(1)
            expect(svc.SSHParams.name).toBe('my-host')
        })

        it('rejects when the client emits error', async () => {
            const svc = new SSHService(makeParams())
            const p = svc.connect()
            const client = FakeClient.instances[0]
            setImmediate(() => client.emit('error', new Error('refused')))
            await expect(p).rejects.toMatchObject({ code: 1 })
        })

        it('does not overwrite an existing name on reconnect', async () => {
            const svc = new SSHService(makeParams())
            svc.SSHParams.setHostName('preset')
            const p = svc.connect()
            const client = FakeClient.instances[0]
            client.exec = vi.fn()
            setImmediate(() => client.emit('ready'))
            await p
            // No hostname exec should have happened
            expect(client.exec).not.toHaveBeenCalled()
            expect(svc.SSHParams.name).toBe('preset')
        })

        it('removes connection from pool on "close" event', async () => {
            const svc = new SSHService(makeParams())
            const p = svc.connect()
            const client = FakeClient.instances[0]
            driveReady(client)
            await p
            expect(svc.connections).toHaveLength(1)
            client.emit('close')
            expect(svc.connections).toHaveLength(0)
        })
    })

    describe('_getConnection', () => {
        it('returns an existing under-cap connection and bumps sessionCount', async () => {
            const svc = new SSHService(makeParams())
            const fakeConn = { conn: {}, sessionCount: 1 }
            svc.connections = [fakeConn]
            const got = await svc._getConnection()
            expect(got).toBe(fakeConn)
            expect(fakeConn.sessionCount).toBe(2)
        })

        it('fails fast with "SSH connection unavailable" when pool empty and not reachable', async () => {
            const svc = new SSHService(makeParams())
            await expect(svc._getConnection()).rejects.toMatchObject({ code: 1, message: /unavailable/i })
        })

        it('opens a new connection when none exist but service is reachable', async () => {
            const svc = new SSHService(makeParams())
            svc._reachable = true
            const spy = vi.spyOn(svc, 'connect').mockImplementation(async () => {
                svc.connections.push({ conn: {}, sessionCount: 0 })
            })
            const got = await svc._getConnection()
            expect(spy).toHaveBeenCalled()
            expect(got.sessionCount).toBe(1)
        })

        it('throws when connect() succeeds but no connection becomes available', async () => {
            const svc = new SSHService(makeParams())
            svc._reachable = true
            vi.spyOn(svc, 'connect').mockResolvedValue()
            await expect(svc._getConnection()).rejects.toThrow(/No available SSH connection/)
        })
    })

    describe('exec', () => {
        it('prefixes "sudo " when useSudo=true (default)', async () => {
            const svc = new SSHService(makeParams())
            const fakeConn = {
                conn: { exec: vi.fn((cmd, cb) => {
                    const stream = new FakeStream()
                    cb(null, stream)
                    setImmediate(() => {
                        stream.emit('data', Buffer.from('out'))
                        stream.stderr.emit('data', Buffer.from('err'))
                        stream.emit('close', 0)
                    })
                }) },
                sessionCount: 0,
            }
            svc.connections = [fakeConn]
            const result = await svc.exec('ls')
            expect(fakeConn.conn.exec.mock.calls[0][0]).toBe('sudo ls')
            expect(result).toEqual({ rc: 0, stdout: 'out', stderr: 'err' })
        })

        it('does not prefix sudo when useSudo=false', async () => {
            const svc = new SSHService(makeParams())
            const fakeConn = {
                conn: { exec: vi.fn((cmd, cb) => {
                    const stream = new FakeStream()
                    cb(null, stream)
                    setImmediate(() => stream.emit('close', 0))
                }) },
                sessionCount: 0,
            }
            svc.connections = [fakeConn]
            await svc.exec('whoami', false)
            expect(fakeConn.conn.exec.mock.calls[0][0]).toBe('whoami')
        })

        it('rejects when conn.exec yields an error', async () => {
            const svc = new SSHService(makeParams())
            svc.connections = [{
                conn: { exec: (cmd, cb) => cb(new Error('chan-fail')) },
                sessionCount: 0,
            }]
            await expect(svc.exec('ls')).rejects.toThrow('chan-fail')
        })

        it('accumulates multi-chunk stdout/stderr', async () => {
            const svc = new SSHService(makeParams())
            svc.connections = [{
                conn: { exec: (cmd, cb) => {
                    const stream = new FakeStream()
                    cb(null, stream)
                    setImmediate(() => {
                        stream.emit('data', Buffer.from('hel'))
                        stream.emit('data', Buffer.from('lo'))
                        stream.stderr.emit('data', Buffer.from('w'))
                        stream.stderr.emit('data', Buffer.from('arn'))
                        stream.emit('close', 2)
                    })
                } },
                sessionCount: 0,
            }]
            const r = await svc.exec('x', false)
            expect(r).toEqual({ rc: 2, stdout: 'hello', stderr: 'warn' })
        })

        it('writes input to stdin and closes it', async () => {
            const svc = new SSHService(makeParams())
            const stream = new FakeStream()
            stream.end = vi.fn(() => setImmediate(() => stream.emit('close', 0)))
            svc.connections = [{
                conn: { exec: (cmd, cb) => cb(null, stream) },
                sessionCount: 0,
            }]
            await svc.exec('cat', false, { input: 'secret-token' })
            expect(stream.end).toHaveBeenCalledWith('secret-token')
        })

        it('never touches stdin when no input is given', async () => {
            const svc = new SSHService(makeParams())
            const stream = new FakeStream()
            stream.end = vi.fn()
            svc.connections = [{
                conn: { exec: (cmd, cb) => {
                    cb(null, stream)
                    setImmediate(() => stream.emit('close', 0))
                } },
                sessionCount: 0,
            }]
            await svc.exec('ls', false)
            expect(stream.end).not.toHaveBeenCalled()
        })

        it('keeps the secret out of the command line', async () => {
            const svc = new SSHService(makeParams())
            const stream = new FakeStream()
            stream.end = vi.fn(() => setImmediate(() => stream.emit('close', 0)))
            const exec = vi.fn((cmd, cb) => cb(null, stream))
            svc.connections = [{ conn: { exec }, sessionCount: 0 }]
            await svc.exec('read -r T; use "$T"', true, { input: 'hunter2' })
            expect(exec.mock.calls[0][0]).not.toContain('hunter2')
        })
    })

    describe('execStream', () => {
        function streamingConn() {
            const stream = new FakeStream()
            stream.close = vi.fn(() => stream.emit('close', null))
            const conn = {
                conn: {
                    exec: vi.fn((cmd, cb) => {
                            cb(null, stream)
                    }),
                },
                sessionCount: 0,
            }
            return { conn, stream, capturedCmd: () => conn.conn.exec.mock.calls[0]?.[0] }
        }

        it('prefixes sudo by default and routes to conn.exec', async () => {
            const svc = new SSHService(makeParams())
            const { conn, capturedCmd } = streamingConn()
            svc.connections = [conn]
            await svc.execStream('docker logs -f stereum-x', { onLine: () => {}, onClose: () => {} })
            expect(capturedCmd()).toBe('sudo docker logs -f stereum-x')
        })

        it('emits one onLine per newline (stdout + stderr both feed the line buffer)', async () => {
            const svc = new SSHService(makeParams())
            const { conn, stream } = streamingConn()
            svc.connections = [conn]
            const lines = []
            await svc.execStream('cmd', { onLine: l => lines.push(l), onClose: () => {}, useSudo: false })
            stream.emit('data', Buffer.from('line1\nlin'))
            stream.emit('data', Buffer.from('e2\n'))
            stream.stderr.emit('data', Buffer.from('err-line\n'))
            expect(lines).toEqual(['line1', 'line2', 'err-line'])
        })

        it('strips a trailing \\r before the \\n (windows-style endings)', async () => {
            const svc = new SSHService(makeParams())
            const { conn, stream } = streamingConn()
            svc.connections = [conn]
            const lines = []
            await svc.execStream('cmd', { onLine: l => lines.push(l), useSudo: false })
            stream.emit('data', Buffer.from('hello\r\nworld\r\n'))
            expect(lines).toEqual(['hello', 'world'])
        })

        it('flushes the trailing partial line on close', async () => {
            const svc = new SSHService(makeParams())
            const { conn, stream } = streamingConn()
            svc.connections = [conn]
            const lines = []
            const closes = []
            await svc.execStream('cmd', { onLine: l => lines.push(l), onClose: c => closes.push(c), useSudo: false })
            stream.emit('data', Buffer.from('partial'))
            stream.emit('close', 0)
            expect(lines).toEqual(['partial'])
            expect(closes).toEqual([{ rc: 0 }])
        })

        it('abort() closes the stream and the second abort is a no-op', async () => {
            const svc = new SSHService(makeParams())
            const { conn, stream } = streamingConn()
            svc.connections = [conn]
            const handle = await svc.execStream('cmd', { onLine: () => {}, onClose: () => {}, useSudo: false })
            handle.abort()
            expect(stream.close).toHaveBeenCalledTimes(1)
            handle.abort()
            expect(stream.close).toHaveBeenCalledTimes(1)
        })

        it('invokes onError + onClose when conn.exec yields an error', async () => {
            const svc = new SSHService(makeParams())
            const conn = {
                conn: { exec: (cmd, cb) => cb(new Error('chan')) },
                sessionCount: 0,
            }
            svc.connections = [conn]
            const onError = vi.fn()
            const onClose = vi.fn()
            await svc.execStream('cmd', { onLine: () => {}, onError, onClose, useSudo: false })
            expect(onError).toHaveBeenCalledTimes(1)
            expect(onError.mock.calls[0][0].message).toBe('chan')
            expect(onClose).toHaveBeenCalledWith({ rc: -1, error: expect.any(Error) })
        })

        it('reports connection-acquire failure via onClose with rc=-1 (no throw)', async () => {
            const svc = new SSHService(makeParams())
            svc._reachable = false   // forces _getConnection to throw fast
            const onClose = vi.fn()
            const handle = await svc.execStream('cmd', { onLine: () => {}, onClose, useSudo: false })
            expect(handle).toBeDefined()
            expect(onClose).toHaveBeenCalledTimes(1)
            expect(onClose.mock.calls[0][0].rc).toBe(-1)
        })

        it('does not throw if onLine handler throws (logs & continues)', async () => {
            const svc = new SSHService(makeParams())
            const { conn, stream } = streamingConn()
            svc.connections = [conn]
            const onLine = vi.fn(() => { throw new Error('renderer dead') })
            await svc.execStream('cmd', { onLine, useSudo: false })
            expect(() => stream.emit('data', Buffer.from('x\n'))).not.toThrow()
            expect(onLine).toHaveBeenCalledWith('x')
        })
    })

    describe('disconnect', () => {
        it('calls .end() on each conn and clears the pool', () => {
            const svc = new SSHService(makeParams())
            const end1 = vi.fn(), end2 = vi.fn()
            svc.connections = [{ conn: { end: end1 } }, { conn: { end: end2 } }]
            svc.disconnect()
            expect(end1).toHaveBeenCalled()
            expect(end2).toHaveBeenCalled()
            expect(svc.connections).toEqual([])
        })

        it('sets _reachable=false and emits disconnected state', () => {
            const onState = vi.fn()
            const svc = new SSHService(makeParams(), onState)
            svc._reachable = true
            svc._lastState = 'connected'
            svc.disconnect()
            expect(svc._reachable).toBe(false)
            expect(onState).toHaveBeenLastCalledWith('disconnected')
        })

        it('aborts any in-flight reconnect cycle', () => {
            const svc = new SSHService(makeParams())
            const abort = new AbortController()
            const abortSpy = vi.spyOn(abort, 'abort')
            svc._reconnectAbort = abort
            svc.disconnect()
            expect(abortSpy).toHaveBeenCalled()
        })
    })

    describe('connect - keepalive & state', () => {
        it('passes keepaliveInterval / keepaliveCountMax / readyTimeout to ssh2.connect', async () => {
            const svc = new SSHService(makeParams())
            const p = svc.connect()
            const client = FakeClient.instances[0]
            driveReady(client)
            await p
            const opts = client.connectArgs[0][0]
            expect(opts.keepaliveInterval).toBe(SSHService.KEEPALIVE_INTERVAL_MS)
            expect(opts.keepaliveCountMax).toBe(SSHService.KEEPALIVE_COUNT_MAX)
            expect(opts.readyTimeout).toBe(SSHService.READY_TIMEOUT_MS)
        })

        it('invokes onStateChange("connected") on ready and ("disconnected") on close', async () => {
            const onState = vi.fn()
            const svc = new SSHService(makeParams(), onState)
            const p = svc.connect()
            const client = FakeClient.instances[0]
            driveReady(client)
            await p
            expect(onState).toHaveBeenCalledWith('connected')
            expect(svc._reachable).toBe(true)
            // skip auto-reconnect so we hit the disconnected-emit path, not backoff
            svc._lastState = 'connected'
            svc._reconnecting = true
            client.emit('close')
            // re-test without _reconnecting to verify 'disconnected' when wasConnected=false:
            const svc2 = new SSHService(makeParams(), onState)
            svc2._lastState = null
            // initial connect failure - no prior 'connected' state
            const p2 = svc2.connect()
            const c2 = FakeClient.instances[FakeClient.instances.length - 1]
            setImmediate(() => c2.emit('error', new Error('refused')))
            await p2.catch(() => {})
            expect(onState).toHaveBeenCalledWith('disconnected')
        })

        it('_emitState dedups identical consecutive states', () => {
            const onState = vi.fn()
            const svc = new SSHService(makeParams(), onState)
            svc._emitState('connected')
            svc._emitState('connected')
            svc._emitState('reconnecting')
            svc._emitState('reconnecting')
            expect(onState).toHaveBeenCalledTimes(2)
            expect(onState.mock.calls).toEqual([['connected'], ['reconnecting']])
        })

        it('removes the right entry on close (uses sshConn.id, not conn.id)', async () => {
            const svc = new SSHService(makeParams())
            svc._reconnecting = true // suppress auto-reconnect on drop for test isolation

            const p1 = svc.connect()
            driveReady(FakeClient.instances[0], 'h1')
            await p1
            const p2 = svc.connect()
            driveReady(FakeClient.instances[1], 'h1')
            await p2
            expect(svc.connections).toHaveLength(2)

            FakeClient.instances[0].emit('close')
            expect(svc.connections).toHaveLength(1)
            FakeClient.instances[1].emit('close')
            expect(svc.connections).toHaveLength(0)
        })
    })

    describe('exec - timeout', () => {
        beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
        afterEach(() => { vi.useRealTimers() })

        it('rejects with {rc:-1, "SSH exec timeout"} after EXEC_TIMEOUT_MS with no stream activity', async () => {
            const svc = new SSHService(makeParams())
            svc.connections = [{
                conn: { exec: vi.fn() }, // never invokes callback
                sessionCount: 0,
            }]
            const promise = svc.exec('hang', false)
            // attach the rejection handler before advancing time so the rejection is never "unhandled"
            const assertion = expect(promise).rejects.toMatchObject({ rc: -1, message: /timeout/i })
            await vi.advanceTimersByTimeAsync(SSHService.EXEC_TIMEOUT_MS)
            await assertion
        })

        it('clears the timeout on normal stream close so no late rejection happens', async () => {
            const svc = new SSHService(makeParams())
            const stream = new FakeStream()
            svc.connections = [{
                conn: { exec: (cmd, cb) => { cb(null, stream) } },
                sessionCount: 0,
            }]
            const promise = svc.exec('ok', false)
            // Allow the exec callback (scheduled via the async executor) to run, then emit close.
            await vi.advanceTimersByTimeAsync(0)
            stream.emit('close', 0)
            const r = await promise
            expect(r.rc).toBe(0)
            // advance past the timeout - should not double-reject
            await vi.advanceTimersByTimeAsync(SSHService.EXEC_TIMEOUT_MS + 1)
        })

        it('honors a per-call timeoutMs override', async () => {
            const svc = new SSHService(makeParams())
            svc.connections = [{ conn: { exec: vi.fn() }, sessionCount: 0 }]
            const promise = svc.exec('hang', false, { timeoutMs: 60_000 })
            const assertion = expect(promise).rejects.toMatchObject({ rc: -1, message: /timeout/i })
            // not yet - default would have fired here
            await vi.advanceTimersByTimeAsync(SSHService.EXEC_TIMEOUT_MS)
            expect(svc.connections.length).toBe(1)
            // crosses the override
            await vi.advanceTimersByTimeAsync(60_000 - SSHService.EXEC_TIMEOUT_MS)
            await assertion
        })

        it('re-arms the idle timer on output so a chatty long command never trips it', async () => {
            const svc = new SSHService(makeParams())
            const stream = new FakeStream()
            svc.connections = [{ conn: { exec: (cmd, cb) => { cb(null, stream) }, }, sessionCount: 0 }]
            const promise = svc.exec('playbook', false, { timeoutMs: SSHService.EXEC_TIMEOUT_MS })
            await vi.advanceTimersByTimeAsync(0)
            // emit a chunk just before each timeout boundary - each resets the timer
            for (let i = 0; i < 5; i++) {
                await vi.advanceTimersByTimeAsync(SSHService.EXEC_TIMEOUT_MS - 1)
                stream.emit('data', Buffer.from(`task ${i}\n`))
            }
            stream.emit('close', 0)
            const r = await promise
            expect(r.rc).toBe(0)
            expect(r.stdout).toContain('task 4')
        })
    })

    describe('reconnect (single attempt)', () => {
        it('returns true and emits reconnecting then connected on success', async () => {
            const onState = vi.fn()
            const svc = new SSHService(makeParams(), onState)
            const p = svc.reconnect()
            const client = FakeClient.instances[0]
            driveReady(client)
            const ok = await p
            expect(ok).toBe(true)
            expect(onState).toHaveBeenCalledWith('reconnecting')
            expect(onState).toHaveBeenCalledWith('connected')
        })

        it('returns false and emits disconnected on failure', async () => {
            const onState = vi.fn()
            const svc = new SSHService(makeParams(), onState)
            const p = svc.reconnect()
            const client = FakeClient.instances[0]
            setImmediate(() => client.emit('error', new Error('refused')))
            const ok = await p
            expect(ok).toBe(false)
            expect(onState).toHaveBeenCalledWith('reconnecting')
            expect(onState).toHaveBeenCalledWith('disconnected')
        })

        it('short-circuits to true when already reachable', async () => {
            const svc = new SSHService(makeParams())
            svc._reachable = true
            const spy = vi.spyOn(svc, 'connect')
            const ok = await svc.reconnect()
            expect(ok).toBe(true)
            expect(spy).not.toHaveBeenCalled()
        })

        it('aborts an in-flight reconnect when called again', async () => {
            const svc = new SSHService(makeParams())
            const first = new AbortController()
            const abortSpy = vi.spyOn(first, 'abort')
            svc._reconnectAbort = first
            const p = svc.reconnect()
            // immediately kick off the connect's error path so the second call doesn't hang the test
            const client = FakeClient.instances[0]
            setImmediate(() => client.emit('error', new Error('boom')))
            await p
            expect(abortSpy).toHaveBeenCalled()
        })
    })

    describe('_reconnectWithBackoff', () => {
        beforeEach(() => { vi.useFakeTimers() })
        afterEach(() => { vi.useRealTimers() })

        it('waits the first delay (2s) before the first attempt', async () => {
            const svc = new SSHService(makeParams())
            const connectSpy = vi.spyOn(svc, 'connect').mockResolvedValue({ code: 0, message: 'ok' })
            // Trick: set _reachable=true after connect resolves, so the cycle ends
            connectSpy.mockImplementation(async () => { svc._reachable = true })

            const p = svc._reconnectWithBackoff()
            // Not yet - first delay is 2000ms
            await vi.advanceTimersByTimeAsync(1999)
            expect(connectSpy).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1)
            await p
            expect(connectSpy).toHaveBeenCalledTimes(1)
        })

        it('cycles through all delays and emits disconnected after final failure', async () => {
            const svc = new SSHService(makeParams())
            const onState = vi.fn()
            svc._onStateChange = onState
            const connectSpy = vi.spyOn(svc, 'connect').mockRejectedValue(new Error('nope'))

            const p = svc._reconnectWithBackoff()
            // Advance through the full schedule
            const total = SSHService.RECONNECT_DELAYS_MS.reduce((a, b) => a + b, 0)
            await vi.advanceTimersByTimeAsync(total + 100)
            const result = await p
            expect(result).toBe(false)
            expect(connectSpy).toHaveBeenCalledTimes(SSHService.RECONNECT_DELAYS_MS.length)
            expect(onState).toHaveBeenCalledWith('reconnecting')
            expect(onState).toHaveBeenCalledWith('disconnected')
        })

        it('aborts cleanly when the abort signal fires mid-sleep', async () => {
            const svc = new SSHService(makeParams())
            const connectSpy = vi.spyOn(svc, 'connect').mockRejectedValue(new Error('x'))
            const p = svc._reconnectWithBackoff()
            // mid-first-delay, abort
            await vi.advanceTimersByTimeAsync(500)
            svc._reconnectAbort.abort()
            const result = await p
            expect(result).toBe(false)
            expect(connectSpy).not.toHaveBeenCalled()
        })
    })

    describe('dropConnection auto-trigger', () => {
        it('starts _reconnectWithBackoff when the established connection drops', async () => {
            const onState = vi.fn()
            const svc = new SSHService(makeParams(), onState)
            // Stub the backoff so we observe the trigger without running through delays
            const backoffSpy = vi.spyOn(svc, '_reconnectWithBackoff').mockImplementation(async () => {
                svc._reconnecting = true
                svc._emitState('reconnecting')
            })

            const p = svc.connect()
            driveReady(FakeClient.instances[0])
            await p
            expect(onState).toHaveBeenLastCalledWith('connected')

            FakeClient.instances[0].emit('close')
            expect(backoffSpy).toHaveBeenCalledTimes(1)
            expect(onState).toHaveBeenCalledWith('reconnecting')
        })

        it('emits "disconnected" (no backoff) when an unestablished connection fails', async () => {
            const onState = vi.fn()
            const svc = new SSHService(makeParams(), onState)
            const backoffSpy = vi.spyOn(svc, '_reconnectWithBackoff')
            const p = svc.connect()
            const client = FakeClient.instances[0]
            setImmediate(() => client.emit('error', new Error('refused')))
            await p.catch(() => {})
            expect(backoffSpy).not.toHaveBeenCalled()
            expect(onState).toHaveBeenCalledWith('disconnected')
        })
    })
})
