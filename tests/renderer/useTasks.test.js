import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTasksStore } from '@stores/useTasks'

describe('useTasksStore', () => {
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

    const running = (id) => ({ id, label: 'op', status: 'running' })
    const done = (id, status = 'succeeded') => ({ id, label: 'op', status })

    describe('refreshTasks', () => {
        it('hydrates state.tasks from get-tasks', async () => {
            invoke.mockResolvedValueOnce([running('a'), done('b')])
            const s = useTasksStore()
            await s.refreshTasks()
            expect(invoke).toHaveBeenCalledWith('get-tasks')
            expect(s.tasks).toEqual([running('a'), done('b')])
        })

        it('defaults to [] when get-tasks resolves nullish', async () => {
            invoke.mockResolvedValueOnce(null)
            const s = useTasksStore()
            await s.refreshTasks()
            expect(s.tasks).toEqual([])
        })

        it('swallows errors (logs only, no throw)', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            invoke.mockRejectedValueOnce(new Error('boom'))
            const s = useTasksStore()
            await expect(s.refreshTasks()).resolves.toBeUndefined()
            expect(s.tasks).toEqual([])
            errSpy.mockRestore()
        })
    })

    describe('task-updated subscription', () => {
        it('subscribes once across refreshTasks + runNodeTask', async () => {
            invoke.mockResolvedValue([])
            const s = useTasksStore()
            await s.refreshTasks()
            await s.runNodeTask('n', 'start-service', ['x'])
            expect(on).toHaveBeenCalledTimes(1)
            expect(on).toHaveBeenCalledWith('task-updated', expect.any(Function))
        })

        it('_upsert inserts a new task at the front', async () => {
            invoke.mockResolvedValueOnce([done('a')])
            const s = useTasksStore()
            await s.refreshTasks()
            listeners['task-updated'](running('b'))
            expect(s.tasks.map((t) => t.id)).toEqual(['b', 'a'])
        })

        it('_upsert updates an existing task in place', async () => {
            invoke.mockResolvedValueOnce([running('a')])
            const s = useTasksStore()
            await s.refreshTasks()
            listeners['task-updated'](done('a', 'failed'))
            expect(s.tasks).toHaveLength(1)
            expect(s.tasks[0].status).toBe('failed')
        })
    })

    describe('runNodeTask', () => {
        it('invokes run-node-task and resolves to the taskId', async () => {
            invoke.mockResolvedValueOnce({ taskId: 't1' })
            const s = useTasksStore()
            const id = await s.runNodeTask('n1', 'update-os', [])
            expect(invoke).toHaveBeenCalledWith('run-node-task', 'n1', 'update-os', [])
            expect(id).toBe('t1')
        })

        it('resolves to undefined when the response has no taskId', async () => {
            invoke.mockResolvedValueOnce(undefined)
            const s = useTasksStore()
            expect(await s.runNodeTask('n1', 'update-os', [])).toBeUndefined()
        })
    })

    describe('awaitTask', () => {
        it('resolves null immediately for a falsy id', async () => {
            const s = useTasksStore()
            expect(await s.awaitTask(null)).toBeNull()
        })

        it('resolves immediately when the task is already terminal', async () => {
            invoke.mockResolvedValueOnce([done('a', 'succeeded')])
            const s = useTasksStore()
            await s.refreshTasks()
            expect(await s.awaitTask('a')).toMatchObject({ id: 'a', status: 'succeeded' })
        })

        it('waits for a running task to reach a terminal status', async () => {
            invoke.mockResolvedValueOnce([running('a')])
            const s = useTasksStore()
            await s.refreshTasks()
            const p = s.awaitTask('a')
            // A running update must not resolve the awaiter.
            listeners['task-updated'](running('a'))
            listeners['task-updated'](done('a', 'failed'))
            const settled = await p
            expect(settled).toMatchObject({ id: 'a', status: 'failed' })
        })

        it('resolves multiple concurrent awaiters of the same task', async () => {
            invoke.mockResolvedValueOnce([running('a')])
            const s = useTasksStore()
            await s.refreshTasks()
            const both = Promise.all([s.awaitTask('a'), s.awaitTask('a')])
            listeners['task-updated'](done('a', 'succeeded'))
            const [r1, r2] = await both
            expect(r1.status).toBe('succeeded')
            expect(r2.status).toBe('succeeded')
        })
    })

    describe('getters', () => {
        it('runningCount counts only running tasks', async () => {
            invoke.mockResolvedValueOnce([running('a'), running('b'), done('c')])
            const s = useTasksStore()
            await s.refreshTasks()
            expect(s.runningCount).toBe(2)
        })

        it('recent mirrors tasks (newest-first order preserved)', async () => {
            invoke.mockResolvedValueOnce([done('a'), done('b')])
            const s = useTasksStore()
            await s.refreshTasks()
            expect(s.recent).toBe(s.tasks)
        })
    })
})
