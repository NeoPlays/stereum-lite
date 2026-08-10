<template>
    <div class="services-tab">
        <div v-if="services?.length === 0" class="state-message">No services found.</div>

        <SetupGroups :services="services">
            <template #default="{ service }">
                    <div class="service-card" :class="{ highlighted: highlightedId === service.id }">
                        <div class="service-header">
                        <div class="service-main">
                            <span class="service-name">{{ service.config?.service ?? service.id }}</span>
                            <span class="service-network" v-if="!service.setup && service.config?.network">{{ service.config.network }}</span>
                            <span v-if="service.container" class="container-status" :class="service.container.state">
                                <span class="status-dot"></span>{{ service.container.status }}
                            </span>
                            <span v-else class="container-status unknown">
                                <span class="status-dot"></span>unknown
                            </span>
                        </div>
                        <div class="service-actions">
                            <div class="action-cluster">
                                <button
                                    class="btn-service-action"
                                    :class="isRunning(service) ? 'btn-stop' : 'btn-start'"
                                    @click="emit('toggle', service)"
                                    :disabled="pending.has(service.id)"
                                >
                                    {{ pending.has(service.id) ? '…' : isRunning(service) ? 'Stop' : 'Start' }}
                                </button>
                                <button
                                    v-if="isRunning(service)"
                                    class="btn-service-action btn-restart"
                                    @click="emit('restart', service)"
                                    :disabled="pending.has(service.id)"
                                >
                                    {{ pending.has(service.id) ? '…' : 'Restart' }}
                                </button>
                            </div>
                            <div class="action-cluster action-cluster-utility">
                                <button
                                    v-if="service.resyncable"
                                    class="btn-service-action btn-resync"
                                    @click="emit('resync', service)"
                                    :disabled="pending.has(service.id)"
                                >
                                    Resync
                                </button>
                                <button class="btn-service-action btn-utility" @click="emit('logs', service.id)" :disabled="pending.has(service.id)">Logs</button>
                                <button class="btn-service-action btn-utility" @click="emit('edit', service.id)" :disabled="pending.has(service.id)">Edit</button>
                            </div>
                        </div>
                        </div>
                        <div class="service-deps" v-if="depsByService[service.id]?.length">
                            <span class="deps-label">connects to</span>
                            <span
                                class="dep-chip"
                                :class="{ missing: dep.missing }"
                                v-for="dep in depsByService[service.id]"
                                :key="dep.id"
                                @mouseenter="highlightedId = dep.id"
                                @mouseleave="highlightedId = null"
                                :title="dep.missing ? 'Not a service on this node' : ''"
                            >
                                <span class="dep-dot" :style="{ background: CATEGORY_COLOR[dep.category] }"></span>{{ dep.name }}
                            </span>
                        </div>
                        <span class="service-image">
                            <span class="image-label">config</span>
                            <span class="image-value">{{ service.config?.image ?? '-' }}</span>
                        </span>
                        <span v-if="service.container?.image" class="service-image">
                            <span class="image-label">running</span>
                            <span class="image-value">{{ service.container.image }}</span>
                        </span>
                        <span class="service-id">{{ service.id }}</span>
                    </div>
            </template>
        </SetupGroups>
    </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { serviceCategory, CATEGORY_COLOR } from '@renderer/utils/serviceCategory'
import SetupGroups from './SetupGroups.vue'

const props = defineProps({
    services: { type: Array, default: () => [] },
    pending: { type: Object, default: () => new Set() }, // reactive Set of in-flight service ids
})
const emit = defineEmits(['toggle', 'restart', 'resync', 'logs', 'edit'])

// The service each id resolves to (for turning a dependency ref into a name + category).
const serviceById = computed(() => Object.fromEntries(props.services.map((s) => [s.id, s])))

// Outgoing dependencies, flattened across the config.dependencies role buckets;
// `missing` = the dependency isn't a service on this node (e.g. an external client).
const DEP_ROLES = ['executionClients', 'consensusClients', 'validatorClients', 'mevboost', 'otherServices']
function shortName(type) {
    return (type || '').replace(/Service$/, '').replace(/Beacon|Validator/g, '') || type
}
function resolveDeps(service) {
    const deps = service.config?.dependencies
    if (!deps) return []
    const refs = []
    const seen = new Set()
    for (const role of DEP_ROLES) {
        for (const d of deps[role] || []) {
            if (!d?.id || seen.has(d.id)) continue
            seen.add(d.id)
            const target = serviceById.value[d.id]
            const type = target?.config?.service || d.service
            refs.push({ id: d.id, name: shortName(type) || d.id.slice(0, 6), category: serviceCategory(type), missing: !target })
        }
    }
    return refs
}
const depsByService = computed(() => Object.fromEntries(props.services.map((s) => [s.id, resolveDeps(s)])))

// The service card currently highlighted by hovering a dependency chip that points to it.
const highlightedId = ref(null)

function isRunning(service) {
    return service.container?.state === 'running' || service.container?.state === 'restarting'
}
</script>

<style scoped>
.services-tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
}

