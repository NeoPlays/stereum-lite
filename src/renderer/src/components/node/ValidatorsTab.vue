<template>
    <div class="validators-view">
        <div v-if="!holders.length" class="state-message">No validator services on this node.</div>

        <template v-else>
            <!-- Page header -->
            <header class="page-header">
                <div class="headings">
                    <span class="eyebrow">{{ eyebrow }}</span>
                    <h1 class="page-title">Validator keys</h1>
                </div>
                <div class="header-actions">
                    <button class="btn-ghost" @click="openBeaconModal" :title="beaconUrl || `Using this node's beacon`">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M12 3a9 9 0 0 1 0 18M12 3a9 9 0 0 0 0 18" /></svg>
                        Stats beacon<span v-if="beaconUrl" class="src-dot"></span>
                    </button>
                    <button class="btn-ghost" :disabled="st.loading" @click="refresh">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" /></svg>
                        Refresh
                    </button>
                    <button
                        class="btn-accent"
                        :disabled="!soloEligible"
                        :title="soloEligible ? 'Import validator keystores' : 'Only a solo validator client can import keys here'"
                        @click="importModal = true"
                    >Import keys</button>
                </div>
            </header>

            <!-- Service tabs -->
            <nav class="service-tabs">
                <button
                    v-for="h in holders"
                    :key="h.key"
                    class="service-tab"
                    :class="{ active: h.key === activeKey }"
                    @click="selectService(h)"
                >
                    <span class="tab-name">{{ shortName(h.service) }}</span>
                    <span class="tab-kind">{{ ROLE_LABEL[h.role] }}</span>
                    <span class="tab-count mono" :class="{ active: h.key === activeKey }">{{ countFor(h) }}</span>
                </button>
            </nav>

            <template v-if="activeHolder">
                <!-- Not listable: keymanager off (VC) or SSV -> a notice instead of the table. -->
                <div v-if="!activeHolder.listable" class="notice info">
                    <template v-if="activeHolder.role === 'ssv'">{{ capability.note }}</template>
                    <template v-else>
                        Keymanager API is not enabled on this client, so its keys can't be listed.
                        <span class="notice-sub">Enable the client's keymanager flag to manage keys here.</span>
                    </template>
                </div>

                <div v-else-if="st.loading && !st.keys.length" class="notice muted">Reading validator keys from the client…</div>
                <div v-else-if="st.error" class="notice error">{{ st.error }}</div>

                <template v-else>
                    <!-- Facet cards -->
                    <div class="facets">
                        <button
                            v-for="f in FACETS"
                            :key="f.key"
                            class="facet"
                            :class="{ active: filter === f.key, disabled: facetDisabled(f) }"
                            :disabled="facetDisabled(f)"
                            @click="setFilter(f.key)"
                        >
                            <span class="facet-top">
                                <span v-if="f.color" class="dot" :style="{ background: f.color }"></span>
                                <span class="facet-label">{{ f.label }}</span>
                            </span>
                            <span class="facet-count mono" :style="f.key === 'Slashed' && counts.Slashed > 0 ? { color: 'var(--color-danger)' } : null">{{ facetCount(f) }}</span>
                        </button>
                    </div>

                    <div v-if="statsLoading || statsError || st.statesSource === 'custom'" class="stats-line" :class="{ error: !!statsError }">
                        <template v-if="statsLoading">Loading validator stats from the beacon…</template>
                        <template v-else-if="statsError">{{ statsError }}</template>
                        <template v-else>Stats read from a custom beacon URL</template>
                    </div>

                    <!-- Table card -->
                    <div class="table-card">
                        <!-- Toolbar -->
                        <div class="toolbar">
                            <div class="search">
                                <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                                <input v-model="query" class="search-input mono" type="text" placeholder="Search by pubkey, index, or fee recipient…" autocomplete="off" spellcheck="false" />
                            </div>
                            <button
                                v-for="c in CHIPS"
                                :key="c.key"
                                class="chip"
                                :class="{ on: chips[c.key], disabled: !statusKnown }"
                                :disabled="!statusKnown"
                                :title="!statusKnown ? 'Needs validator data' : ''"
                                @click="toggleChip(c.key)"
                            >{{ c.label }}</button>
                        </div>

                        <!-- Scope + action bar -->
                        <div class="scopebar" :class="{ allkeys: effectiveScope === 'all' }">
                            <div class="scope-left">
                                <span class="scope-label">Apply to</span>
                                <div class="segmented">
                                    <button
                                        v-for="s in SCOPES"
                                        :key="s.key"
                                        class="segment"
                                        :class="{ active: effectiveScope === s.key }"
                                        @click="scope = s.key"
                                    >{{ s.label }}</button>
                                </div>
                                <span class="scope-count mono" :style="effectiveScope === 'all' ? { color: 'var(--color-accent)' } : null">
                                    {{ scopeCount }} {{ scopeCount === 1 ? scopeNoun : scopeNoun + 's' }}
                                </span>
                                <button v-if="headerAllOnPage && !allMatching && visible.length > slice.length" class="link-btn" @click="allMatching = true">
                                    Select all {{ visible.length }} matching
                                </button>
                            </div>
                            <div class="scope-right">
                                <button
                                    v-for="a in capability.scopeActions"
                                    :key="a.id"
                                    class="scope-action"
                                    :class="{ danger: a.danger }"
                                    :disabled="isActionDisabled(a, null)"
                                    @click="onScopeAction(a)"
                                >{{ a.label }}</button>
                                <button v-if="hasSelection" class="link-btn" @click="clearSelection">Clear selection</button>
                            </div>
                        </div>

                        <ValidatorTable
                            :rows="slice"
                            :selected="selected"
                            :header-state="headerState"
                            :row-actions="capability.rowActions"
                            :solo-eligible="soloEligible"
                            :graffiti-supported="graffitiSupported"
                            :stats-applicable="statsApplicable"
                            :network="network"
                            :page="pageClamped"
                            :pages="pages"
                            :size="size"
                            :range-label="rangeLabel"
                            @row-click="detail = $event"
                            @toggle="toggleRow"
                            @toggle-all="toggleAll"
                            @copy="copyPubkey($event.pubkey)"
                            @explorer="openExplorer"
                            @menu-action="onRowAction"
                            @update:size="setSize"
                            @prev="page = Math.max(1, pageClamped - 1)"
                            @next="page = Math.min(pages, pageClamped + 1)"
                        />
                    </div>
                </template>
            </template>
        </template>

        <ValidatorDetailDrawer
            v-if="detail"
            :validator="detail"
            :actions="capability.drawerActions"
            :solo-eligible="soloEligible"
            :graffiti-supported="graffitiSupported"
            @close="detail = null"
            @action="onDrawerAction"
        />

        <Teleport to="body">
            <ValidatorImportModal
                v-if="importModal"
                :client-name="shortName(activeService)"
                :network="network"
                @close="closeImportModal"
                @pick-keystores="({ done }) => pickJsonFiles(true, 'Select validator keystores', done)"
                @pick-protection="({ done }) => pickJsonFiles(false, 'Select slashing protection file', done)"
                @validate="validateProtection"
                @apply="applyImport"
            />
            <ValidatorExitModal
                v-if="exitModal"
                :rows="exitModal.rows"
                :client-name="shortName(activeService)"
                :network="network"
                @close="closeExitModal"
                @preflight="exitPreflight"
                @apply="applyExit"
            />
            <ValidatorRemoveModal
                v-if="removeModal"
                :pubkeys="removeModal.pubkeys"
                :client-name="shortName(activeService)"
                @close="closeRemoveModal"
                @remove="applyRemove"
                @save="saveProtection"
            />
            <ValidatorSettingModal
                v-if="settingModal"
                :kind="settingModal.kind"
                :pubkeys="settingModal.pubkeys"
                :current="settingModal.current"
                :client-name="shortName(activeService)"
                @close="settingModal = null"
                @apply="applySetting"
            />
        </Teleport>

        <Teleport to="body">
            <div v-if="beaconModal" class="modal-overlay" @click.self="beaconModal = false">
                <div class="beacon-modal">
                    <header class="bm-head">
                        <h3 class="bm-title">Stats beacon source</h3>
                        <button class="icon-btn" aria-label="Close" @click="beaconModal = false">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </header>
                    <div class="bm-body">
                        <p class="bm-hint">Which beacon node validator stats are read from. Leave empty to use this node's own beacon (the connected node's first running consensus client).</p>
                        <p class="bm-hint bm-warn">Your validator public keys are sent to this URL to look up their on-chain state. Pubkeys are public data, but a third-party endpoint could correlate them to this node - use a beacon you trust.</p>
                        <input v-model="beaconDraft" class="bm-input mono" type="text" placeholder="http://host:5052  (empty = this node's beacon)" autocomplete="off" spellcheck="false" @keydown.enter="saveBeacon" />
                    </div>
                    <footer class="bm-foot">
                        <button class="btn-ghost" @click="beaconModal = false">Cancel</button>
                        <button class="btn-accent" @click="saveBeacon">Save</button>
                    </footer>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { classifyValidatorSetup, SOLO_VC_TYPES, holdsOnChainValidators, isSoloEligible } from '@renderer/utils/validatorSetup'
