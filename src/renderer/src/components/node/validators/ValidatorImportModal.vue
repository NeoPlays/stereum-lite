<template>
    <div class="modal-overlay" @click.self="maybeClose">
        <div class="modal" role="dialog" aria-modal="true">
            <header class="modal-header">
                <h3 class="modal-title">{{ title }}</h3>
                <button v-if="stage !== 'importing'" class="icon-btn" aria-label="Close" @click="maybeClose">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </header>

            <div class="modal-body">
                <!-- 1. Files -->
                <template v-if="stage === 'files'">
                    <p class="scope-line">
                        Loads validator keys into <span class="mono">{{ clientName }}</span> on
                        <span class="mono">{{ network }}</span>. Pick one keystore file per key.
                    </p>

                    <button class="btn-ghost pick-btn" :disabled="picking" @click="pickKeystores">
                        {{ files.length ? 'Add more keystore files' : 'Choose keystore files' }}
                    </button>

                    <p v-if="fileError" class="error-line">{{ fileError }}</p>

                    <template v-if="files.length">
                        <div class="result-summary">
                            <span class="result-count">{{ files.length }} {{ files.length === 1 ? 'keystore' : 'keystores' }} selected</span>
                        </div>
                        <ul class="item-list">
                            <li v-for="f in files" :key="f.pubkey">
                                <span class="item-main">
                                    <span class="mono">{{ shortKey(f.pubkey) }}</span>
                                    <span class="item-sub">{{ f.name }}</span>
                                </span>
                                <button class="link-btn" @click="removeFile(f.pubkey)">Remove</button>
                            </li>
                        </ul>
                    </template>
                </template>

                <!-- 2. Password -->
                <template v-else-if="stage === 'password'">
                    <p class="scope-line">
                        One password for all <strong>{{ files.length }}</strong>
                        {{ files.length === 1 ? 'keystore' : 'keystores' }}.
                    </p>

                    <!-- The keymanager API takes a passwords array positional to the keystores array,
                         so a per-file password would need a field per file. This flow sends one value
                         for every slot, which only works if it unlocks all of them. -->
                    <p class="sub-line">
                        The client is sent this password once per keystore, so it must unlock every file
                        selected. If they were created with different passwords, import them in separate
                        batches instead.
                    </p>

                    <label class="field-label" for="validator-import-password">Keystore password</label>
                    <div class="password-row">
                        <input
                            id="validator-import-password"
                            ref="passwordEl"
                            v-model="password"
                            class="value-input"
                            :type="showPassword ? 'text' : 'password'"
                            autocomplete="off"
                            spellcheck="false"
                            @keydown.enter="next"
                        />
                        <button class="link-btn" type="button" @click="showPassword = !showPassword">
                            {{ showPassword ? 'Hide' : 'Show' }}
                        </button>
                    </div>
                </template>

                <!-- 3. Slashing protection. The gate the rest of the flow exists for. -->
                <template v-else-if="stage === 'protection'">
                    <div class="notice-block danger">
                        <p><strong>Never run these keys in two places at once.</strong> That is the mistake
                        that gets a validator slashed, and slashing protection cannot save you from it: a file
                        only records the history one client already knows about. Two clients signing at the
                        same time are invisible to each other. Before importing, be sure no other client is
                        running these keys.</p>
                    </div>

                    <p class="sub-line">
                        Attach the slashing protection file exported when these keys were removed from their
                        previous client, or confirm they have never signed anywhere.
                    </p>

                    <div class="option" :class="{ chosen: Boolean(protectionFile), muted: neverSigned }">
                        <button class="btn-ghost pick-btn" :disabled="neverSigned || picking || validating" @click="pickProtection">
                            {{ protectionFile ? 'Choose a different file' : 'Attach slashing protection file' }}
                        </button>
                        <p v-if="protectionFile" class="item-sub mono">{{ protectionFile.name }}</p>
                        <p v-if="validating" class="progress-line">Checking the file against the selected keys…</p>

                        <template v-if="validation && !validating">
                            <p v-if="validationClean" class="ok-line">
                                Covers all {{ files.length }} {{ files.length === 1 ? 'key' : 'keys' }}.
                            </p>
                            <ul v-if="validation.errors.length" class="problem-list">
                                <li v-for="(e, i) in validation.errors" :key="`e${i}`" class="bad">
                                    <span class="problem-text">{{ e }}</span>
                                </li>
                            </ul>
                            <ul v-if="validation.warnings.length" class="problem-list">
                                <li v-for="(w, i) in validation.warnings" :key="`w${i}`" class="warn">
                                    <span class="problem-text">{{ w }}</span>
                                </li>
                            </ul>
                            <template v-if="validation.missing.length">
                                <p class="warn-line">
                                    {{ validation.missing.length }} of the selected
                                    {{ files.length === 1 ? 'key is' : 'keys are' }} not in this file. Those
                                    import with no history, which is only safe if they have never signed.
                                </p>
                                <ul class="problem-list">
                                    <li v-for="pk in validation.missing" :key="pk" class="warn">
                                        <span class="mono">{{ shortKey(pk) }}</span>
                                        <span class="problem-text">not covered</span>
                                    </li>
                                </ul>
                            </template>
                        </template>
                    </div>

                    <div class="option-divider"><span>or</span></div>

                    <div class="option" :class="{ muted: Boolean(protectionFile) }">
                        <label class="ack">
                            <input v-model="neverSigned" type="checkbox" :disabled="Boolean(protectionFile)" />
                            <span>These keys have never signed on any chain.</span>
                        </label>
                        <p class="sub-line">
                            Only true for keys that were just generated and never deposited or run anywhere.
                            Importing a key that <strong>has</strong> signed without its history risks a
                            slashing: the client will sign again on blocks and attestations it does not know
                            it already covered.
                        </p>
                    </div>

                    <p v-if="fileError" class="error-line">{{ fileError }}</p>
                </template>

                <!-- 4. Running -->
                <template v-else-if="stage === 'importing'">
                    <p class="progress-line">Importing {{ files.length }} {{ files.length === 1 ? 'key' : 'keys' }} into {{ clientName }}…</p>
                    <p class="sub-line">Decrypting each keystore takes a few seconds per key.</p>
                </template>

                <!-- 5. Outcome. Each key is reported independently, so a partial result is normal. -->
                <template v-else>
                    <div class="result-summary" :class="{ allgood: failedResults.length === 0 }">
                        <span class="result-count">{{ importedCount }} of {{ outcomes.length }} imported</span>
                        <span v-if="duplicateCount" class="result-note">{{ duplicateCount }} already present</span>
                        <span v-if="failedResults.length" class="result-failed">{{ failedResults.length }} failed</span>
                    </div>

                    <p class="sub-line">
                        The keys are now loaded in <span class="mono">{{ clientName }}</span>. That is all an
                        import does. It does not activate anything: whether a validator is deposited, in the
                        activation queue, active or exited is on-chain state this does not touch.
                    </p>

                    <ul v-if="nonImported.length" class="problem-list">
                        <li v-for="r in nonImported" :key="r.pubkey" :class="r.status === 'duplicate' ? 'warn' : 'bad'">
                            <span class="mono">{{ shortKey(r.pubkey) }}</span>
                            <span class="problem-text">{{ r.message }}</span>
                        </li>
                    </ul>

                    <p v-if="duplicateCount" class="sub-line">
                        A duplicate means {{ clientName }} already held that key. Nothing changed and nothing
                        is wrong.
                    </p>

                    <p v-if="importError" class="error-line">{{ importError }}</p>
                </template>
            </div>

            <footer class="modal-footer">
                <button v-if="stage !== 'importing' && stage !== 'done'" class="btn-ghost" @click="back">
                    {{ stage === 'files' ? 'Cancel' : 'Back' }}
                </button>
                <button v-if="stage !== 'importing' && stage !== 'done'" class="btn-accent" :disabled="!canContinue" @click="next">
                    {{ stage === 'protection' ? `Import ${files.length} ${files.length === 1 ? 'key' : 'keys'}` : 'Continue' }}
                </button>
                <button v-if="stage === 'done'" class="btn-ghost" @click="emit('close')">Close</button>
            </footer>
        </div>
    </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'

