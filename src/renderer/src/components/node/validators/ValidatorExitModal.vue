<template>
    <div class="modal-overlay" @click.self="maybeClose">
        <div class="modal" role="dialog" aria-modal="true">
            <header class="modal-header">
                <h3 class="modal-title">{{ stage === 'done' ? 'Exit submitted' : 'Exit validators' }}</h3>
                <button v-if="stage !== 'exiting'" class="icon-btn" aria-label="Close" @click="maybeClose">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </header>

            <div class="modal-body">
                <!-- 1. Preflight -->
                <template v-if="stage === 'checking'">
                    <p class="progress-line">Checking which of these {{ rows.length }} validators can be exited…</p>
                    <p class="sub-line">Nothing has been submitted yet.</p>
                </template>

                <!-- 2. Confirm -->
                <template v-else-if="stage === 'confirm'">
                    <div class="danger-block">
                        <p><strong>A voluntary exit is permanent and cannot be undone.</strong> Once the exit is
                        processed the validator can never be reactivated. These keys will never validate again,
                        on this node or anywhere else.</p>
                    </div>

                    <p v-if="preflightError" class="error-line">{{ preflightError }}</p>

                    <!-- Nothing eligible: no confirmation input, no action button. -->
                    <template v-if="!eligible.length">
                        <p class="danger-line">
                            None of the {{ rows.length }} selected
                            {{ rows.length === 1 ? 'validator' : 'validators' }} can be exited right now.
                        </p>
                        <ul v-if="blocked.length" class="key-list">
                            <li v-for="b in blocked" :key="b.pubkey">
                                <span class="key-id mono">{{ b.index != null ? '#' + b.index : shortKey(b.pubkey) }}</span>
                                <span class="key-reason">{{ b.reasonText }}</span>
                            </li>
                        </ul>
                    </template>

                    <template v-else>
                        <p class="danger-line">
                            This submits a voluntary exit for <strong>{{ eligible.length }}</strong>
                            {{ eligible.length === 1 ? 'validator' : 'validators' }}
                            on <span class="mono">{{ clientName }}</span>
                            <template v-if="network"> ({{ network }})</template>.
                        </p>

                        <ul class="key-list">
                            <li v-for="r in eligible" :key="r.pubkey">
                                <span class="key-id mono">{{ r.index != null ? '#' + r.index : shortKey(r.pubkey) }}</span>
                                <span class="key-meta">
                                    <span class="mono">{{ shortKey(r.pubkey) }}</span>
                                    <span v-if="r.status" class="key-status">{{ r.status }}</span>
                                    <span v-if="r.withdrawalType" class="wpill mono" :class="{ warn: r.withdrawalType === '0x00' }">{{ r.withdrawalType }}</span>
                                </span>
                            </li>
                        </ul>

                        <!-- Blocked keys are shown so the count difference is never silent, but they are
                             not part of the payload - submit() only ever sends eligible pubkeys. -->
                        <div v-if="blocked.length" class="blocked-section">
                            <span class="section-label">
                                {{ blocked.length }} {{ blocked.length === 1 ? 'validator is' : 'validators are' }} excluded
                            </span>
                            <ul class="key-list">
                                <li v-for="b in blocked" :key="b.pubkey">
                                    <span class="key-id mono">{{ b.index != null ? '#' + b.index : shortKey(b.pubkey) }}</span>
                                    <span class="key-reason">{{ b.reasonText }}</span>
                                </li>
                            </ul>
                        </div>

                        <!-- Non-blocking, but the 0x00 case strands the balance, so it must be read before typing. -->
                        <div v-if="warnings.length" class="notice-block">
                            <p v-for="w in warnings" :key="w.text">
                                <strong>{{ w.count }} {{ w.count === 1 ? 'validator' : 'validators' }}:</strong> {{ w.text }}
                            </p>
                        </div>

                        <!-- "Exit validator" and "Stop service" sit next to each other in this app, and
                             stopping the client after submitting is the expensive mistake. -->
                        <div class="notice-block strong">
                            <p><strong>Keep the validator client running after this.</strong> The exit is only queued
                            when you submit it. Each validator stays on duty and must keep attesting until its exit
                            epoch is reached. Stopping the client, the service, or the machine before then means
                            missed duties and lost balance for as long as it is down.</p>
                        </div>

                        <label class="confirm-field" :for="confirmId">
                            <span class="confirm-prompt">
                                Type <strong>{{ eligible.length }}</strong> to confirm you are exiting
                                {{ eligible.length }} {{ eligible.length === 1 ? 'validator' : 'validators' }}.
                            </span>
                            <input
                                :id="confirmId"
                                ref="confirmEl"
                                v-model="typed"
                                class="confirm-input mono"
                                type="text"
                                inputmode="numeric"
                                autocomplete="off"
                                spellcheck="false"
                                :placeholder="String(eligible.length)"
                                @keydown.enter="submit"
                            />
                        </label>

                        <p v-if="error" class="error-line">{{ error }}</p>
                    </template>
                </template>

                <!-- 3. Running -->
                <template v-else-if="stage === 'exiting'">
                    <p class="progress-line">Submitting {{ submitted.length }} voluntary
                        {{ submitted.length === 1 ? 'exit' : 'exits' }} to the beacon node…</p>
                    <p class="sub-line">Leave the validator client running.</p>
                </template>

                <!-- 4. Outcome -->
                <template v-else>
                    <div class="result-summary" :class="{ allgood: failures.length === 0 }">
                        <span class="result-count">{{ successes.length }} of {{ submitted.length }} accepted</span>
                        <span v-if="failures.length" class="result-failed">{{ failures.length }} rejected</span>
                    </div>

                    <!-- The submission is the start of the process, not the end of it. Anything that reads
                         like "done" here is what makes people stop the client too early. -->
                    <div class="notice-block strong">
                        <p><strong>These exits are queued, not complete.</strong> Each one goes into the gossip pool,
                        then into the network's exit queue. Until its exit epoch is reached the validator is still
                        active and still owes attestations. <strong>Do not stop the validator client or its service
                        yet.</strong> Depending on the queue length this can take days.</p>
                    </div>

                    <div v-if="successes.length" class="result-section">
                        <span class="section-label">Accepted by the beacon node</span>
                        <ul class="key-list">
                            <li v-for="s in successes" :key="s.pubkey">
                                <span class="key-id mono">{{ s.index != null ? '#' + s.index : shortKey(s.pubkey) }}</span>
                                <span class="key-ok">queued</span>
                            </li>
                        </ul>
                    </div>

                    <div v-if="failures.length" class="result-section">
                        <span class="section-label">Rejected - still active, not exiting</span>
                        <ul class="key-list">
                            <li v-for="f in failures" :key="f.pubkey">
                                <span class="key-id mono">{{ f.index != null ? '#' + f.index : shortKey(f.pubkey) }}</span>
                                <span class="key-reason bad">{{ f.error }}</span>
                            </li>
                        </ul>
                    </div>
                </template>
            </div>

            <footer class="modal-footer">
                <button v-if="stage === 'checking'" class="btn-ghost" @click="emit('close')">Cancel</button>

                <button v-if="stage === 'confirm'" class="btn-ghost" @click="emit('close')">
                    {{ eligible.length ? 'Cancel' : 'Close' }}
                </button>
                <button v-if="stage === 'confirm' && eligible.length" class="btn-danger" :disabled="!canSubmit" @click="submit">
                    Submit exit for {{ eligible.length }} {{ eligible.length === 1 ? 'validator' : 'validators' }}
                </button>

                <button v-if="stage === 'done'" class="btn-ghost" @click="emit('close')">Close</button>
            </footer>
        </div>
    </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'

