<template>
    <div class="panel-overlay" @click.self="$emit('close')">
        <aside class="panel">
            <header class="panel-header">
                <h2>Tasks</h2>
                <button class="icon-btn" title="Close" @click="$emit('close')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </header>

            <div class="panel-scroll">
                <p v-if="!tasks.recent.length" class="empty">No tasks yet. Service and update actions show up here.</p>

                <ul v-else class="task-list">
                    <li v-for="task in tasks.recent" :key="task.id" class="task">
                        <button class="task-head" @click="toggle(task.id)">
                            <span class="status-pill" :class="task.status">{{ statusLabel(task.status) }}</span>
                            <span class="task-label">{{ task.label }}</span>
                            <span class="task-time">{{ duration(task) }}</span>
                            <span class="chevron" :class="{ open: expanded.has(task.id) }">›</span>
                        </button>

                        <div v-if="expanded.has(task.id)" class="task-body">
                            <p v-if="task.error" class="task-error mono">{{ task.error }}</p>

                            <!-- One block per playbook run; a lone playbook renders flat, composites get a heading per group. -->
                            <template v-if="task.groups?.length">
                                <div v-for="(group, gi) in task.groups" :key="gi" class="group">
                                    <button
                                        v-if="task.groups.length > 1"
                                        class="group-head"
                                        @click="toggleGroup(task.id, gi)"
                                    >
                                        <span class="cat" :class="catClass(group.status === 'failed' ? 'FAILED' : 'OK')">
                                            {{ group.status === 'failed' ? 'FAILED' : 'OK' }}
                                        </span>
                                        <span class="group-label">{{ group.label }}</span>
                                        <span class="group-count">{{ group.subTasks.length }}</span>
                                        <span class="chevron" :class="{ open: groupOpen(task, gi) }">›</span>
                                    </button>

                                    <ul v-if="groupOpen(task, gi)" class="subtasks">
                                        <li v-for="(sub, i) in group.subTasks" :key="i" class="subtask">
                                            <button class="subtask-head" @click="openDetail(sub)">
                                                <span class="cat" :class="catClass(sub.status)">{{ sub.status || '-' }}</span>
                                                <span class="subtask-name">{{ sub.name }}</span>
                                                <span class="expand-hint" aria-hidden="true">⤢</span>
                                            </button>
                                        </li>
                                    </ul>
                                </div>
                            </template>

                            <p v-else-if="task.status === 'running'" class="no-output">Waiting for the first task to run…</p>
                            <p v-else-if="!task.error" class="no-output">No tasks were logged.</p>
                        </div>
                    </li>
                </ul>
            </div>
        </aside>

        <!-- Sub-task detail in a wide centered modal - the raw ansible output is unreadable in the narrow drawer. -->
        <div v-if="detail" class="modal-overlay" @click.self="detail = null">
            <div class="modal">
                <header class="modal-header">
                    <span class="cat" :class="catClass(detail.status)">{{ detail.status || '-' }}</span>
                    <h3 class="modal-title">{{ detail.name }}</h3>
                    <button class="copy-btn" @click="copy('detail', detail.data)">
                        {{ copied === 'detail' ? 'Copied' : 'Copy' }}
                    </button>
                    <button class="icon-btn" title="Close" @click="detail = null">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </header>
                <pre class="modal-output mono">{{ detail.data }}</pre>
            </div>
        </div>
    </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useTasksStore } from '@stores/useTasks'

defineEmits(['close'])
const tasks = useTasksStore()
const expanded = reactive(new Set())
const groupExpanded = reactive(new Set())

// The sub-task whose raw output is shown in the detail modal (null = closed).
const detail = ref(null)
function openDetail(sub) { detail.value = sub }

// Key of the element whose output was just copied, for the transient "Copied" label.
const copied = ref(null)
let copiedTimer = null
async function copy(key, text) {
    try {
        await navigator.clipboard.writeText(text)
        copied.value = key
        clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => { copied.value = null }, 1500)
    } catch (e) {
        console.error('Copy failed:', e)
    }
}

onMounted(() => tasks.refreshTasks())

function toggle(id) {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
}

const groupKey = (taskId, gi) => `${taskId}:${gi}`
function toggleGroup(taskId, gi) {
    const key = groupKey(taskId, gi)
    if (groupExpanded.has(key)) groupExpanded.delete(key)
    else groupExpanded.add(key)
}
// A lone group has no header to toggle, so its steps always show; multi-group starts collapsed.
function groupOpen(task, gi) {
    if (task.groups.length === 1) return true
    return groupExpanded.has(groupKey(task.id, gi))
}

function statusLabel(status) {
    return { running: 'Running', succeeded: 'Done', failed: 'Failed' }[status] || status
}

function catClass(status) {
    if (status === 'FAILED') return 'failed'
    if (status === 'OK') return 'ok'
    if (status === 'SKIPPED') return 'skipped'
    return ''
}