defineProps({
    clientName: { type: String, default: '' },
    network: { type: String, default: '' },
})
const emit = defineEmits(['close', 'pick-keystores', 'pick-protection', 'validate', 'apply'])

const stage = ref('files')          // files -> password -> protection -> importing -> done
const files = ref([])               // { name, content, pubkey }
const fileError = ref('')
const picking = ref(false)
const password = ref('')
const showPassword = ref(false)
const passwordEl = ref(null)
const protectionFile = ref(null)    // { name, content }
const validation = ref(null)        // { errors, warnings, missing }
const validating = ref(false)
const neverSigned = ref(false)
const outcomes = ref([])
const importError = ref('')

const title = computed(() => (stage.value === 'done' ? 'Import finished' : 'Import validator keys'))

const validationClean = computed(() => Boolean(validation.value)
    && !validation.value.errors.length
    && !validation.value.warnings.length
    && !validation.value.missing.length)

// A validated file is only a pass when nothing blocking came back. Warnings and uncovered keys are
// informational; errors mean the file cannot be trusted for these keys.
const protectionSatisfied = computed(() => (Boolean(protectionFile.value) && Boolean(validation.value) && !validation.value.errors.length))

const canContinue = computed(() => {
    if (stage.value === 'files') return files.value.length > 0
    if (stage.value === 'password') return password.value.length > 0
    if (stage.value === 'protection') return !validating.value && (protectionSatisfied.value || neverSigned.value)
    return false
})