.service-card {
    display: flex;
    flex-direction: column;
    padding: var(--card-padding);
    background-color: var(--color-background-soft);
    border-radius: var(--radius-xl);
    gap: var(--space-1);
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow var(--transition-fast);
}

/* Name + status on the left, action toolbar on the right. Wraps the toolbar to
   its own line once the card is too narrow to hold both, so nothing overflows. */
.service-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    margin-bottom: var(--space-1);
}
/* Ring shown when another card's "connects to" chip points here. */
.service-card.highlighted {
    box-shadow: 0 0 0 2px var(--color-accent);
}

/* Dependency chips: what this service connects to (EC / CC / mev-boost / ...). */
.service-deps {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-1);
}
.deps-label {
    font-size: var(--font-size-micro);
    color: var(--ev-c-text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.dep-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--chip-padding);
    border-radius: var(--radius-sm);
    background-color: var(--ev-c-gray-3);
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-2);
    cursor: default;
    transition: background-color var(--transition-fast);
}
.dep-chip:hover { background-color: var(--ev-c-gray-2); }
.dep-chip.missing {
    opacity: 0.6;
    text-decoration: line-through;
}
.dep-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
}

.service-main {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    /* Grow to fill the row, but allow shrinking so the toolbar wraps before the
       card overflows; min-width:0 lets the name truncate instead of forcing width. */
    flex: 1 1 180px;
    min-width: 0;
}

.service-name {
    font-size: var(--font-size-title);
    font-weight: var(--font-weight-semibold);
    color: var(--ev-c-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.service-network {
    font-size: var(--font-size-meta);
    padding: var(--chip-padding);
    border-radius: var(--radius-sm);
    background-color: var(--color-accent-soft);
    color: var(--color-accent);
    font-weight: var(--font-weight-medium);
    flex-shrink: 0;
}
.container-status { flex-shrink: 0; }

.service-actions {
    display: flex;
    align-items: center;
    /* Push to the right edge when sharing the header line; wrap its own buttons
       (never overflow) on very narrow cards. */
    margin-left: auto;
    flex-wrap: wrap;
    justify-content: flex-end;
}

/* Two proximity groups: state controls (Start/Stop, Restart) and secondary
   tools (Resync, Logs, Edit), split by a thin divider so the row reads as one
   tidy toolbar rather than a ragged line of mixed-color buttons. */
.action-cluster {
    display: flex;
    gap: var(--space-2);
    align-items: center;
}
.action-cluster-utility {
    margin-left: var(--space-3);
    padding-left: var(--space-3);
    border-left: 1px solid var(--ev-c-gray-2);
}

.btn-service-action {
    padding: var(--button-padding-small);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--font-size-secondary);
    font-weight: var(--font-weight-medium);
    border: 1px solid;
    transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast);
    white-space: nowrap;
    min-width: 52px;
    text-align: center;
}
.btn-service-action:disabled { opacity: 0.4; cursor: default; }

.btn-start {
    background-color: transparent;
    color: var(--color-success);
    border-color: var(--color-success);
}
.btn-start:hover:not(:disabled) { background-color: var(--color-success-soft); }

.btn-stop {
    background-color: transparent;
    color: var(--color-danger);
    border-color: var(--color-danger);
}
.btn-stop:hover:not(:disabled) { background-color: var(--color-danger-soft); }

.btn-restart {
    background-color: transparent;
    color: var(--color-warning);
    border-color: var(--color-warning);
}
.btn-restart:hover:not(:disabled) { background-color: var(--color-warning-soft); }

/* Resync is destructive but not a primary state control, so it sits with the
   secondary tools as a neutral button and only reveals its danger (red) on
   hover - distinct from Stop, which is always red. The ResyncModal confirms. */
.btn-resync {
    background-color: transparent;
    color: var(--ev-c-text-2);
    border-color: var(--ev-c-gray-2);
}
.btn-resync:hover:not(:disabled) {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background-color: var(--color-danger-soft);
}

.btn-utility {
    background-color: transparent;
    color: var(--ev-c-text-2);
    border-color: var(--ev-c-gray-2);
    font-weight: var(--font-weight-normal);
}
.btn-utility:hover:not(:disabled) { background-color: var(--ev-c-gray-3); border-color: var(--ev-c-gray-1); }

.container-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: var(--font-size-secondary);
    color: var(--ev-c-text-2);
}
.status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background-color: var(--ev-c-gray-1);
}
.container-status.running .status-dot { background-color: var(--color-success); }
.container-status.exited .status-dot,
.container-status.dead .status-dot  { background-color: var(--color-danger); }
.container-status.paused .status-dot,
.container-status.restarting .status-dot { background-color: var(--color-warning); }

.service-image {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-secondary);
    color: var(--ev-c-text-2);
    font-family: var(--font-mono);
    min-width: 0;
}
.image-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.image-label {
    font-family: var(--font-sans);
    font-size: var(--font-size-micro);
    color: var(--ev-c-text-3);
    background-color: var(--ev-c-gray-3);
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
}

.service-id {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.state-message {
    color: var(--ev-c-text-2);
    font-size: var(--font-size-body);
    text-align: center;
    padding: var(--space-9);
}
</style>
