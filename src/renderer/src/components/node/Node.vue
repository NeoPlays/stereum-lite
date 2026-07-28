<template>
    <div class="node-view">
        <div v-if="loading" class="loading-scrim">
            <span class="loading-spinner"></span>
        </div>
        <div class="top-bar">
            <button class="btn-ghost" @click="router.back()">← Back</button>
            <div class="top-bar-actions">
                <button class="btn-accent" @click="refresh" :disabled="loading">
                    {{ loading ? 'Refreshing…' : '↻ Refresh' }}
                </button>
                <button class="btn-danger" @click="disconnect" :disabled="loading">Disconnect</button>
            </div>
        </div>

        <div v-if="reconnecting" class="state-message">
            <span class="loading-spinner inline"></span>
            Reconnecting to {{ nodeHost }}…
        </div>

        <div v-else-if="disconnected" class="state-message error">
            Connection to this node was lost. Return to the node list to reconnect or remove it.
        </div>

        <div v-else-if="error" class="state-message error">
            Failed to load node. Check your SSH connection and try again.
        </div>

        <template v-else-if="nodeData">
            <div class="node-header">
                <h1 class="node-name copyable" @click="copy(nodeData.name, 'name')" title="Copy hostname">
                    {{ nodeData.name }}
                    <span class="copied-flag" v-if="copied === 'name'">Copied</span>
                </h1>
                <div class="node-meta">
                    <button class="meta-tag copyable" @click="copy(nodeData.host, 'host')" title="Copy IP address">
                        {{ nodeData.host }}:{{ nodeData.port }}
                        <span class="copied-flag" v-if="copied === 'host'">Copied</span>
                    </button>
                    <span class="meta-tag">{{ nodeData.username }}</span>
                </div>
            </div>

            <nav class="tab-bar">
                <button
                    v-for="tab in tabs"
                    :key="tab.id"
                    class="tab"
                    :class="{ active: activeTab === tab.id }"
                    :disabled="tab.disabled"
                    @click="activeTab = tab.id"
                >
                    {{ tab.label }}
                </button>
            </nav>

            <NodeMetrics
                v-show="activeTab === 'metrics'"
                :system="metricsSystem"
                :clients="metricsClients"
                :disk="metricsDisk"
                :services="nodeData.services"
                :system-error="metricsSystemError"
                :clients-error="metricsClientsError"
                :disk-error="metricsDiskError"
            />

            <ServicesTab
                v-show="activeTab === 'services'"
                :services="nodeData.services"
                :pending="pending"
                @toggle="toggleService"
                @restart="restartService"
                @logs="viewLogs"
                @edit="editService"
            />

            <UpdatesTab v-show="activeTab === 'updates'" :node-data="nodeData" @refresh="() => load(true)" />

            <ValidatorsTab v-show="activeTab === 'validators'" :services="nodeData.services" />
        </template>
    </div>
</template>

<script setup>
import { useRouter, useRoute } from 'vue-router'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useNodesStore } from '@stores/useNodes'
import { useTasksStore } from '@stores/useTasks'
import { useNodeMetrics } from '@renderer/composables/useNodeMetrics'
import NodeMetrics from './NodeMetrics.vue'
import ServicesTab from './ServicesTab.vue'
import UpdatesTab from './UpdatesTab.vue'
import ValidatorsTab from './ValidatorsTab.vue'
const router = useRouter()
const route = useRoute()
const store = useNodesStore()
const tasks = useTasksStore()

const {
    system: metricsSystem,
    clients: metricsClients,
    disk: metricsDisk,
    systemError: metricsSystemError,
    clientsError: metricsClientsError,
    diskError: metricsDiskError,
    start: startMetrics,
    stop: stopMetrics,
} = useNodeMetrics(() => route.params.id, {
    // Only poll while the Metrics tab is open - the disk `du` + client probes are heavy.
    shouldPoll: () => activeTab.value === 'metrics' && nodeData.value && !loading.value && !store.isDisconnected(route.params.id),
})

// Validators is reserved for the upcoming key-management work.
const tabs = [
    { id: 'services', label: 'Services' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'updates', label: 'Updates' },
    { id: 'validators', label: 'Validators', disabled: true },
]
const activeTab = ref('services')

watch(activeTab, (tab) => {
    if (tab === 'metrics') startMetrics()
    else stopMetrics()
})

const nodeData = ref(null)
const loading = ref(true)
const error = ref(false)
const pending = reactive(new Set())

const nodeStatus = computed(() => {
    const n = store.nodes.find(n => n.id === route.params.id)
    return n?.status
})
const disconnected = computed(() => nodeStatus.value === 'disconnected')
const reconnecting = computed(() => nodeStatus.value === 'reconnecting')
const nodeHost = computed(() => store.nodes.find(n => n.id === route.params.id)?.host)

async function load(force = false) {
    loading.value = true
    error.value = false
    const result = await (force ? store.refreshNode(route.params.id) : store.getNode(route.params.id))
    if (!result) {
        error.value = !store.isDisconnected(route.params.id)
    } else {
        nodeData.value = result
    }
    loading.value = false
}

function refresh() {
    load(true)
}

function editService(serviceId) {
    router.push({ name: 'ServiceConfig', params: { id: route.params.id, serviceId } })
}

function viewLogs(serviceId) {
    router.push({ name: 'ServiceLogs', params: { id: route.params.id, serviceId } })
}

function isRunning(service) {
    return service.container?.state === 'running' || service.container?.state === 'restarting'
}