const importedCount = computed(() => outcomes.value.filter((r) => r.status === 'imported').length)
const duplicateCount = computed(() => outcomes.value.filter((r) => r.status === 'duplicate').length)
const failedResults = computed(() => outcomes.value.filter((r) => r.status === 'error'))
const nonImported = computed(() => outcomes.value.filter((r) => r.status !== 'imported'))

function shortKey(pubkey) {
    return pubkey && pubkey.length > 20 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey
}

// EIP-2335 keystores store `pubkey` bare, the keymanager API and every protection file use the
// 0x form. Normalising here keeps the validate call and the on-screen key comparable to both.
function normalizePubkey(raw) {
    const hex = String(raw).trim().toLowerCase()
    return hex.startsWith('0x') ? hex : `0x${hex}`
}

function readKeystore(file) {
    let json
    try { json = JSON.parse(file.content) } catch { throw new Error(`${file.name} is not a valid JSON file`) }
    if (!json || typeof json.pubkey !== 'string' || !json.pubkey.trim()) {
        throw new Error(`${file.name} has no pubkey - it is not a validator keystore`)
    }
    return { name: file.name, content: file.content, pubkey: normalizePubkey(json.pubkey) }
}

async function pickKeystores() {
    fileError.value = ''
    picking.value = true
    const res = await new Promise((resolve) => emit('pick-keystores', { done: resolve }))
    picking.value = false
    if (!res?.ok) {
        if (!res?.canceled) fileError.value = res?.error || 'Could not read the selected files'
        return
    }
    const errors = []
    for (const file of res.files || []) {
        let parsed
        try { parsed = readKeystore(file) } catch (err) { errors.push(err.message); continue }
        // The same key twice would consume two positional password slots and come back as a
        // duplicate from the client - drop it here so the list matches what is actually sent.
        if (files.value.some((f) => f.pubkey === parsed.pubkey)) {
            errors.push(`${file.name} holds a key that is already selected`)
            continue
        }
        files.value.push(parsed)
    }
    fileError.value = errors.join(' · ')
}

