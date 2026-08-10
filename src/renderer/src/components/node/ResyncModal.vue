<template>
    <div class="modal-overlay" @click.self="emit('close')">
        <div class="modal" role="dialog" aria-modal="true">
            <header class="modal-header">
                <h3 class="modal-title">Resync {{ shortName }}</h3>
                <button class="icon-btn" aria-label="Close" @click="emit('close')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </header>

            <div class="modal-body">
                <p class="warn">
                    This permanently deletes all chain data for this service and re-syncs it from scratch.
                    The service will be stopped, its data directory wiped, then restarted.
                </p>
                <p class="service-id mono">{{ service.id }}</p>

                <template v-if="isConsensus">
                    <label class="field-label" for="resync-source">Checkpoint sync source</label>
                    <select id="resync-source" v-model="selection" class="source-select" @change="onSelectionChange">
                        <option value="genesis">Genesis - sync from block 0 (slow)</option>
                        <optgroup v-if="providers.length" :label="`Checkpoint providers · ${networkLabel}`">
                            <option v-for="p in providers" :key="p.url" :value="p.url">{{ p.name }}</option>
                        </optgroup>
                        <option value="custom">Custom URL…</option>
                    </select>

                    <input
                        v-if="selection === 'custom'"
                        v-model.trim="customUrl"
                        class="url-input mono"
                        type="text"
                        placeholder="https://checkpoint.example.com"
                        autocomplete="off"
                        spellcheck="false"
                        @keydown.enter="runCheck"
                    />

                    <!-- Genesis needs no endpoint; a checkpoint must pass the liveness check first. -->
                    <div v-if="isCheckpoint" class="check-row">
                        <button class="btn-check" :disabled="checkState === 'checking'" @click="runCheck">
                            {{ checkState === 'checking' ? 'Checking…' : checkState === 'valid' ? 'Re-check' : 'Check endpoint' }}
                        </button>
                        <span class="check-status" :class="checkState">
                            <template v-if="checkState === 'valid'">✓ Reachable (HTTP 200)</template>
                            <template v-else-if="checkState === 'invalid'">✗ {{ checkError }}</template>
                            <template v-else-if="checkState === 'checking'">Validating source on the node…</template>
                            <template v-else>Not checked yet</template>
                        </span>
                    </div>
                    <p v-if="effectiveUrl" class="hint mono">{{ effectiveUrl }}</p>
                    <p class="hint">
                        {{ isCheckpoint
                            ? 'Fast-syncs from this source. It must pass the check before you can resync.'
                            : 'Genesis sync replays every block from 0 - reliable but can take hours to days.' }}
                    </p>
                </template>
                <p v-else class="hint">Execution clients resync from genesis. This can take a long time.</p>
            </div>

            <footer class="modal-footer">
                <button class="btn-ghost" @click="emit('close')">Cancel</button>
                <button class="btn-danger" :disabled="!canResync" @click="confirm">Resync</button>
            </footer>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { providersForNetwork } from '@renderer/utils/checkpointProviders'

const props = defineProps({
    service: { type: Object, required: true },
    nodeId: { type: [String, Number], required: true },
})
const emit = defineEmits(['close', 'confirm'])

// 'genesis' | a provider URL | 'custom'. Genesis is the safe default (no endpoint to trust).
const selection = ref('genesis')
const customUrl = ref('')
const checkState = ref('idle') // 'idle' | 'checking' | 'valid' | 'invalid'
const checkError = ref('')
const checkedUrl = ref(null)   // the URL that last passed the check, so editing invalidates it

// supportsCheckpoint is set on the service DTO from the main process (resync.js) - true for
// consensus clients, the only ones that take a checkpoint-sync URL.
const isConsensus = computed(() => props.service.supportsCheckpoint === true)
const shortName = computed(() => (props.service.config?.service ?? props.service.id).replace(/Service$/, ''))
const networkLabel = computed(() => props.service.config?.network || 'network')
const providers = computed(() => providersForNetwork(props.service.config?.network))