const props = defineProps({
    rows: { type: Array, default: () => [] },       // [{ pubkey, index, status, activationEpoch, withdrawalType }]
    clientName: { type: String, default: '' },
    network: { type: String, default: '' },
})
const emit = defineEmits(['close', 'preflight', 'apply'])

const stage = ref('checking')    // checking -> confirm -> exiting -> done
const checks = ref({})
const preflightError = ref('')
const typed = ref('')
const error = ref('')
const submitted = ref([])        // the rows actually sent, frozen at submit time
const results = ref({})
const confirmEl = ref(null)

const confirmId = 'validator-exit-confirm'

// Fail closed: a key is exitable only if the preflight explicitly said so. A missing entry (key not
// in the response, malformed response, partial failure) counts as blocked, never as eligible.
const eligible = computed(() => props.rows.filter((r) => checks.value[r.pubkey]?.eligible === true))

const blocked = computed(() => props.rows
    .filter((r) => checks.value[r.pubkey]?.eligible !== true)
    .map((r) => ({ ...r, reasonText: reasonText(checks.value[r.pubkey]) })))

// Warnings repeat across keys (every 0x00 validator carries the same one), so they are collapsed to
// one line per distinct text with a count - a 200-key list would otherwise bury them.
const warnings = computed(() => {
    const counts = new Map()
    for (const r of eligible.value) {
        for (const w of checks.value[r.pubkey]?.warnings || []) {
            counts.set(w, (counts.get(w) || 0) + 1)
        }
    }
    return [...counts.entries()].map(([text, count]) => ({ text, count }))
})

const canSubmit = computed(() => eligible.value.length > 0 && typed.value.trim() === String(eligible.value.length))

const successes = computed(() => submitted.value.filter((r) => results.value[r.pubkey]?.ok === true))
const failures = computed(() => submitted.value
    .filter((r) => results.value[r.pubkey]?.ok !== true)
    .map((r) => ({ ...r, error: results.value[r.pubkey]?.error || 'No result returned by the beacon node' })))