import { capabilityFor, explorerUrl, actionDisabled } from '@renderer/utils/validatorCapabilities'
import { useValidatorKeys } from '@renderer/composables/useValidatorKeys'
import { scopeTargets, effectiveScopeOf, scopeCountOf } from '@renderer/utils/validatorScope'
import ValidatorTable from './validators/ValidatorTable.vue'
import ValidatorDetailDrawer from './validators/ValidatorDetailDrawer.vue'
import ValidatorSettingModal from './validators/ValidatorSettingModal.vue'
import ValidatorRemoveModal from './validators/ValidatorRemoveModal.vue'
import ValidatorImportModal from './validators/ValidatorImportModal.vue'
import ValidatorExitModal from './validators/ValidatorExitModal.vue'

const props = defineProps({
    services: { type: Array, default: () => [] },
    nodeId: { type: [String, Number], required: true },
    active: { type: Boolean, default: false },
})

const ROLE_LABEL = { validator: 'validators', share: 'key shares', distributed: 'distributed validators', signer: 'signing keys', ssv: 'SSV operator' }
const FACETS = [
    { key: 'All', label: 'All keys', color: null },
    { key: 'Active', label: 'Active', color: 'var(--color-success)' },
    { key: 'Pending', label: 'Pending', color: 'var(--color-warning)' },
    { key: 'Exited', label: 'Exited', color: 'var(--ev-c-text-3)' },
    { key: 'Slashed', label: 'Slashed', color: 'var(--color-danger)' },
]
const CHIPS = [
    { key: 'cred01', label: '0x01 creds' },
    { key: 'feeSet', label: 'Fee recipient set' },
    { key: 'missingGraffiti', label: 'Missing graffiti' },
]
const SCOPES = [
    { key: 'all', label: 'All keys' },
    { key: 'filtered', label: 'Current filter' },
    { key: 'selected', label: 'Selection' },
]
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

