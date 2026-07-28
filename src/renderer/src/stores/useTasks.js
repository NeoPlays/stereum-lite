import { defineStore } from 'pinia'

// taskId -> [resolve, ...]; kept outside store state (functions aren't reactive data), resolved from _upsert on terminal status.
const waiters = new Map()

// Mirrors the main-process TaskManager: hydrate once via `get-tasks`, then stay live off `task-updated`.
export const useTasksStore = defineStore('tasks', {
    state: () => ({
        tasks: [], // newest first, full DTOs { id, label, nodeId, status, createdAt, startedAt, endedAt, subTaskCount, subTasks, output, error }
        _subscribed: false,
    }),
    getters: {
        runningCount: (state) => state.tasks.filter((t) => t.status === 'running').length,
        // Newest first (store insertion order).
        recent: (state) => state.tasks,
    },
    actions: {
        _subscribe() {
            if (this._subscribed) return
            this._subscribed = true
            window.api.on('task-updated', (task) => this._upsert(task))
        },
        _upsert(task) {
            const i = this.tasks.findIndex((t) => t.id === task.id)
            if (i === -1) this.tasks.unshift(task)
            else this.tasks[i] = task
            // Resolve anyone awaiting this task once it leaves 'running'.
            if (task.status !== 'running' && waiters.has(task.id)) {
                for (const resolve of waiters.get(task.id)) resolve(task)
                waiters.delete(task.id)
            }
        },
        refreshTasks() {
            this._subscribe()
            return window.api.invoke('get-tasks').then((data) => {
                this.tasks = data || []
            }).catch((error) => {
                console.error('Error fetching tasks:', error)
            })
        },
        // Fire a node op as a background task; resolves to its task id immediately (observe via awaitTask).
        runNodeTask(nodeId, action, args = []) {
            this._subscribe()
            return window.api.invoke('run-node-task', nodeId, action, args).then((r) => r?.taskId)
        },
        // Resolve when the given task reaches a terminal status, with the final DTO.
        awaitTask(taskId) {
            if (!taskId) return Promise.resolve(null)
            const existing = this.tasks.find((t) => t.id === taskId)
            if (existing && existing.status !== 'running') return Promise.resolve(existing)
            return new Promise((resolve) => {
                if (!waiters.has(taskId)) waiters.set(taskId, [])
                waiters.get(taskId).push(resolve)
            })
        },
    },
})