// Elapsed time for running tasks, total runtime for finished ones.
function duration(task) {
    const end = task.endedAt || Date.now()
    const secs = Math.max(0, Math.round((end - task.startedAt) / 1000))
    if (secs < 60) return `${secs}s`
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}m ${s}s`
}
</script>

<style scoped>
.panel-overlay {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.4);
    z-index: 200;
    display: flex;
    justify-content: flex-end;
}

.panel {
    width: 420px;
    max-width: 100vw;
    height: 100%;
    background-color: var(--color-background);
    border-left: 1px solid var(--ev-c-gray-3);
    display: flex;
    flex-direction: column;
    padding: 20px 24px;
    gap: 16px;
    animation: slidein 180ms ease-out;
    overflow: hidden;
}
@keyframes slidein {
    from { transform: translateX(20px); opacity: 0.5; }
    to { transform: translateX(0); opacity: 1; }
}

.panel-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
}

/* Only the task list scrolls; the header stays put so the panel is always dismissable. */
.panel-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
}
.panel-header h2 {
    font-size: var(--font-size-title);
    font-weight: var(--font-weight-semibold);
    color: var(--ev-c-text-1);
}

/* Icon button matching the app header's .header-action (28px, ghost, hover fill). */
.icon-btn {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: transparent;
    border: none;
    border-radius: var(--radius-md);
    color: var(--ev-c-text-3);
    cursor: pointer;
    transition: color var(--transition-fast), background-color var(--transition-fast);
}
.icon-btn:hover {
    color: var(--ev-c-text-1);
    background-color: var(--ev-c-gray-3);
}

.empty {
    font-size: var(--font-size-body);
    color: var(--ev-c-text-3);
}

.task-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
}

.task {
    background-color: var(--color-background-soft);
    border-radius: var(--radius-xl);
    overflow: hidden;
}

.task-head {
    /* Sticky so a long expanded sub-task list can be collapsed from any scroll position. */
    position: sticky;
    top: 0;
    z-index: 2;
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--card-padding);
    background-color: var(--color-background-soft);
    border: none;
    cursor: pointer;
    text-align: left;
}

.status-pill {
    flex-shrink: 0;
    padding: var(--chip-padding);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-meta);
    font-weight: var(--font-weight-medium);
}
.status-pill.running { background-color: var(--color-warning-soft); color: var(--color-warning); }
.status-pill.succeeded { background-color: var(--color-success-soft); color: var(--color-success); }
.status-pill.failed { background-color: var(--color-danger-soft); color: var(--color-danger); }

.task-label {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--font-size-secondary);
    color: var(--ev-c-text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.task-time {
    flex-shrink: 0;
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
}
.chevron {
    flex-shrink: 0;
    color: var(--ev-c-text-3);
    transition: transform var(--transition-fast);
}
.chevron.open { transform: rotate(90deg); }

.task-body {
    padding: 0 var(--card-padding) var(--card-padding);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
}

.task-error {
    font-size: var(--font-size-meta);
    color: var(--color-danger);
    white-space: pre-wrap;
    word-break: break-word;
}

.group {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.group-head {
    /* Sticky just under the task header so group headings stay reachable while scrolling. */
    position: sticky;
    top: 44px;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: 4px 4px;
    background-color: var(--color-background-soft);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-size: var(--font-size-secondary);
    transition: background-color var(--transition-fast);
}
.group-head:hover { background-color: var(--ev-c-gray-3); }
.group-label {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--ev-c-text-1);
    font-weight: var(--font-weight-medium);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.group-count {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
}
.group .chevron {
    flex-shrink: 0;
    color: var(--ev-c-text-3);
    transition: transform var(--transition-fast);
}
.group .chevron.open { transform: rotate(90deg); }

.subtasks {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* Cap so a long playbook scrolls in its own box instead of pushing the sticky headers off screen. */
    max-height: 320px;
    overflow-y: auto;
    background-color: var(--color-background-mute);
    border-radius: var(--radius-md);
    padding: var(--space-2);
}
.subtask {
    display: flex;
    flex-direction: column;
}
.subtask-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: 3px 4px;
    background-color: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-size: var(--font-size-meta);
    transition: background-color var(--transition-fast);
}
.subtask-head:hover { background-color: var(--ev-c-gray-3); }
.cat {
    flex-shrink: 0;
    width: 56px;
    font-family: var(--font-mono);
    color: var(--ev-c-text-3);
}
.cat.ok { color: var(--color-success); }
.cat.failed { color: var(--color-danger); }
.cat.skipped { color: var(--ev-c-text-3); }
.subtask-name {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--ev-c-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.subtask .chevron {
    flex-shrink: 0;
    color: var(--ev-c-text-3);
    transition: transform var(--transition-fast);
}
.subtask .chevron.open { transform: rotate(90deg); }
.expand-hint {
    flex-shrink: 0;
    color: var(--ev-c-text-3);
    font-size: var(--font-size-meta);
}

.copy-btn {
    padding: 2px 8px;
    background-color: var(--color-background-soft);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-sm);
    color: var(--ev-c-text-2);
    font-size: var(--font-size-meta);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.copy-btn:hover { background-color: var(--ev-c-gray-3); }

/* Sub-task detail modal - wide, tall, and readable, unlike the narrow drawer. */
.modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 300;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
}
.modal {
    display: flex;
    flex-direction: column;
    width: min(900px, 90vw);
    max-height: 85vh;
    background-color: var(--color-background-soft);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-xl);
    overflow: hidden;
}
.modal-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--ev-c-gray-3);
}
.modal-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--font-size-title);
    font-weight: var(--font-weight-semibold);
    color: var(--ev-c-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.modal-output {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: var(--space-5);
    background-color: var(--color-background-mute);
    font-size: var(--font-size-secondary);
    line-height: 1.6;
    color: var(--ev-c-text-1);
    white-space: pre-wrap;
    word-break: break-word;
}
.no-output {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
}
</style>