function roleOf(service, kind) {
    const t = service?.config?.service
    if (t === 'CharonService') return 'distributed'
    if (t === 'SSVNetworkService') return 'ssv'
    if (t === 'Web3SignerService') return 'signer'
    if (SOLO_VC_TYPES.has(t)) return kind === 'obol' ? 'share' : 'validator'
    return null
}

// Every key-holding service on the node (one tab each).
const holders = computed(() => {
    const bySetup = new Map()
    for (const s of props.services) {
        const key = s.setup?.id ?? '__none'
        if (!bySetup.has(key)) bySetup.set(key, { setup: s.setup ?? null, services: [] })
        bySetup.get(key).services.push(s)
    }
    const out = []
    for (const grp of bySetup.values()) {
        const cls = classifyValidatorSetup(grp.services)
        if (cls.kind === 'none') continue
        for (const s of grp.services) {
            const role = roleOf(s, cls.kind)
            if (!role) continue
            out.push({
                key: s.id, service: s, kind: cls.kind, role, setup: grp.setup,
                listable: Boolean(s.validatorListable),
                // Only a solo VC holds keys we may act on alone. A VC behind Charon holds a
                // key SHARE: a keymanager write there is either meaningless or needs a
                // threshold of operators, so every mutating action stays gated off.
                soloEligible: isSoloEligible(cls.kind) && role === 'validator',
                // Share pubkeys (VC/Web3Signer behind Charon) have no on-chain stats.
                onChainStats: holdsOnChainValidators(role, cls.kind),
            })
        }
    }
    return out
})

const { load, loadStates, loadSettings, state } = useValidatorKeys(() => props.nodeId)

// Per-node "stats beacon" override (empty = the node's own beacon). Persisted in electron-store.
const beaconUrl = ref('')
const beaconModal = ref(false)
const beaconDraft = ref('')
onMounted(async () => {
    try { beaconUrl.value = (await window.api.invoke('store-get', `statsBeaconUrl:${props.nodeId}`)) || '' } catch { /* default: node's beacon */ }
})

// --- State ---
const activeKey = ref(null)
const query = ref('')
const queryD = ref('')
const filter = ref('All')
const chips = reactive({ cred01: false, feeSet: false, missingGraffiti: false })
const selected = reactive(new Set())
const allMatching = ref(false)
const scope = ref('all')
const page = ref(1)
const size = ref(25)
const detail = ref(null)

let debounce
watch(query, (q) => { clearTimeout(debounce); debounce = setTimeout(() => { queryD.value = q; page.value = 1; allMatching.value = false }, 150) })

const activeHolder = computed(() => holders.value.find((h) => h.key === activeKey.value) || null)
const activeService = computed(() => activeHolder.value?.service || null)
const network = computed(() => activeService.value?.config?.network || '')
const st = computed(() => (activeService.value ? state(activeService.value.id) : { loading: false, keys: [], error: '' }))
const capability = computed(() => capabilityFor(activeHolder.value?.role, shortName(activeService.value)))
// Share holders (VC/Web3Signer behind Charon) never have on-chain stats -> status/balance/etc. are n/a.
const statsApplicable = computed(() => Boolean(activeHolder.value?.onChainStats))