const isCheckpoint = computed(() => selection.value !== 'genesis')
// The URL a checkpoint resync would use (null for genesis / an empty custom field).
const effectiveUrl = computed(() => {
    if (selection.value === 'genesis') return null
    if (selection.value === 'custom') return customUrl.value || null
    return selection.value
})
// Genesis can always proceed; a checkpoint must have passed the check for the exact URL in play.
const canResync = computed(() =>
    !isCheckpoint.value || (checkState.value === 'valid' && checkedUrl.value === effectiveUrl.value))

// Any change to the chosen source invalidates a prior check.
watch([selection, customUrl], () => {
    if (checkedUrl.value !== effectiveUrl.value) { checkState.value = 'idle'; checkError.value = '' }
})

// Picking a provider from the list auto-validates (custom URLs check on button / Enter).
function onSelectionChange() {
    if (isCheckpoint.value && selection.value !== 'custom') runCheck()
}

async function runCheck() {
    const url = effectiveUrl.value
    if (!url) { checkState.value = 'invalid'; checkError.value = 'Enter a URL first'; return }
    checkState.value = 'checking'
    checkError.value = ''
    try {
        const res = await window.api.invoke('check-checkpoint-sync', props.nodeId, url)
        if (res?.ok) {
            checkState.value = 'valid'
            checkedUrl.value = url
        } else {
            checkState.value = 'invalid'
            checkError.value = res?.error || 'Endpoint check failed'
        }
    } catch (e) {
        checkState.value = 'invalid'
        checkError.value = e?.message || 'Endpoint check failed'
    }
}

// Esc closes from anywhere in the modal (the overlay div can't hold focus itself).
function onKey(e) { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

function confirm() {
    if (!canResync.value) return
    emit('confirm', isConsensus.value ? effectiveUrl.value : null)
}
</script>

<style scoped>
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
    width: min(480px, 92vw);
    background-color: var(--color-background-soft);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-xl);
    overflow: hidden;
}
.modal-header {
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
}
.icon-btn {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    color: var(--ev-c-text-2);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.icon-btn:hover { background-color: var(--ev-c-gray-3); }

.modal-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
}
.warn {
    font-size: var(--font-size-body);
    color: var(--ev-c-text-1);
    line-height: 1.5;
}
.service-id {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
    word-break: break-all;
}
.field-label {
    margin-top: var(--space-2);
    font-size: var(--font-size-secondary);
    color: var(--ev-c-text-2);
}
.optional { color: var(--ev-c-text-3); }
.url-input {
    padding: var(--button-padding);
    background-color: var(--color-background-mute);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-md);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-secondary);
}
.url-input:focus {
    outline: none;
    border-color: var(--color-accent);
}
.hint {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
    word-break: break-all;
}
.source-select {
    padding: var(--button-padding);
    background-color: var(--color-background-mute);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-md);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-secondary);
    cursor: pointer;
}
.source-select:focus { outline: none; border-color: var(--color-accent); }

.check-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
}
.btn-check {
    flex-shrink: 0;
    padding: var(--button-padding-small);
    background: transparent;
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-md);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-secondary);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.btn-check:hover:not(:disabled) { background-color: var(--ev-c-gray-3); }
.btn-check:disabled { opacity: 0.5; cursor: default; }
.check-status {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
}
.check-status.valid { color: var(--color-success); }
.check-status.invalid { color: var(--color-danger); }
.check-status.checking { color: var(--color-warning); }

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--ev-c-gray-3);
}
.btn-ghost {
    padding: var(--button-padding);
    background: transparent;
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-lg);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-button);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.btn-ghost:hover { background-color: var(--ev-c-gray-3); }
.btn-danger {
    padding: var(--button-padding);
    background: transparent;
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-lg);
    color: var(--color-danger);
    font-size: var(--font-size-button);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.btn-danger:hover:not(:disabled) { background-color: var(--color-danger-soft); }
.btn-danger:disabled { opacity: 0.4; cursor: default; }
</style>