function removeFile(pubkey) {
    files.value = files.value.filter((f) => f.pubkey !== pubkey)
}

async function pickProtection() {
    fileError.value = ''
    const res = await new Promise((resolve) => emit('pick-protection', { done: resolve }))
    if (!res?.ok) {
        if (!res?.canceled) fileError.value = res?.error || 'Could not read the file'
        return
    }
    protectionFile.value = res.file
    neverSigned.value = false
    await validateProtection()
}

async function validateProtection() {
    validating.value = true
    validation.value = null
    const res = await new Promise((resolve) => emit('validate', {
        protection: protectionFile.value?.content,
        pubkeys: files.value.map((f) => f.pubkey),
        done: resolve,
    }))
    validating.value = false
    if (!res?.ok) {
        // A file that could not be checked is not a file that passed - keep it out of the gate.
        protectionFile.value = null
        fileError.value = res?.error || 'The slashing protection file could not be read'
        return
    }
    validation.value = {
        errors: res.errors || [],
        warnings: res.warnings || [],
        missing: res.missing || [],
    }
}

// Any status the client invents (Prysm's SDK returns "unknown") is treated as a failure, never as
// a silent success - the user must see that key as not imported.
function normalizeStatus(status) {
    return status === 'imported' || status === 'duplicate' || status === 'error' ? status : 'error'
}

function messageFor(status, message) {
    if (message) return message
    if (status === 'duplicate') return 'Already held by this client'
    return 'Not imported'
}

function next() {
    if (!canContinue.value) return
    if (stage.value === 'files') { stage.value = 'password'; return }
    if (stage.value === 'password') { stage.value = 'protection'; return }
    runImport()
}

function back() {
    if (stage.value === 'files') { emit('close'); return }
    fileError.value = ''
    stage.value = stage.value === 'protection' ? 'password' : 'files'
}

async function runImport() {
    stage.value = 'importing'
    importError.value = ''
    const res = await new Promise((resolve) => emit('apply', {
        keystores: files.value.map((f) => f.content),
        // Positional to `keystores`: the same password is repeated for every slot.
        passwords: files.value.map(() => password.value),
        slashingProtection: protectionFile.value?.content || null,
        // The main process refuses a protection-less import without this, so the user's
        // acknowledgement has to travel with the request rather than staying in the modal.
        acknowledgedNeverSigned: neverSigned.value,
        done: resolve,
    }))
    if (!res?.ok) {
        stage.value = 'protection'
        importError.value = res?.error || 'The import failed'
        fileError.value = importError.value
        return
    }
    outcomes.value = (res.results || []).map((r) => {
        const status = normalizeStatus(r.status)
        return { pubkey: r.pubkey, status, message: messageFor(status, r.message) }
    })
    stage.value = 'done'
}

// Closing mid-import would hide an operation that keeps running on the client.
function maybeClose() {
    if (stage.value !== 'importing') emit('close')
}

// Selection changes invalidate the answer the file was checked against, so it has to be re-checked.
watch(files, () => {
    if (protectionFile.value) validateProtection()
}, { deep: true })

watch(stage, (value) => {
    if (value === 'password') nextTick(() => passwordEl.value?.focus())
})
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
.scope-line { font-size: var(--font-size-body); color: var(--ev-c-text-2); line-height: 1.6; }
.scope-line strong { color: var(--ev-c-text-1); }
.sub-line { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.6; }
.sub-line strong { color: var(--ev-c-text-1); }
.progress-line { font-size: var(--font-size-body); color: var(--ev-c-text-2); }
.ok-line { font-size: var(--font-size-secondary); color: var(--color-success); }
.warn-line { font-size: var(--font-size-secondary); color: var(--color-warning); line-height: 1.6; }
.error-line { font-size: var(--font-size-secondary); color: var(--color-danger); line-height: 1.6; }