// Rows = keys merged with on-chain beacon state (by lowercased pubkey) and with the per-key
// keymanager settings (by exact pubkey). Missing fields stay null and render as "-".
const rows = computed(() => {
    const states = st.value.states || {}
    const settings = st.value.settings || {}
    return st.value.keys.map((k) => {
        const s = states[String(k.pubkey || '').toLowerCase()] || null
        return {
            pubkey: k.pubkey, readonly: k.readonly,
            index: s?.index ?? null, status: s?.status ?? null, slashed: s?.slashed ?? false,
            balance: s?.balance ?? null, effectiveBalance: s?.effectiveBalance ?? null,
            withdrawalType: s?.withdrawalType ?? null, activationEpoch: s?.activationEpoch ?? null,
            feeRecipient: settings[k.pubkey]?.feeRecipient ?? null,
            graffiti: settings[k.pubkey]?.graffiti ?? null,
        }
    })
})
const statusKnown = computed(() => rows.value.some((r) => r.status))
// Older client builds have no graffiti route. This must fail SAFE: only enable the action once
// a settings read has actually proved the route exists. Defaulting to "supported" while unknown
// would let a clear run against a routeless client, where the 404 that comes back is
// indistinguishable from "nothing was set" and would be reported as success.
const graffitiSupported = computed(() => st.value.graffitiSupported === true)
const soloEligible = computed(() => Boolean(activeHolder.value?.soloEligible))
const statsLoading = computed(() => Boolean(st.value.statesLoading))
const statsError = computed(() => st.value.statesError || '')

const visible = computed(() => {
    const q = queryD.value.toLowerCase()
    return rows.value.filter((r) => {
        if (filter.value !== 'All' && r.status !== filter.value) return false
        if (chips.cred01 && r.withdrawalType !== '0x01') return false
        if (chips.feeSet && (!r.feeRecipient || r.feeRecipient === ZERO_ADDR)) return false
        if (chips.missingGraffiti && r.graffiti) return false
        if (q) {
            return (r.pubkey || '').toLowerCase().includes(q) ||
                String(r.index ?? '').includes(q) ||
                (r.feeRecipient || '').toLowerCase().includes(q)
        }
        return true
    })
})
const total = computed(() => rows.value.length)
const counts = computed(() => {
    const c = { All: total.value, Active: null, Pending: null, Exited: null, Slashed: 0 }
    if (statusKnown.value) {
        c.Active = 0; c.Pending = 0; c.Exited = 0; c.Slashed = 0
        for (const r of rows.value) if (c[r.status] != null) c[r.status]++
    }
    return c
})

const pages = computed(() => Math.max(1, Math.ceil(visible.value.length / size.value)))
const pageClamped = computed(() => Math.min(page.value, pages.value))
const start = computed(() => (pageClamped.value - 1) * size.value)
const slice = computed(() => visible.value.slice(start.value, start.value + size.value))

// Header checkbox is page-scoped only (tri-state); "select all N matching" is a separate link.
const headerAllOnPage = computed(() => slice.value.length > 0 && slice.value.every((r) => selected.has(r.pubkey)))
const headerState = computed(() => {
    if (allMatching.value) return 'all'
    if (headerAllOnPage.value) return 'all'
    return slice.value.some((r) => selected.has(r.pubkey)) ? 'some' : 'none'
})
const hasSelection = computed(() => allMatching.value || selected.size > 0)

// One state object feeds every scope derivation, so the count shown and the keys written
// cannot drift apart (see utils/validatorScope.js).
const scopeState = computed(() => ({
    scope: scope.value,
    allMatching: allMatching.value,
    rows: rows.value,
    visible: visible.value,
    selected,
}))
const effectiveScope = computed(() => effectiveScopeOf(scopeState.value))
const scopeCount = computed(() => scopeCountOf(scopeState.value))
const scopeNoun = computed(() => (activeHolder.value?.role === 'distributed' ? 'DV' : 'key'))

const rangeLabel = computed(() => {
    if (visible.value.length === 0) return 'no matches'
    const from = start.value + 1
    const to = Math.min(start.value + size.value, visible.value.length)
    const base = `${from}-${to} of ${visible.value.length}`
    return visible.value.length !== total.value ? `${base} (filtered from ${total.value})` : base
})

const eyebrow = computed(() => {
    const parts = ['Node manager']
    const s = activeHolder.value?.setup
    if (s?.name) parts.push(s.network ? `${s.name} · ${s.network}` : s.name)
    return parts.join(' / ')
})