async function refreshContainerStatuses() {
    const statuses = await window.api.invoke('get-container-statuses', route.params.id)
    for (const service of nodeData.value.services) {
        service.container = statuses[service.id] ?? null
    }
}

async function toggleService(service) {
    const serviceId = service.id
    pending.add(serviceId)
    try {
        const taskId = await tasks.runNodeTask(route.params.id, isRunning(service) ? 'stop-service' : 'start-service', [serviceId])
        await tasks.awaitTask(taskId)
        await refreshContainerStatuses()
    } finally {
        pending.delete(serviceId)
    }
}

async function restartService(service) {
    const serviceId = service.id
    pending.add(serviceId)
    try {
        const taskId = await tasks.runNodeTask(route.params.id, 'restart-service', [serviceId])
        await tasks.awaitTask(taskId)
        await refreshContainerStatuses()
    } finally {
        pending.delete(serviceId)
    }
}

async function disconnect() {
    await store.disconnectNode(route.params.id)
    router.push('/')
}

// Copy hostname / IP from the header.
const copied = ref(null)
let copiedTimer = null
async function copy(text, key) {
    if (!text) return
    try {
        await navigator.clipboard.writeText(text)
    } catch {
        // fallback for contexts where the async clipboard API is unavailable
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch { /* ignore */ }
        document.body.removeChild(ta)
    }
    copied.value = key
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { if (copied.value === key) copied.value = null }, 1500)
}

let statusInterval = null

onMounted(async () => {
    await load()
    // The tab watch doesn't fire on the initial value, so start pollers here if Metrics is already active.
    if (activeTab.value === 'metrics') startMetrics()
    statusInterval = setInterval(async () => {
        if (nodeData.value && !loading.value && !store.isDisconnected(route.params.id)) {
            await refreshContainerStatuses()
        }
    }, 10_000)
})

onUnmounted(() => {
    clearInterval(statusInterval)
    stopMetrics()
    clearTimeout(copiedTimer)
})
</script>

<style scoped>
.node-view {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    padding: 32px 40px;
    gap: 24px;
    overflow-y: auto;
    position: relative;
}

.tab-bar {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--ev-c-gray-2);
    margin-top: calc(-1 * var(--space-2));
}
.tab {
    padding: var(--space-3) var(--space-4);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--ev-c-text-2);
    font-size: var(--font-size-button);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: color var(--transition-fast), border-color var(--transition-fast);
}
.tab:hover:not(:disabled) {
    color: var(--ev-c-text-1);
}
.tab.active {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
}
.tab:disabled {
    color: var(--ev-c-text-3);
    cursor: not-allowed;
}

.loading-scrim {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
    border-radius: inherit;
}

.loading-spinner {
    width: 24px;
    height: 24px;
    border: 3px solid rgba(148, 197, 204, 0.3);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
}
.loading-spinner.inline {
    width: 14px;
    height: 14px;
    border-width: 2px;
    display: inline-block;
    vertical-align: middle;
    margin-right: 8px;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.top-bar-actions {
    display: flex;
    gap: 8px;
}

.btn-danger {
    padding: 7px 14px;
    background-color: transparent;
    color: var(--color-danger);
    border: 1px solid var(--color-danger);
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background-color 150ms;
}
.btn-danger:hover:not(:disabled) { background-color: var(--color-danger-soft); }
.btn-danger:disabled { opacity: 0.5; cursor: default; }

.btn-ghost {
    padding: 7px 14px;
    background-color: transparent;
    color: var(--ev-c-text-2);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    transition: background-color 150ms, border-color 150ms;
}
.btn-ghost:hover:not(:disabled) { background-color: var(--ev-c-gray-3); }
.btn-ghost:disabled { opacity: 0.5; cursor: default; }

.btn-accent {
    padding: 7px 14px;
    background-color: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background-color 150ms, opacity 150ms;
}
.btn-accent:hover:not(:disabled) { background-color: var(--color-accent-hover); }
.btn-accent:disabled { opacity: 0.5; cursor: default; }

.node-header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 20px 24px;
    background-color: var(--color-background-soft);
    border-radius: 12px;
}

.node-name {
    font-size: 22px;
    font-weight: 700;
    color: var(--ev-c-text-1);
}

.node-meta {
    display: flex;
    align-items: center;
    gap: 8px;
}

.meta-tag {
    font-size: 12px;
    color: var(--ev-c-text-3);
    background-color: var(--ev-c-gray-3);
    padding: 3px 8px;
    border-radius: 4px;
    font-family: var(--font-mono);
}

/* Click-to-copy affordances (hostname on the title, IP on the host chip). */
.copyable {
    cursor: pointer;
    border: none;
    transition: color var(--transition-fast), background-color var(--transition-fast);
}
h1.node-name.copyable {
    background: none;
    padding: 0;
    align-self: flex-start;
}
.node-name.copyable:hover { color: var(--color-accent); }
button.meta-tag.copyable {
    font-family: var(--font-mono);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
}
button.meta-tag.copyable:hover { background-color: var(--ev-c-gray-2); color: var(--ev-c-text-2); }
.copied-flag {
    font-family: var(--font-sans);
    font-size: var(--font-size-meta);
    font-weight: var(--font-weight-medium);
    color: var(--color-success);
    margin-left: var(--space-2);
}

.state-message {
    color: var(--ev-c-text-2);
    font-size: 14px;
    text-align: center;
    padding: 40px;
}
.state-message.error { color: var(--color-danger); }
</style>