function reasonText(check) {
    const reasons = check?.reasons || []
    if (reasons.length) return reasons.join(' · ')
    return 'Eligibility could not be confirmed'
}

function shortKey(pubkey) {
    return pubkey && pubkey.length > 20 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey
}

// Closing mid-submit would hide which keys made it to the beacon node, and the requests cannot be
// recalled anyway, so the outcome stage has to be reached.
function maybeClose() {
    if (stage.value !== 'exiting') emit('close')
}

async function preflight() {
    const res = await new Promise((resolve) => emit('preflight', { pubkeys: props.rows.map((r) => r.pubkey), done: resolve }))
    checks.value = res?.ok ? (res.checks || {}) : {}
    preflightError.value = res?.ok ? '' : (res?.error || 'The eligibility check failed, so no validator can be exited from here.')
    stage.value = 'confirm'
    nextTick(() => confirmEl.value?.focus())
}

async function submit() {
    if (!canSubmit.value) return
    submitted.value = eligible.value.slice()
    stage.value = 'exiting'
    error.value = ''
    const res = await new Promise((resolve) => emit('apply', { pubkeys: submitted.value.map((r) => r.pubkey), done: resolve }))
    if (!res?.ok) {
        stage.value = 'confirm'
        typed.value = ''
        error.value = res?.error || 'The submission failed. No exit was sent.'
        return
    }
    results.value = res.results || {}
    stage.value = 'done'
}

onMounted(preflight)
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
    width: 580px;
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
.error-line { font-size: var(--font-size-secondary); color: var(--color-danger); }

.danger-block {
    padding: var(--space-4);
    background-color: var(--color-danger-soft);
    border-left: 3px solid var(--color-danger);
    border-radius: var(--radius-md);
}
.danger-block p { font-size: var(--font-size-secondary); color: var(--ev-c-text-1); line-height: 1.6; }
.danger-block strong { color: var(--color-danger); }

.notice-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    background-color: var(--color-background-mute);
    border-left: 2px solid var(--color-warning);
    border-radius: var(--radius-md);
}
.notice-block p { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.6; }
.notice-block strong { color: var(--ev-c-text-1); }
.notice-block.strong { border-left-width: 3px; }

.section-label {
    font-size: var(--font-size-meta);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ev-c-text-3);
}
.blocked-section, .result-section { display: flex; flex-direction: column; gap: var(--space-2); }

.key-list {
    display: flex; flex-direction: column; gap: var(--space-2);
    max-height: 220px; overflow-y: auto;
    margin: 0; padding: var(--space-3);
    list-style: none;
    background-color: var(--color-background-mute);
    border-radius: var(--radius-md);
}
.key-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); font-size: var(--font-size-meta); }
.key-id { color: var(--ev-c-text-1); flex-shrink: 0; }
.key-meta { display: flex; align-items: center; gap: var(--space-2); color: var(--ev-c-text-3); }
.key-status { color: var(--ev-c-text-2); }
.wpill {
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
    background-color: var(--color-background);
    color: var(--ev-c-text-3);
}
.wpill.warn { color: var(--color-warning); }
.key-reason { color: var(--ev-c-text-2); text-align: right; }
.key-reason.bad { color: var(--color-danger); }
.key-ok { color: var(--color-success); }

.confirm-field { display: flex; flex-direction: column; gap: var(--space-2); }
.confirm-prompt { font-size: var(--font-size-secondary); color: var(--ev-c-text-1); line-height: 1.6; }
.confirm-prompt strong { color: var(--color-danger); }
.confirm-input {
    width: 120px;
    padding: 9px 11px;
    background-color: var(--color-background);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-md);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-secondary);
}
.confirm-input:focus { outline: none; border-color: var(--color-danger); }

.result-summary { display: flex; align-items: center; gap: var(--space-3); font-size: var(--font-size-body); }
.result-count { color: var(--ev-c-text-1); font-weight: var(--font-weight-medium); }
.result-summary.allgood .result-count { color: var(--color-success); }
.result-failed { color: var(--color-danger); font-size: var(--font-size-secondary); }

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-6);
    border-top: 1px solid var(--ev-c-gray-3);
}
.btn-ghost, .btn-danger {
    padding: var(--button-padding);
    border-radius: var(--radius-lg);
    font-size: var(--font-size-button);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.btn-ghost { background-color: transparent; border: 1px solid var(--ev-c-gray-2); color: var(--ev-c-text-1); }
.btn-ghost:hover { background-color: var(--ev-c-gray-3); }
.btn-danger { background-color: transparent; border: 1px solid var(--color-danger-border); color: var(--color-danger); }
.btn-danger:hover:not(:disabled) { background-color: var(--color-danger-soft); }
.btn-danger:disabled { opacity: 0.45; cursor: default; }
</style>