function shortName(service) { return (service?.config?.service ?? service?.id ?? '').replace(/Service$/, '') }
function countFor(h) {
    const s = state(h.service.id)
    if (s.loading) return '…'
    return h.key === activeKey.value || s.keys.length ? String(s.keys.length) : (h.listable ? '·' : '—')
}
function countText(v) { return v == null ? '—' : String(v) }
function facetDisabled(f) { return f.key !== 'All' && (!statsApplicable.value || !statusKnown.value) }
function facetCount(f) {
    if (f.key === 'All') return countText(counts.value.All)
    if (!statsApplicable.value) return 'n/a'
    return countText(counts.value[f.key])
}

// --- Actions ---
function selectService(h) {
    activeKey.value = h.key
    query.value = ''; queryD.value = ''
    filter.value = 'All'
    chips.cred01 = chips.feeSet = chips.missingGraffiti = false
    selected.clear(); allMatching.value = false
    scope.value = 'all'; page.value = 1; detail.value = null
    if (h.listable) load(h.service.id).then(() => { enrich(h); loadKeymanagerSettings(h) })
}
function refresh() {
    const h = activeHolder.value
    if (h) load(h.service.id, { force: true }).then(() => { enrich(h); loadKeymanagerSettings(h) })
}

// On-chain holders (solo VC keys, Charon DV pubkeys) get beacon-state enrichment; shares don't.
function enrich(h) {
    if (!h?.onChainStats) return
    const keys = state(h.service.id).keys
    if (keys?.length) loadStates(h.service.id, keys.map((k) => k.pubkey), beaconUrl.value)
}

// Fee recipient + graffiti come from the client itself, so they load for any solo VC regardless
// of whether the keys are on chain yet.
function loadKeymanagerSettings(h) {
    if (!h?.soloEligible) return
    const keys = state(h.service.id).keys
    if (keys?.length) loadSettings(h.service.id, keys.map((k) => k.pubkey))
}
function openBeaconModal() { beaconDraft.value = beaconUrl.value; beaconModal.value = true }
async function saveBeacon() {
    beaconUrl.value = beaconDraft.value.trim()
    beaconModal.value = false
    try { await window.api.invoke('store-set', `statsBeaconUrl:${props.nodeId}`, beaconUrl.value) } catch { /* non-fatal */ }
    enrich(activeHolder.value) // re-read stats from the new source
}
// "Select all N matching" is an affirmation of a specific set. If the filter changes, that set
// changes underneath it, so the blanket selection is dropped and must be re-affirmed.
function dropBlanketSelection() { allMatching.value = false }
function setFilter(key) { if (key !== 'All' && !statusKnown.value) return; filter.value = key; page.value = 1; dropBlanketSelection() }
function toggleChip(key) { if (!statusKnown.value) return; chips[key] = !chips[key]; page.value = 1; dropBlanketSelection() }
function setSize(s) { size.value = s; page.value = 1 }

function toggleRow(pubkey) {
    if (selected.has(pubkey)) selected.delete(pubkey); else selected.add(pubkey)
    allMatching.value = false
    scope.value = selected.size ? 'selected' : 'all'
}
function toggleAll() {
    allMatching.value = false
    if (headerAllOnPage.value) slice.value.forEach((r) => selected.delete(r.pubkey))
    else slice.value.forEach((r) => selected.add(r.pubkey))
    scope.value = selected.size ? 'selected' : 'all'
}
function clearSelection() { selected.clear(); allMatching.value = false; scope.value = 'all' }

// Which rows a scope (bulk) action applies to. Always resolved from the same rule as the
// count in the scope bar.
const scopeRows = computed(() => scopeTargets({ ...scopeState.value, scope: effectiveScope.value }))

function isActionDisabled(a, row) {
    return actionDisabled(a, { row, soloEligible: soloEligible.value, graffitiSupported: graffitiSupported.value })
}
function copyPubkey(pubkey) { navigator.clipboard?.writeText(pubkey) }
function openExplorer(row) { const url = explorerUrl(network.value, row.index); if (url) window.open(url, '_blank') }
function exportCsv(list) {
    const header = 'pubkey,index,status,balance,withdrawal,fee_recipient,graffiti'
    const lines = list.map((r) => [r.pubkey, r.index ?? '', r.status ?? '', r.balance ?? '', r.withdrawalType ?? '', r.feeRecipient ?? '', r.graffiti ?? ''].join(','))
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const el = document.createElement('a')
    el.href = url; el.download = `${shortName(activeService.value)}-validators.csv`; el.click()
    URL.revokeObjectURL(url)
}

// The setting modal, and the keys it will write to. Held here rather than derived at apply
// time so a filter or selection change mid-dialog cannot silently retarget the write.
const settingModal = ref(null)   // { kind, pubkeys, current }
const removeModal = ref(null)    // { pubkeys }
const importModal = ref(false)
const exitModal = ref(null)      // { rows }

