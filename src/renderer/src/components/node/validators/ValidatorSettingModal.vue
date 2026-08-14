<template>
    <div class="modal-overlay" @click.self="emit('close')">
        <div class="modal" role="dialog" aria-modal="true">
            <header class="modal-header">
                <h3 class="modal-title">{{ isGraffiti ? 'Set graffiti' : 'Set fee recipient' }}</h3>
                <button class="icon-btn" aria-label="Close" @click="emit('close')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </header>

            <div class="modal-body">
                <p class="scope-line">
                    Applies to <strong>{{ pubkeys.length }}</strong>
                    {{ pubkeys.length === 1 ? 'validator key' : 'validator keys' }}
                    on <span class="mono">{{ clientName }}</span>.
                </p>
                <p v-if="pubkeys.length === 1" class="single-key mono">{{ shortKey(pubkeys[0]) }}</p>

                <template v-if="!results">
                    <div class="mode-row">
                        <button class="mode" :class="{ active: mode === 'set' }" @click="mode = 'set'">Set a value</button>
                        <button class="mode" :class="{ active: mode === 'clear' }" @click="mode = 'clear'">Restore client default</button>
                    </div>

                    <template v-if="mode === 'set'">
                        <label class="field-label" :for="inputId">{{ isGraffiti ? 'Graffiti' : 'Execution address' }}</label>
                        <input
                            :id="inputId"
                            ref="inputEl"
                            v-model="value"
                            class="value-input mono"
                            type="text"
                            :placeholder="isGraffiti ? 'stereum' : '0x0000000000000000000000000000000000000000'"
                            autocomplete="off"
                            spellcheck="false"
                            @keydown.enter="apply"
                        />
                        <div class="hint-row">
                            <span v-if="isGraffiti" class="hint" :class="{ bad: byteLength > 32 }">
                                {{ byteLength }} / 32 bytes
                            </span>
                            <span v-else class="hint">20-byte address the block rewards are paid to</span>
                            <span v-if="validationError" class="hint bad">{{ validationError }}</span>
                        </div>
                    </template>

                    <p v-else class="clear-note">
                        Removes the per-key override. These keys fall back to whatever default the client
                        was started with. This does not set an empty or zero value.
                    </p>

                    <p v-if="error" class="error-line">{{ error }}</p>
                </template>

                <!-- Per-key outcome. The keymanager reports each key independently, so a partial
                     success is normal and must be shown as such rather than as one verdict. -->
                <template v-else>
                    <div class="result-summary" :class="{ allgood: failed.length === 0 }">
                        <span class="result-count">{{ succeeded }} of {{ pubkeys.length }} updated</span>
                        <span v-if="failed.length" class="result-failed">{{ failed.length }} failed</span>
                    </div>
                    <ul v-if="failed.length" class="fail-list">
                        <li v-for="f in failed" :key="f.pubkey">
                            <span class="mono">{{ shortKey(f.pubkey) }}</span>
                            <span class="fail-reason">{{ f.error }}</span>
                        </li>
                    </ul>
                </template>
            </div>

            <footer class="modal-footer">
                <button class="btn-ghost" @click="emit('close')">{{ results ? 'Close' : 'Cancel' }}</button>
                <button v-if="!results" class="btn-accent" :disabled="!canApply" @click="apply">
                    {{ busy ? 'Applying…' : mode === 'clear' ? 'Restore default' : 'Apply' }}
                </button>
            </footer>
        </div>
    </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'

const props = defineProps({
    kind: { type: String, required: true },        // 'feeRecipient' | 'graffiti'
    pubkeys: { type: Array, default: () => [] },
    clientName: { type: String, default: '' },
    current: { type: String, default: '' },        // pre-fill when editing a single key
})
const emit = defineEmits(['close', 'apply'])

const isGraffiti = computed(() => props.kind === 'graffiti')
const inputId = computed(() => `validator-setting-${props.kind}`)

const mode = ref('set')
const value = ref(props.current || '')
const busy = ref(false)
const error = ref('')
const results = ref(null)
const inputEl = ref(null)

// Graffiti is capped at 32 BYTES on chain, not 32 characters - an emoji costs four. TextEncoder
// is the browser-side equivalent of the Buffer.byteLength check the main process enforces.
const byteLength = computed(() => new TextEncoder().encode(value.value).length)

const validationError = computed(() => {
    if (mode.value !== 'set' || !value.value) return ''
    if (isGraffiti.value) return byteLength.value > 32 ? 'Too long' : ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(value.value.trim())) return 'Not a valid address'
    if (value.value.trim().toLowerCase() === '0x' + '0'.repeat(40)) return 'Cannot be the zero address'
    return ''
})

