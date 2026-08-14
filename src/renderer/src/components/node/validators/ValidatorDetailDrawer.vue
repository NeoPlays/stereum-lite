<template>
    <Teleport to="body">
        <div class="drawer-scrim" @click.self="emit('close')">
            <aside class="drawer" role="dialog" aria-modal="true">
                <header class="drawer-head">
                    <div class="drawer-headings">
                        <span class="eyebrow">Validator {{ validator.index != null ? '#' + validator.index : '' }}</span>
                        <span class="drawer-status" :style="{ color: STATUS_COLOR[validator.status] || 'var(--ev-c-text-3)' }">
                            <span class="dot" :style="{ background: STATUS_COLOR[validator.status] || 'var(--ev-c-gray-1)' }"></span>
                            {{ STATUS_LABEL[validator.status] || 'Unknown' }}
                        </span>
                    </div>
                    <button class="icon-btn" aria-label="Close" @click="emit('close')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                </header>

                <div class="drawer-body">
                    <div class="pubkey-block mono" @click="copy(validator.pubkey)" :title="'Click to copy'">{{ validator.pubkey }}</div>

                    <div class="facts">
                        <div class="fact"><span class="fact-label">Balance</span><span class="fact-value mono">{{ eth(validator.balance) }}</span></div>
                        <div class="fact"><span class="fact-label">Effective balance</span><span class="fact-value mono">{{ eth(validator.effectiveBalance) }}</span></div>
                        <div class="fact"><span class="fact-label">Withdrawal creds</span><span class="fact-value mono">{{ withdrawalText(validator.withdrawalType) }}</span></div>
                        <div class="fact"><span class="fact-label">Activation epoch</span><span class="fact-value mono">{{ validator.activationEpoch ?? '—' }}</span></div>
                        <div class="fact"><span class="fact-label">Fee recipient</span><span class="fact-value mono">{{ validator.feeRecipient || '—' }}</span></div>
                        <div class="fact"><span class="fact-label">Graffiti</span><span class="fact-value mono">{{ validator.graffiti || '—' }}</span></div>
                    </div>

                    <div v-if="actions.length" class="drawer-actions">
                        <span class="eyebrow">Actions</span>
                        <button
                            v-for="a in actions"
                            :key="a.id"
                            class="drawer-action"
                            :class="{ danger: a.danger }"
                            :disabled="isDisabled(a)"
                            @click="emit('action', a.id)"
                        >
                            <span>{{ a.label }}</span>
                            <span v-if="hintFor(a)" class="action-hint">{{ hintFor(a) }}</span>
                        </button>
                    </div>
                </div>
            </aside>
        </div>
    </Teleport>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { actionDisabled, actionHint } from '@renderer/utils/validatorCapabilities'

const props = defineProps({
    validator: { type: Object, required: true },
    actions: { type: Array, default: () => [] },
    soloEligible: { type: Boolean, default: false },
    graffitiSupported: { type: Boolean, default: true },
})
const emit = defineEmits(['close', 'action'])

const STATUS_COLOR = { Active: 'var(--color-success)', Pending: 'var(--color-warning)', Exited: 'var(--ev-c-text-3)', Slashed: 'var(--color-danger)' }
const STATUS_LABEL = { Active: 'Active', Pending: 'Pending', Exited: 'Exited', Slashed: 'Slashed' }

function eth(gweiOrEth) {
    if (gweiOrEth == null) return '—'
    return `${Number(gweiOrEth).toFixed(3)} ETH`
}
function withdrawalText(type) {
    if (type === '0x02') return '0x02 (compounding)'
    if (type === '0x01') return '0x01 (execution)'
    if (type === '0x00') return '0x00 (BLS)'
    return '—'
}
function gateCtx() {
    return { row: props.validator, soloEligible: props.soloEligible, graffitiSupported: props.graffitiSupported }
}
function isDisabled(a) { return actionDisabled(a, gateCtx()) }
function hintFor(a) { return actionHint(a, gateCtx()) }
function copy(text) { navigator.clipboard?.writeText(text) }

function onKey(e) { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.drawer-scrim {
    position: fixed;
    inset: 0;
    z-index: 300;
    background-color: var(--scrim);
    display: flex;
    justify-content: flex-end;
}
.drawer {
    width: 420px;
    max-width: 92vw;
    height: 100%;
    background-color: var(--color-background-soft);
    border-left: 1px solid var(--ev-c-gray-3);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
}
.drawer-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-6);
    border-bottom: 1px solid var(--ev-c-gray-3);
}
.drawer-headings { display: flex; flex-direction: column; gap: var(--space-2); }
.eyebrow {
    font-size: var(--font-size-meta);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--ev-c-text-3);
}
.drawer-status { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-secondary); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.icon-btn {
    flex-shrink: 0;
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: var(--radius-md);
    color: var(--ev-c-text-2); cursor: pointer;
    transition: background-color var(--transition-fast);
}
.icon-btn:hover { background-color: var(--ev-c-gray-3); }

.drawer-body { display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-6); }
.pubkey-block {
    font-size: 11.5px;
    line-height: 1.55;
    word-break: break-all;
    color: var(--ev-c-text-1);
    background-color: var(--color-background);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    cursor: pointer;
}

.facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background-color: var(--ev-c-gray-3);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-md);
    overflow: hidden;
}
.fact {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    background-color: var(--color-background-soft);
}
.fact-label { font-size: var(--font-size-meta); text-transform: uppercase; letter-spacing: 0.05em; color: var(--ev-c-text-3); }
.fact-value { font-size: var(--font-size-secondary); color: var(--ev-c-text-1); word-break: break-all; }

.drawer-actions { display: flex; flex-direction: column; gap: var(--space-2); }
.drawer-actions .eyebrow { margin-bottom: var(--space-1); }
.drawer-action {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 11px 13px;
    background-color: var(--color-background-mute);
    border: 1px solid var(--ev-c-gray-3);
    border-radius: var(--radius-lg);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-button);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.drawer-action:hover:not(:disabled) { background-color: var(--ev-c-gray-3); }
.drawer-action:disabled { opacity: 0.45; cursor: default; }
.drawer-action.danger { color: var(--color-danger); border-color: var(--color-danger-border); }
.action-hint { font-size: var(--font-size-meta); color: var(--ev-c-text-3); }
</style>