function openSettingModal(kind, targets) {
    const pubkeys = targets.map((r) => r.pubkey).filter(Boolean)
    if (!pubkeys.length) return
    settingModal.value = {
        kind,
        pubkeys,
        // Pre-fill only for a single key; across many keys there is no one "current" value.
        current: pubkeys.length === 1 ? (targets[0]?.[kind === 'graffiti' ? 'graffiti' : 'feeRecipient'] || '') : '',
    }
}

function openRemoveModal(targets) {
    const pubkeys = targets.map((r) => r.pubkey).filter(Boolean)
    if (pubkeys.length) removeModal.value = { pubkeys }
}

async function applyRemove({ done }) {
    let res
    try {
        res = await window.api.invoke('delete-validator-keys', props.nodeId, activeService.value.id, removeModal.value.pubkeys)
    } catch (e) {
        res = { ok: false, error: e?.message || 'The removal failed' }
    }
    done(res)
}

async function saveProtection({ content, done }) {
    const service = shortName(activeService.value) || 'validator'
    let res
    try {
        res = await window.api.invoke('save-slashing-protection', content, `slashing_protection-${service}.json`)
    } catch (e) {
        res = { ok: false, error: e?.message || 'Could not save the file' }
    }
    done(res)
}

function openExitModal(targets) {
    if (targets.length) exitModal.value = { rows: targets }
}

async function pickJsonFiles(multi, title, done) {
    try { done(await window.api.invoke('pick-json-files', { multi, title })) }
    catch (e) { done({ ok: false, error: e?.message || 'Could not read the file' }) }
}

async function validateProtection({ protection, pubkeys, done }) {
    // Validation runs in the main process because only it knows the node's genesis validators
    // root, which is what proves the file belongs to this chain.
    try {
        done(await window.api.invoke('validate-slashing-protection', props.nodeId, protection, pubkeys))
    } catch (e) {
        done({ ok: false, error: e?.message || 'Could not validate the file' })
    }
}

async function applyImport({ keystores, passwords, slashingProtection, acknowledgedNeverSigned, done }) {
    let res
    try {
        res = await window.api.invoke('import-validator-keys', props.nodeId, activeService.value.id,
            keystores, passwords, slashingProtection, { acknowledgedNeverSigned })
    } catch (e) {
        res = { ok: false, error: e?.message || 'The import failed' }
    }
    done(res)
}

function closeImportModal() {
    importModal.value = false
    refresh()
}

async function exitPreflight({ pubkeys, done }) {
    try {
        done(await window.api.invoke('get-exit-preflight', props.nodeId, activeService.value.id, pubkeys, beaconUrl.value || null))
    } catch (e) {
        done({ ok: false, error: e?.message || 'Could not check exit eligibility', checks: {} })
    }
}

async function applyExit({ pubkeys, done }) {
    let res
    try {
        res = await window.api.invoke('submit-voluntary-exit', props.nodeId, activeService.value.id, pubkeys, beaconUrl.value || null)
    } catch (e) {
        res = { ok: false, error: e?.message || 'The exit submission failed' }
    }
    done(res)
}

function closeExitModal() {
    exitModal.value = null
    clearSelection()
    refresh()
}

function closeRemoveModal() {
    removeModal.value = null
    clearSelection()
    // The removed keys are gone from the client, so the list must come from the client again.
    refresh()
}

async function applySetting({ value, done }) {
    const m = settingModal.value
    const channel = m.kind === 'graffiti' ? 'set-graffiti' : 'set-fee-recipient'
    let res
    try {
        res = await window.api.invoke(channel, props.nodeId, activeService.value.id, m.pubkeys, value)
    } catch (e) {
        res = { ok: false, error: e?.message || 'The update failed' }
    }
    done(res)
    // Re-read from the client rather than trusting our own optimistic value: a partial failure
    // means the table would otherwise show a value that was never actually applied.
    if (res?.ok) loadKeymanagerSettings(activeHolder.value)
}

/**
 * @param {string} id - action id from the capability sets
 * @param {object|null} row - the row for a single-key action
 * @param {boolean} bulk - true for scope-bar actions, which act on the whole scope
 */
function runAction(id, row, bulk = false) {
    // A scope action operates on every row in scope. Reading `row` for one of those would
    // silently act on a single key while the button says it applies to hundreds.
    const targets = bulk ? scopeRows.value : (row ? [row] : [])
    switch (id) {
        case 'copyPubkey': copyPubkey(row.pubkey); break
        case 'copyPubkeys': navigator.clipboard?.writeText(scopeRows.value.map((r) => r.pubkey).join('\n')); break
        case 'viewBeaconcha': openExplorer(row); break
        case 'exportCsv': exportCsv(scopeRows.value); break
        case 'setFeeRecipient': openSettingModal('feeRecipient', targets); break
        case 'setGraffiti': openSettingModal('graffiti', targets); break
        case 'removeKey':
        case 'removeKeys': openRemoveModal(targets); break
        case 'exitValidator':
        case 'exitValidators': openExitModal(targets); break
        default: break // exit / launchpad / cluster-details land in later slices
    }
}
function onRowAction({ id, row }) { runAction(id, row) }
function onScopeAction(a) { if (!isActionDisabled(a, null)) runAction(a.id, null, true) }
function onDrawerAction(id) { if (detail.value) runAction(id, detail.value) }

