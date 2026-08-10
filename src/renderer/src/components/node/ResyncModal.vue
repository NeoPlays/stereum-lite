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
                    <label class="field-label" for="resync-checkpoint">Checkpoint sync URL <span class="optional">(optional)</span></label>
                    <input
                        id="resync-checkpoint"
                        v-model.trim="checkpointUrl"
                        class="url-input mono"
                        type="text"
                        placeholder="https://checkpoint.example.com"
                        autocomplete="off"
                        spellcheck="false"
                        @keydown.enter="confirm"
                    />
                    <p v-if="urlError" class="url-error">Enter a valid http(s) URL, or leave empty for a genesis resync.</p>
                    <p v-else class="hint">
                        {{ checkpointUrl ? 'Fast-syncs from this checkpoint source.' : 'Empty = slower genesis sync from block 0.' }}
                    </p>
                </template>
                <p v-else class="hint">Execution clients resync from genesis. This can take a long time.</p>
            </div>

            <footer class="modal-footer">
                <button class="btn-ghost" @click="emit('close')">Cancel</button>
                <button class="btn-danger" @click="confirm">Resync</button>
            </footer>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
    service: { type: Object, required: true },
})
const emit = defineEmits(['close', 'confirm'])

const checkpointUrl = ref('')
const urlError = ref(false)

// Clear the validation message as soon as the user edits the field.
watch(checkpointUrl, () => { urlError.value = false })

// Esc closes from anywhere in the modal (the overlay div can't hold focus itself).
function onKey(e) { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

// supportsCheckpoint is set on the service DTO from the main process (resync.js) - true for
// consensus clients, which take an optional checkpoint-sync URL.
const isConsensus = computed(() => props.service.supportsCheckpoint === true)
const shortName = computed(() => (props.service.config?.service ?? props.service.id).replace(/Service$/, ''))

function confirm() {
    const url = checkpointUrl.value || null
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
        urlError.value = true
        return
    }
    emit('confirm', isConsensus.value ? url : null)
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
}
.url-error {
    font-size: var(--font-size-meta);
    color: var(--color-danger);
}

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
.btn-danger:hover { background-color: var(--color-danger-soft); }
</style>
