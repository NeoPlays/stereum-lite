import { randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import log from 'electron-log'

// In-memory only: survives renderer navigation, not app restart (cross-restart history = future audit log).
const MAX_TASKS = 100

// Ambient progress channel: `runPlaybook` reads the reporter via getStore() - no callback threading through Node methods.
export const taskContext = new AsyncLocalStorage()

/**
 * Parse `stereumjson` output (blank-line-separated TASK:/ACTION:/CATEGORY: blocks) into
 * sub-tasks, mirroring the launcher's TaskManager; `START_TASK` marker blocks are skipped.
 * @param {string} stdout
 * @returns {{ name: string, action: string|null, status: string|null, data: string }[]}
 */
export function parseSubTasks(stdout = '') {
    if (!stdout) return []
    const blocks = stdout.split('\n\n').filter((b) => b.trim() && !b.includes('START_TASK'))
    const subTasks = []
    for (const block of blocks) {
        const name = /^TASK: (.*)/m.exec(block)?.[1]
        const action = /^ACTION: (.*)/m.exec(block)?.[1]
        const status = /^CATEGORY: (.*)/m.exec(block)?.[1]
        // Skip blocks that aren't stereumjson task records (no recognised header).
        if (!name && !action && !status) continue
        subTasks.push({
            name: name || action || 'task',
            action: action || null,
            status: status || null,
            data: block,
        })
    }
    return subTasks
}

function groupStatus(subTasks) {
    return subTasks.some((s) => s.status === 'FAILED') ? 'failed' : 'ok'
}

export class TaskManager {
    constructor() {
        this.tasks = [] // newest first
        this._listeners = new Set()
    }

    /** Subscribe to per-task updates (create + every status transition). Returns an unsubscribe fn. */
    onUpdate(cb) {
        this._listeners.add(cb)
        return () => this._listeners.delete(cb)
    }

    _emit(task) {
        const dto = this.toDTO(task)
        for (const cb of this._listeners) {
            try { cb(dto) } catch (e) { log.error('TaskManager listener error:', e?.message || e) }
        }
    }

    /** Lightweight DTO for the list (no output/subtask payload). */
    toListDTO(t) {
        return {
            id: t.id,
            label: t.label,
            nodeId: t.nodeId,
            status: t.status,
            createdAt: t.createdAt,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            subTaskCount: t.subTasks.length,
            error: t.error,
        }
    }

    /** Full DTO: `groups` = one `{ label, status, subTasks }` per playbook run, `subTasks` = flattened view for status/count. */
    toDTO(t) {
        return { ...this.toListDTO(t), groups: t.groups, subTasks: t.subTasks, output: t.output }
    }

    /** All tasks as full DTOs (newest first). */
    list() {
        return this.tasks.map((t) => this.toDTO(t))
    }

    get(id) {
        const t = this.tasks.find((t) => t.id === id)
        return t ? this.toDTO(t) : null
    }

    clear() {
        this.tasks = []
    }

    /**
     * Run an op as a tracked task - fire-and-forget: returns the task id immediately, observe via
     * `task-updated`. Errors are captured on the task (`failed` + `error`), never thrown - no caller awaits.
     * @param {string} label - human-facing label
     * @param {() => Promise<any>} fn
     * @param {{ nodeId?: string }} [opts]
     * @returns {string} the new task's id
     */
    run(label, fn, { nodeId = null } = {}) {
        const now = Date.now()
        const task = {
            id: randomUUID(),
            label,
            nodeId,
            status: 'running',
            createdAt: now,
            startedAt: now,
            endedAt: null,
            groups: [], // [{ label, status, subTasks }] - one per playbook run
            subTasks: [], // flattened view across groups (status + count)
            output: '',
            error: null,
        }
        this.tasks.unshift(task)
        if (this.tasks.length > MAX_TASKS) this.tasks.length = MAX_TASKS
        this._emit(task)

        const reporter = this._makeReporter(task)

        Promise.resolve()
            .then(() => taskContext.run(reporter, () => fn()))
            .then((result) => {
                // Streamed reporter data wins; parse the result only when nothing streamed (non-playbook ops).
                if (!task.subTasks.length) this._recordResult(task, result)
                if (task.subTasks.some((s) => s.status === 'FAILED')) task.status = 'failed'
                else if (task.status === 'running') task.status = 'succeeded'
                task.endedAt = Date.now()
                this._emit(task)
            })
            .catch((error) => {
                // If nothing streamed before the failure, parse the error's own log/stdout (a rejected ansible call carries it).
                if (!task.subTasks.length && error && (error.log || error.stdout || error.stderr)) {
                    this._recordResult(task, error)
                }
                task.status = 'failed'
                task.error = error?.message || String(error)
                task.endedAt = Date.now()
                this._emit(task)
                log.error(`Task failed: ${label}:`, error?.message || error)
            })

        return task.id
    }

    /**
     * Ambient reporter: each playbook claims a segment via `begin(label)` that becomes a group;
     * groups stay in `begin()` order so parallel playbooks in a composite op keep their own headings.
     */
    _makeReporter(task) {
        const segments = [] // { label, subTasks }
        const sync = () => {
            task.groups = segments.map((s) => ({
                label: s.label,
                status: groupStatus(s.subTasks),
                subTasks: s.subTasks,
            }))
            task.subTasks = segments.flatMap((s) => s.subTasks)
            this._emit(task)
        }
        return {
            begin: (label = 'Playbook') => {
                segments.push({ label, subTasks: [] })
                return segments.length - 1
            },
            report: (segment, subTasks) => {
                if (segments[segment]) segments[segment].subTasks = subTasks
                sync()
            },
        }
    }

    /**
     * Pull output + sub-tasks from an op result (one ansible response or an array). The stereumjson
     * `log` carries the parseable blocks - stdout does not - so it's preferred; non-ansible results contribute nothing.
     */
    _recordResult(task, result) {
        const responses = Array.isArray(result) ? result : [result]
        const groups = []
        let output = ''
        for (const r of responses) {
            if (!r || typeof r !== 'object') continue
            const logText = r.log || r.stdout || ''
            if (logText) output += logText + '\n'
            if (r.stderr) output += r.stderr + '\n'
            const subTasks = logText ? parseSubTasks(logText) : []
            if (!subTasks.length) continue
            if (subTasks.some((s) => s.status === 'FAILED')) task.status = 'failed'
            groups.push({ label: 'Playbook', status: groupStatus(subTasks), subTasks })
        }
        task.groups = groups
        task.subTasks = groups.flatMap((g) => g.subTasks)
        task.output = output.trim()
    }
}

const taskManager = new TaskManager()
export default taskManager