// Auto-select the first listable service on first open.
let seeded = false
watch(() => props.active, (isActive) => {
    if (!isActive || seeded || !holders.value.length) return
    seeded = true
    const first = holders.value.find((h) => h.listable) || holders.value[0]
    if (first) selectService(first)
}, { immediate: true })
</script>

<style scoped>
.validators-view { display: flex; flex-direction: column; gap: 18px; }

/* Header */
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); }
.headings { display: flex; flex-direction: column; gap: var(--space-2); }
.eyebrow { font-size: var(--font-size-secondary); text-transform: uppercase; letter-spacing: 0.09em; color: var(--ev-c-text-3); }
.page-title { font-size: var(--font-size-page-title); font-weight: var(--font-weight-semibold); letter-spacing: -0.01em; color: var(--ev-c-text-1); }
.header-actions { display: flex; gap: var(--space-2); }
.btn-ghost, .btn-accent {
    display: inline-flex; align-items: center; gap: var(--space-2);
    height: 34px; padding: 0 var(--space-4);
    border-radius: var(--radius-lg); font-size: var(--font-size-button); font-weight: var(--font-weight-medium);
    cursor: pointer; transition: background-color var(--transition-fast);
}
.btn-ghost { background-color: var(--ev-c-gray-3); border: 1px solid var(--ev-c-gray-3); color: var(--ev-c-text-1); }
.btn-ghost:hover:not(:disabled) { background-color: var(--ev-c-gray-2); }
.btn-ghost:disabled { opacity: 0.5; cursor: default; }
.btn-accent { background-color: var(--color-accent); border: none; color: var(--color-accent-text); font-weight: var(--font-weight-semibold); }
.btn-accent:disabled { opacity: 0.5; cursor: default; }

/* Service tabs */
.service-tabs { display: flex; gap: var(--space-5); border-bottom: 1px solid var(--ev-c-gray-3); }
.service-tab {
    display: inline-flex; align-items: center; gap: var(--space-2);
    padding: var(--space-3) var(--space-1); margin-bottom: -1px;
    background: transparent; border: none; border-bottom: 2px solid transparent;
    color: var(--ev-c-text-2); cursor: pointer; transition: color var(--transition-fast), border-color var(--transition-fast);
}
.service-tab:hover { color: var(--ev-c-text-1); }
.service-tab.active { color: var(--ev-c-text-1); border-bottom-color: var(--color-accent); }
.tab-name { font-size: var(--font-size-button); font-weight: var(--font-weight-semibold); }
.tab-kind { font-size: var(--font-size-secondary); color: var(--ev-c-text-3); }
.tab-count { font-size: var(--font-size-meta); padding: var(--chip-padding); border-radius: var(--radius-sm); background-color: var(--ev-c-gray-3); color: var(--ev-c-text-3); }
.tab-count.active { background-color: var(--color-accent-soft); color: var(--color-accent); }

/* Facet cards */
.facets { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--space-3); }
.facet {
    display: flex; flex-direction: column; gap: var(--space-2);
    padding: 13px 15px; text-align: left;
    background-color: var(--color-background-soft); border: 1px solid var(--ev-c-gray-3); border-radius: var(--radius-xl);
    cursor: pointer; transition: border-color var(--transition-fast), background-color var(--transition-fast);
}
.facet:hover:not(.disabled) { border-color: var(--ev-c-gray-2); }
.facet.active { border-color: var(--color-accent); background-color: var(--color-background-mute); }
.facet.disabled { opacity: 0.55; cursor: default; }
.facet-top { display: flex; align-items: center; gap: var(--space-2); }
.facet-label { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); }
.facet-count { font-size: 21px; font-weight: var(--font-weight-medium); letter-spacing: -0.02em; color: var(--ev-c-text-1); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

/* Table card */
.table-card { background-color: var(--color-background-soft); border: 1px solid var(--ev-c-gray-3); border-radius: var(--radius-2xl); overflow: hidden; }

.toolbar { display: flex; align-items: center; gap: var(--space-3); padding: 12px 14px; background-color: var(--color-background-mute); border-bottom: 1px solid var(--ev-c-gray-3); flex-wrap: wrap; }
.search { position: relative; flex: 1 1 240px; min-width: 200px; }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--ev-c-text-3); }
.search-input { width: 100%; height: 36px; padding: 0 12px 0 34px; background-color: var(--color-background); border: 1px solid var(--ev-c-gray-3); border-radius: var(--radius-lg); color: var(--ev-c-text-1); font-size: var(--font-size-secondary); outline: none; }
.search-input:focus { border-color: var(--color-accent); }
.chip { height: 30px; padding: 0 var(--space-3); background-color: var(--ev-c-gray-3); border: 1px solid transparent; border-radius: var(--radius-md); color: var(--ev-c-text-2); font-size: var(--font-size-secondary); cursor: pointer; transition: background-color var(--transition-fast); }
.chip:hover:not(.disabled) { background-color: var(--ev-c-gray-2); }
.chip.on { background-color: var(--color-accent-soft); border-color: var(--color-accent); color: var(--color-accent); }
.chip.disabled { opacity: 0.5; cursor: default; }