.notice-block {
    padding: var(--space-4);
    background-color: var(--color-background-mute);
    border-left: 2px solid var(--color-warning);
    border-radius: var(--radius-md);
}
.notice-block.danger { border-left-color: var(--color-danger); }
.notice-block p { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.6; }
.notice-block strong { color: var(--ev-c-text-1); }

.pick-btn { align-self: flex-start; }

.item-list {
    display: flex; flex-direction: column; gap: var(--space-2);
    max-height: 240px; overflow-y: auto;
    margin: 0; padding: var(--space-3);
    list-style: none;
    background-color: var(--color-background-mute);
    border-radius: var(--radius-md);
}
.item-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); font-size: var(--font-size-meta); }
.item-main { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; color: var(--ev-c-text-1); }
.item-sub { font-size: var(--font-size-meta); color: var(--ev-c-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.link-btn {
    background: transparent; border: none; padding: 0;
    color: var(--ev-c-text-2); font-size: var(--font-size-meta); cursor: pointer;
    transition: color var(--transition-fast);
}
.link-btn:hover { color: var(--ev-c-text-1); }

.field-label { font-size: var(--font-size-meta); text-transform: uppercase; letter-spacing: 0.05em; color: var(--ev-c-text-3); }
.password-row { display: flex; align-items: center; gap: var(--space-3); }
.value-input {
    flex: 1;
    min-width: 0;
    padding: 9px 11px;
    background-color: var(--color-background);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-md);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-secondary);
}
.value-input:focus { outline: none; border-color: var(--color-accent); }

.option {
    display: flex; flex-direction: column; gap: var(--space-3);
    padding: var(--space-4);
    background-color: var(--color-background-mute);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-md);
}
.option.chosen { border-color: var(--color-accent-border); background-color: var(--color-accent-wash); }
.option.muted { opacity: 0.5; }

.option-divider { display: flex; align-items: center; gap: var(--space-3); color: var(--ev-c-text-3); font-size: var(--font-size-meta); }
.option-divider::before, .option-divider::after { content: ''; flex: 1; height: 1px; background-color: var(--ev-c-gray-3); }

.ack { display: flex; align-items: flex-start; gap: var(--space-3); font-size: var(--font-size-secondary); color: var(--ev-c-text-1); cursor: pointer; }
.ack input { margin-top: 2px; }

.result-summary { display: flex; align-items: center; gap: var(--space-3); font-size: var(--font-size-body); }
.result-count { color: var(--ev-c-text-1); font-weight: var(--font-weight-medium); }
.result-summary.allgood .result-count { color: var(--color-success); }
.result-note { color: var(--color-warning); font-size: var(--font-size-secondary); }
.result-failed { color: var(--color-danger); font-size: var(--font-size-secondary); }

.problem-list {
    display: flex; flex-direction: column; gap: var(--space-2);
    max-height: 220px; overflow-y: auto;
    margin: 0; padding: var(--space-3);
    list-style: none;
    background-color: var(--color-background);
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
.btn-ghost, .btn-accent {
    padding: var(--button-padding);
    border-radius: var(--radius-lg);
    font-size: var(--font-size-button);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.btn-ghost { background-color: transparent; border: 1px solid var(--ev-c-gray-2); color: var(--ev-c-text-1); }
.btn-ghost:hover:not(:disabled) { background-color: var(--ev-c-gray-3); }
.btn-ghost:disabled { opacity: 0.5; cursor: default; }
.btn-accent { background-color: var(--color-accent); border: none; color: var(--color-accent-text); font-weight: var(--font-weight-semibold); }
.btn-accent:hover:not(:disabled) { background-color: var(--color-accent-hover); }
.btn-accent:disabled { opacity: 0.5; cursor: default; }
</style>
