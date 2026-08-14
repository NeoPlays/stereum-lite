<template>
    <div class="modal-overlay" @click.self="maybeClose">
        <div class="modal" role="dialog" aria-modal="true">
            <header class="modal-header">
                <h3 class="modal-title">{{ stage === 'done' ? 'Keys removed' : 'Remove validator keys' }}</h3>
                <button v-if="stage !== 'saving'" class="icon-btn" aria-label="Close" @click="maybeClose">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </header>

            <div class="modal-body">
                <!-- 1. Confirm -->
                <template v-if="stage === 'confirm'">
                    <p class="danger-line">
                        This removes <strong>{{ pubkeys.length }}</strong>
                        {{ pubkeys.length === 1 ? 'key' : 'keys' }} from <span class="mono">{{ clientName }}</span>.
                        That client stops signing for them immediately.
                    </p>

                    <!-- The single most common misunderstanding: removal is not an exit. -->
                    <div class="notice-block">
                        <p><strong>This does not exit the validator.</strong> It stays active on chain and
                        keeps being assigned duties. If no other client is signing for these keys, it will
                        miss attestations and lose balance until it is exited or the keys run somewhere else.</p>
                    </div>

                    <div class="notice-block">
                        <p><strong>You will be asked to save a slashing protection file.</strong> It records
                        what these keys have already signed and is the only copy. Importing these keys
                        anywhere without it risks a slashing.</p>
                    </div>

                    <label class="ack">
                        <input v-model="acknowledged" type="checkbox" />
                        <span>I understand this client will stop signing for these keys.</span>
                    </label>

                    <p v-if="error" class="error-line">{{ error }}</p>
                </template>

                <!-- 2. Running -->
                <template v-else-if="stage === 'removing'">
                    <p class="progress-line">Removing keys and collecting their signing history…</p>
                </template>

                <!-- 3. Save the protection record. Deliberately blocking: the delete has already
                     happened, and this data cannot be reconstructed from anywhere else. -->
                <template v-else-if="stage === 'saving'">
                    <p class="danger-line">
                        The keys were removed. Save the slashing protection record now.
                    </p>
                    <p class="sub-line">
                        Without this file these keys cannot be safely imported anywhere again.
                    </p>
                    <p v-if="saveError" class="error-line">{{ saveError }}</p>
                    <p v-if="saveError" class="sub-line">
                        Nothing is lost if you retry: repeating the removal returns the same record.
                    </p>
                </template>

                <!-- 4. Outcome -->
                <template v-else>
                    <p class="ok-line">
                        Saved to <span class="mono">{{ savedPath }}</span>
                    </p>
                    <div class="result-summary">
                        <span>{{ removedCount }} of {{ pubkeys.length }} removed</span>
                    </div>
                    <ul v-if="problems.length" class="problem-list">
                        <li v-for="p in problems" :key="p.pubkey" :class="p.severity">
                            <span class="mono">{{ shortKey(p.pubkey) }}</span>
                            <span class="problem-text">{{ p.text }}</span>
                        </li>
                    </ul>
                    <p v-if="!complete" class="warn-line">
                        The saved file does not cover every key requested. Treat it as partial.
                    </p>
                </template>
            </div>

            <footer class="modal-footer">
                <button v-if="stage === 'confirm'" class="btn-ghost" @click="emit('close')">Cancel</button>
                <button v-if="stage === 'confirm'" class="btn-danger" :disabled="!acknowledged" @click="remove">
                    Remove {{ pubkeys.length }} {{ pubkeys.length === 1 ? 'key' : 'keys' }}
                </button>

                <button v-if="stage === 'saving'" class="btn-accent" @click="save">
                    {{ saveError ? 'Try again' : 'Save protection file' }}
                </button>

                <button v-if="stage === 'done'" class="btn-ghost" @click="emit('close')">Close</button>
            </footer>
        </div>
    </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
    pubkeys: { type: Array, default: () => [] },
    clientName: { type: String, default: '' },
})
const emit = defineEmits(['close', 'remove', 'save'])