.scopebar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: 10px 14px; border-bottom: 1px solid var(--ev-c-gray-3); flex-wrap: wrap; transition: background-color var(--transition-fast); }
.scopebar.allkeys { background-color: var(--color-accent-wash); border-bottom-color: var(--color-accent-border); }
.scope-left, .scope-right { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.scope-label { font-size: var(--font-size-secondary); color: var(--ev-c-text-3); }
.segmented { display: inline-flex; padding: 2px; background-color: var(--color-background); border-radius: var(--radius-md); }
.segment { height: 26px; padding: 0 var(--space-3); background: transparent; border: none; border-radius: var(--radius-sm); color: var(--ev-c-text-2); font-size: var(--font-size-secondary); cursor: pointer; transition: background-color var(--transition-fast); }
.segment.active { background-color: var(--color-accent); color: var(--color-accent-text); }
.scope-count { font-size: var(--font-size-secondary); color: var(--ev-c-text-1); }
.scope-action { height: 30px; padding: 0 var(--space-3); background: transparent; border: 1px solid var(--ev-c-gray-2); border-radius: var(--radius-md); color: var(--ev-c-text-1); font-size: var(--font-size-secondary); cursor: pointer; transition: background-color var(--transition-fast); }
.scope-action:hover:not(:disabled) { background-color: var(--ev-c-gray-3); }
.scope-action:disabled { opacity: 0.45; cursor: default; }
.scope-action.danger { color: var(--color-danger); border-color: var(--color-danger-border); }
.link-btn { background: none; border: none; color: var(--color-accent); font-size: var(--font-size-secondary); cursor: pointer; padding: 0 var(--space-1); }
.link-btn:hover { color: var(--color-accent-hover); }

/* Notices */
.notice { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.6; padding: var(--space-4); background-color: var(--color-background-soft); border: 1px solid var(--ev-c-gray-3); border-radius: var(--radius-xl); }
.notice.info { display: flex; gap: var(--space-3); }
.notice.muted { color: var(--ev-c-text-3); }
.notice.error { color: var(--color-danger); border-color: var(--color-danger-border); }
.notice-sub { display: block; margin-top: var(--space-2); font-size: var(--font-size-meta); color: var(--ev-c-text-3); }

.state-message { color: var(--ev-c-text-2); font-size: var(--font-size-body); text-align: center; padding: var(--space-9); }

.src-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-accent); margin-left: 2px; }
.stats-line { font-size: var(--font-size-meta); color: var(--ev-c-text-3); padding: 0 var(--space-1); }
.stats-line.error { color: var(--color-danger); }

/* Stats-beacon modal */
.modal-overlay { position: fixed; inset: 0; z-index: 320; background-color: var(--scrim); display: flex; align-items: center; justify-content: center; padding: var(--space-8); }
.beacon-modal { display: flex; flex-direction: column; width: min(480px, 92vw); background-color: var(--color-background-soft); border: 1px solid var(--ev-c-gray-3); border-radius: var(--radius-xl); overflow: hidden; }
.bm-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--ev-c-gray-3); }
.bm-title { font-size: var(--font-size-title); font-weight: var(--font-weight-semibold); color: var(--ev-c-text-1); }
.icon-btn { flex-shrink: 0; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; border-radius: var(--radius-md); color: var(--ev-c-text-2); cursor: pointer; transition: background-color var(--transition-fast); }
.icon-btn:hover { background-color: var(--ev-c-gray-3); }
.bm-body { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-5); }
.bm-hint { font-size: var(--font-size-secondary); color: var(--ev-c-text-2); line-height: 1.5; }
.bm-warn { font-size: var(--font-size-meta); color: var(--ev-c-text-3); }
.bm-input { padding: var(--button-padding); background-color: var(--color-background-mute); border: 1px solid var(--ev-c-gray-2); border-radius: var(--radius-md); color: var(--ev-c-text-1); font-size: var(--font-size-secondary); outline: none; }
.bm-input:focus { border-color: var(--color-accent); }
.bm-foot { display: flex; justify-content: flex-end; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--ev-c-gray-3); }
</style>