const canApply = computed(() => {
    if (busy.value || !props.pubkeys.length) return false
    if (mode.value === 'clear') return true
    return Boolean(value.value) && !validationError.value
})

const succeeded = computed(() => (results.value ? Object.values(results.value).filter((r) => r.ok).length : 0))
const failed = computed(() => (results.value
    ? Object.entries(results.value).filter(([, r]) => !r.ok).map(([pubkey, r]) => ({ pubkey, error: r.error || 'Failed' }))
    : []))

function shortKey(pubkey) {
    return pubkey && pubkey.length > 20 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey
}

async function apply() {
    if (!canApply.value) return
    busy.value = true
    error.value = ''
    // null is the wire value for "clear the override"; an empty string would be a real value.
    const payload = mode.value === 'clear' ? null : value.value.trim()
    const res = await new Promise((resolve) => emit('apply', { value: payload, done: resolve }))
    busy.value = false
    if (res?.ok) results.value = res.results || {}
    else error.value = res?.error || 'The update failed'
}

onMounted(() => nextTick(() => inputEl.value?.focus()))
</script>

<style scoped>
.modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 320;
    background-color: var(--scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
}
.modal {
    width: 520px;
    max-width: 100%;
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    background-color: var(--color-background-soft);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-xl);
    overflow: hidden;
}
.modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-6);
    border-bottom: 1px solid var(--ev-c-gray-3);
}
.modal-title { font-size: var(--font-size-title); font-weight: var(--font-weight-semibold); color: var(--ev-c-text-1); }
.icon-btn {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: var(--radius-md);
    color: var(--ev-c-text-2); cursor: pointer;
    transition: background-color var(--transition-fast);
}
.icon-btn:hover { background-color: var(--ev-c-gray-3); }

.modal-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-6);
    overflow-y: auto;
}
.scope-line { font-size: var(--font-size-body); color: var(--ev-c-text-2); }
.scope-line strong { color: var(--ev-c-text-1); }
.single-key { font-size: var(--font-size-secondary); color: var(--ev-c-text-3); }

.mode-row { display: flex; gap: var(--space-2); }
.mode {
    flex: 1;
    padding: var(--button-padding);
    background-color: var(--color-background-mute);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-md);
    color: var(--ev-c-text-2);
    font-size: var(--font-size-button);
    cursor: pointer;
    transition: background-color var(--transition-fast), color var(--transition-fast);
}
.mode:hover { color: var(--ev-c-text-1); }
.mode.active { background-color: var(--color-accent-wash); border-color: var(--color-accent-border); color: var(--ev-c-text-1); }

.field-label { font-size: var(--font-size-meta); text-transform: uppercase; letter-spacing: 0.05em; color: var(--ev-c-text-3); }
.value-input {
    width: 100%;
    padding: 9px 11px;
    background-color: var(--color-background);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-md);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-secondary);
}
.value-input:focus { outline: none; border-color: var(--color-accent); }

.hint-row { display: flex; justify-content: space-between; gap: var(--space-3); }
.hint { font-size: var(--font-size-meta); color: var(--ev-c-text-3); }
.hint.bad { color: var(--color-danger); }
.clear-note { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.6; }
.error-line { font-size: var(--font-size-secondary); color: var(--color-danger); }

.result-summary { display: flex; align-items: center; gap: var(--space-3); font-size: var(--font-size-body); }
.result-count { color: var(--ev-c-text-1); font-weight: var(--font-weight-medium); }
.result-summary.allgood .result-count { color: var(--color-success); }
.result-failed { color: var(--color-danger); font-size: var(--font-size-secondary); }
.fail-list {
    display: flex; flex-direction: column; gap: var(--space-2);
    max-height: 220px; overflow-y: auto;
    margin: 0; padding: var(--space-3);
    list-style: none;
    background-color: var(--color-background-mute);
    border-radius: var(--radius-md);
}
.fail-list li { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--font-size-meta); }
.fail-reason { color: var(--color-danger); text-align: right; }

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-6);
    border-top: 1px solid var(--ev-c-gray-3);
}
.btn-ghost, .btn-accent {
    padding: var(--button-padding);
    border-radius: var(--radius-lg);
    font-size: var(--font-size-button);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.btn-ghost { background-color: transparent; border: 1px solid var(--ev-c-gray-2); color: var(--ev-c-text-1); }
.btn-ghost:hover { background-color: var(--ev-c-gray-3); }
.btn-accent { background-color: var(--color-accent); border: none; color: var(--color-accent-text); font-weight: var(--font-weight-semibold); }
.btn-accent:hover:not(:disabled) { background-color: var(--color-accent-hover); }
.btn-accent:disabled { opacity: 0.5; cursor: default; }
</style>
