<template>
    <div class="vtable">
        <!-- Column header (sticky, outside the scroll region). -->
        <div class="vrow vhead">
            <div class="cell cell-check">
                <span class="checkbox" :class="{ checked: headerState === 'all', some: headerState === 'some' }" @click="emit('toggleAll')" role="checkbox" :aria-checked="headerState === 'all'">
                    <svg v-if="headerState === 'all'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12l5 5 9-11" /></svg>
                    <span v-else-if="headerState === 'some'" class="dash"></span>
                </span>
            </div>
            <div class="cell">Index</div>
            <div class="cell">Public key</div>
            <div class="cell">Status</div>
            <div class="cell cell-right">Balance</div>
            <div class="cell">Withdrawal</div>
            <div class="cell cell-right">Actions</div>
        </div>

        <!-- Rows -->
        <div ref="scrollEl" class="rows-scroll">
            <div
                v-for="row in rows"
                :key="row.pubkey"
                class="vrow vbody"
                :class="{ selected: selected.has(row.pubkey) }"
                @click="emit('rowClick', row)"
            >
                <div class="cell cell-check" @click.stop>
                    <span class="checkbox" :class="{ checked: selected.has(row.pubkey) }" @click="emit('toggle', row.pubkey)" role="checkbox" :aria-checked="selected.has(row.pubkey)">
                        <svg v-if="selected.has(row.pubkey)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12l5 5 9-11" /></svg>
                    </span>
                </div>
                <div class="cell cell-index mono">{{ row.index ?? '—' }}</div>
                <div class="cell cell-key mono">{{ shortKey(row.pubkey) }}</div>
                <div class="cell cell-status">
                    <template v-if="statsApplicable">
                        <span class="dot" :style="{ background: STATUS_COLOR[row.status] || 'var(--ev-c-gray-1)' }"></span>
                        <span :style="{ color: STATUS_COLOR[row.status] || 'var(--ev-c-text-3)' }">{{ STATUS_LABEL[row.status] || '—' }}</span>
                    </template>
                    <span v-else class="muted">n/a</span>
                </div>
                <div class="cell cell-right cell-balance mono" :class="{ muted: !statsApplicable }">{{ !statsApplicable ? 'n/a' : (row.balance != null ? Number(row.balance).toFixed(3) : '—') }}</div>
                <div class="cell cell-withdrawal">
                    <span v-if="statsApplicable && row.withdrawalType" class="wpill mono" :class="{ warn: row.withdrawalType === '0x01' || row.withdrawalType === '0x00' }">{{ row.withdrawalType }}</span>
                    <span v-else class="mono muted">{{ statsApplicable ? '—' : 'n/a' }}</span>
                </div>
                <div class="cell cell-right cell-actions" @click.stop>
                    <button class="iconbtn" title="Copy pubkey" @click="emit('copy', row)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                    </button>
                    <button class="iconbtn" title="View on beaconcha.in" :disabled="row.index == null" @click="emit('explorer', row)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H8M17 7v9" /></svg>
                    </button>
                    <button class="iconbtn" title="More" :class="{ active: menuPubkey === row.pubkey }" @click="toggleMenu(row, $event)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                    </button>
                </div>
            </div>

            <div v-if="!rows.length" class="empty-rows">No keys match the current filters.</div>
        </div>

        <!-- Footer / pager -->
        <div class="vfooter">
            <span class="range mono">{{ rangeLabel }}</span>
            <div class="footer-right">
                <div class="sizes">
                    <button
                        v-for="s in SIZES"
                        :key="s"
                        class="size-btn mono"
                        :class="{ active: s === size }"
                        @click="emit('update:size', s)"
                    >{{ s }}</button>
                </div>
                <div class="pager">
                    <button class="pager-btn" :disabled="page <= 1" @click="emit('prev')">‹ Prev</button>
                    <span class="pager-label mono">{{ page }} / {{ pages }}</span>
                    <button class="pager-btn" :disabled="page >= pages" @click="emit('next')">Next ›</button>
                </div>
            </div>
        </div>

        <!-- Row menu (teleported so the card's overflow:hidden never clips it). -->
        <Teleport to="body">
            <div v-if="menuPubkey" class="row-menu" :style="menuStyle">
                <button
                    v-for="a in rowActions"
                    :key="a.id"
                    class="menu-item"
                    :class="{ danger: a.danger }"
                    :disabled="isDisabled(a)"
                    @click="pickMenu(a)"
                >
                    <span>{{ a.label }}</span>
                    <span v-if="hintFor(a)" class="menu-hint">{{ hintFor(a) }}</span>
                </button>
            </div>
        </Teleport>
    </div>
</template>

<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { actionDisabled, actionHint } from '@renderer/utils/validatorCapabilities'

const props = defineProps({
    rows: { type: Array, default: () => [] },
    soloEligible: { type: Boolean, default: false },
    graffitiSupported: { type: Boolean, default: true },
    selected: { type: Object, required: true }, // Set<pubkey>
    headerState: { type: String, default: 'none' }, // 'none' | 'some' | 'all'
    rowActions: { type: Array, default: () => [] },
    statsApplicable: { type: Boolean, default: true },
    network: { type: String, default: '' },
    page: { type: Number, default: 1 },
    pages: { type: Number, default: 1 },
    size: { type: Number, default: 25 },
    rangeLabel: { type: String, default: '' },
})
const emit = defineEmits(['rowClick', 'toggle', 'toggleAll', 'copy', 'explorer', 'menuAction', 'update:size', 'prev', 'next'])

const SIZES = [25, 50, 100]
const STATUS_COLOR = { Active: 'var(--color-success)', Pending: 'var(--color-warning)', Exited: 'var(--ev-c-text-3)', Slashed: 'var(--color-danger)' }
const STATUS_LABEL = { Active: 'Active', Pending: 'Pending', Exited: 'Exited', Slashed: 'Slashed' }

function shortKey(pubkey) {
    return pubkey && pubkey.length > 20 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey
}
function gateCtx() {
    return { row: menuRow.value, soloEligible: props.soloEligible, graffitiSupported: props.graffitiSupported }
}
function isDisabled(a) { return actionDisabled(a, gateCtx()) }
function hintFor(a) { return actionHint(a, gateCtx()) }

// --- Row menu (teleported popover) ---
const scrollEl = ref(null)
const menuPubkey = ref(null)
const menuRow = ref(null)
const menuStyle = ref({})

function toggleMenu(row, ev) {
    if (menuPubkey.value === row.pubkey) { closeMenu(); return }
    const r = ev.currentTarget.getBoundingClientRect()
    menuStyle.value = { top: `${Math.round(r.bottom + 4)}px`, left: `${Math.round(r.right - 208)}px` }
    menuRow.value = row
    menuPubkey.value = row.pubkey
}
function closeMenu() { menuPubkey.value = null; menuRow.value = null }
function pickMenu(a) {
    if (isDisabled(a)) return
    emit('menuAction', { id: a.id, row: menuRow.value })
    closeMenu()
}

// Dismiss the menu on Esc, any outside click, or a scroll (its anchor row can move/unmount).
function onDocKey(e) { if (e.key === 'Escape') closeMenu() }
function onDocClick(e) { if (!e.target.closest('.row-menu') && !e.target.closest('.cell-actions')) closeMenu() }
function onScroll() { closeMenu() }
watch(menuPubkey, (open) => {
    const method = open ? 'addEventListener' : 'removeEventListener'
    document[method]('keydown', onDocKey, true)
    document[method]('click', onDocClick, true)
    window[method]('scroll', onScroll, true)
    scrollEl.value?.[method]('scroll', onScroll, true)
})
onUnmounted(closeMenu)
</script>

<style scoped>
.vtable { display: flex; flex-direction: column; }

.vrow {
    display: grid;
    grid-template-columns: 38px 84px minmax(0, 1fr) 120px 118px 138px 96px;
    align-items: center;
}
.vhead {
    height: 38px;
    background-color: var(--color-background-mute);
    border-bottom: 1px solid var(--ev-c-gray-3);
    font-size: var(--font-size-meta);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--ev-c-text-3);
}
.vhead .cell { padding: 0 var(--space-2); }