const stage = ref('confirm')     // confirm -> removing -> saving -> done
const acknowledged = ref(false)
const error = ref('')
const saveError = ref('')
const savedPath = ref('')
const results = ref([])
const protection = ref('')
const complete = ref(true)

const removedCount = computed(() => results.value.filter((r) => r.status === 'deleted' || r.status === 'not_active').length)

// Distinguish the two bad outcomes: a key the client never had (no history in the file) from a
// key it could not stop (which may still be signing - the dangerous one).
const problems = computed(() => results.value.flatMap((r) => {
    if (r.status === 'error') return [{ pubkey: r.pubkey, severity: 'bad', text: r.message || 'Could not be stopped - may still be signing' }]
    if (r.status === 'not_found') return [{ pubkey: r.pubkey, severity: 'warn', text: 'Not held by this client - no history saved' }]
    return []
}))

function shortKey(pubkey) {
    return pubkey && pubkey.length > 20 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey
}

// Closing mid-save would strand the only copy of the protection data, so it is refused.
function maybeClose() {
    if (stage.value !== 'saving') emit('close')
}

async function remove() {
    stage.value = 'removing'
    error.value = ''
    const res = await new Promise((resolve) => emit('remove', { done: resolve }))
    if (!res?.ok) {
        stage.value = 'confirm'
        error.value = res?.error || 'The removal failed'
        return
    }
    results.value = res.results || []
    protection.value = res.slashingProtection || ''
    complete.value = res.complete !== false
    // No protection data at all means nothing to save (e.g. every key was not_found).
    if (!protection.value) { stage.value = 'done'; savedPath.value = 'not provided by the client'; return }
    stage.value = 'saving'
    save()
}

async function save() {
    saveError.value = ''
    const res = await new Promise((resolve) => emit('save', { content: protection.value, done: resolve }))
    if (res?.ok) {
        savedPath.value = res.path
        stage.value = 'done'
    } else {
        saveError.value = res?.canceled ? 'Saving was cancelled. This file is the only copy.' : (res?.error || 'Could not save the file')
    }
}
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
    width: 560px;
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
.danger-line { font-size: var(--font-size-body); color: var(--ev-c-text-1); line-height: 1.6; }
.sub-line { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.6; }
.progress-line { font-size: var(--font-size-body); color: var(--ev-c-text-2); }
.ok-line { font-size: var(--font-size-body); color: var(--color-success); word-break: break-all; }
.warn-line { font-size: var(--font-size-secondary); color: var(--color-warning); }

.notice-block {
    padding: var(--space-4);
    background-color: var(--color-background-mute);
    border-left: 2px solid var(--color-warning);
    border-radius: var(--radius-md);
}
.notice-block p { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.6; }
.notice-block strong { color: var(--ev-c-text-1); }

.ack { display: flex; align-items: flex-start; gap: var(--space-3); font-size: var(--font-size-secondary); color: var(--ev-c-text-1); cursor: pointer; }
.ack input { margin-top: 2px; }

.error-line { font-size: var(--font-size-secondary); color: var(--color-danger); }
.result-summary { font-size: var(--font-size-body); color: var(--ev-c-text-1); }
.problem-list {
    display: flex; flex-direction: column; gap: var(--space-2);
    max-height: 220px; overflow-y: auto;
    margin: 0; padding: var(--space-3);
    list-style: none;
    background-color: var(--color-background-mute);
    border-radius: var(--radius-md);
}
.problem-list li { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--font-size-meta); }
.problem-list li.bad .problem-text { color: var(--color-danger); }
.problem-list li.warn .problem-text { color: var(--color-warning); }
.problem-text { text-align: right; }

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-6);
    border-top: 1px solid var(--ev-c-gray-3);
}
.btn-ghost, .btn-accent, .btn-danger {
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
.btn-accent:hover { background-color: var(--color-accent-hover); }
.btn-danger { background-color: transparent; border: 1px solid var(--color-danger-border); color: var(--color-danger); }
.btn-danger:hover:not(:disabled) { background-color: var(--color-danger-soft); }
.btn-danger:disabled { opacity: 0.45; cursor: default; }
</style>