.rows-scroll { max-height: min(62vh, 720px); overflow-y: auto; }
.vbody {
    height: 46px;
    border-bottom: 1px solid var(--color-background-mute);
    cursor: pointer;
    transition: background-color var(--transition-fast);
}
.vbody:hover { background-color: var(--color-background-mute); }
.vbody.selected { background-color: var(--color-accent-wash); }

.cell { padding: 0 var(--space-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-secondary); color: var(--ev-c-text-1); }
.cell-right { text-align: right; justify-self: end; }
.cell-balance { padding-right: 18px; }
.cell-check { display: flex; align-items: center; justify-content: center; }
.cell-index { color: var(--ev-c-text-3); overflow: visible; text-overflow: clip; }
.cell-key { color: var(--ev-c-text-1); }
.cell-status { display: flex; align-items: center; gap: var(--space-2); }
.cell-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.muted { color: var(--ev-c-text-3); }

.checkbox {
    width: 16px; height: 16px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--ev-c-gray-1);
    display: flex; align-items: center; justify-content: center;
    color: var(--color-accent-text);
    cursor: pointer;
}
.checkbox.checked { background-color: var(--color-accent); border-color: var(--color-accent); }
.checkbox.some { background-color: var(--color-accent); border-color: var(--color-accent); }
.checkbox .dash { width: 8px; height: 2px; background: var(--color-accent-text); border-radius: 1px; }

.wpill {
    font-size: var(--font-size-meta);
    padding: var(--chip-padding);
    border-radius: var(--radius-sm);
    background-color: var(--ev-c-gray-3);
    color: var(--ev-c-text-2);
}
.wpill.warn { color: var(--color-warning); }

.iconbtn {
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: var(--radius-md);
    color: var(--ev-c-text-3); cursor: pointer;
    transition: background-color var(--transition-fast), color var(--transition-fast);
}
.iconbtn:hover:not(:disabled) { background-color: var(--ev-c-gray-2); color: var(--ev-c-text-1); }
.iconbtn.active { background-color: var(--ev-c-gray-2); color: var(--ev-c-text-1); }
.iconbtn:disabled { opacity: 0.35; cursor: default; }

.empty-rows { padding: var(--space-7); text-align: center; color: var(--ev-c-text-3); font-size: var(--font-size-secondary); }

.vfooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background-color: var(--color-background-mute);
    flex-wrap: wrap;
}
.range { font-size: var(--font-size-meta); color: var(--ev-c-text-3); }
.footer-right { display: flex; align-items: center; gap: var(--space-4); }
.sizes { display: flex; gap: var(--space-1); }
.size-btn {
    min-width: 30px; height: 28px;
    background: transparent; border: 1px solid var(--ev-c-gray-2); border-radius: var(--radius-md);
    color: var(--ev-c-text-2); font-size: var(--font-size-secondary); cursor: pointer;
    transition: background-color var(--transition-fast);
}
.size-btn:hover { background-color: var(--ev-c-gray-3); }
.size-btn.active { background-color: var(--color-accent-soft); border-color: var(--color-accent); color: var(--color-accent); }
.pager { display: flex; align-items: center; gap: var(--space-2); }
.pager-btn {
    height: 28px; padding: 0 var(--space-3);
    background: transparent; border: 1px solid var(--ev-c-gray-2); border-radius: var(--radius-md);
    color: var(--ev-c-text-2); font-size: var(--font-size-secondary); cursor: pointer;
    transition: background-color var(--transition-fast);
}
.pager-btn:hover:not(:disabled) { background-color: var(--ev-c-gray-3); }
.pager-btn:disabled { opacity: 0.35; cursor: default; }
.pager-label { font-size: var(--font-size-meta); color: var(--ev-c-text-3); }
</style>

<style>
/* Teleported to body, so unscoped. */
.row-menu {
    position: fixed;
    z-index: 400;
    width: 208px;
    background-color: var(--color-background-mute);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-menu);
    padding: var(--space-1);
    display: flex;
    flex-direction: column;
}
.row-menu .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    color: var(--ev-c-text-1);
    font-size: var(--font-size-secondary);
    cursor: pointer;
    text-align: left;
    transition: background-color var(--transition-fast);
}
.row-menu .menu-item:hover:not(:disabled) { background-color: var(--ev-c-gray-2); }
.row-menu .menu-item:disabled { opacity: 0.45; cursor: default; }
.row-menu .menu-item.danger { color: var(--color-danger); }
.row-menu .menu-hint { font-size: var(--font-size-meta); color: var(--ev-c-text-3); font-family: var(--font-mono); }
</style>
