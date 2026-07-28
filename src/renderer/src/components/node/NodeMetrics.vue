<template>
    <section class="section metrics">
        <h2 class="section-title">Monitoring</h2>

        <!-- System -->
        <div class="metrics-card">
            <div v-if="systemError" class="metrics-empty error">System metrics unavailable - {{ systemError }}</div>
            <div v-else-if="!system" class="metrics-empty">Loading system metrics…</div>
            <div v-else class="meters">
                <div class="meter">
                    <div class="meter-head">
                        <span class="meter-label">CPU</span>
                        <span class="meter-value mono" :class="'lvl-' + level(system.cpu.usagePct)">
                            {{ system.cpu.usagePct != null ? system.cpu.usagePct + '%' : '-' }}
                        </span>
                    </div>
                    <div class="bar"><div class="bar-fill" :class="level(system.cpu.usagePct)" :style="fill(system.cpu.usagePct)"></div></div>
                    <span class="meter-sub mono">
                        {{ system.cpu.cores != null ? system.cpu.cores + ' cores' : '' }}
                        {{ system.cpu.load1 != null ? '· load ' + system.cpu.load1 : '' }}
                    </span>
                </div>

                <div class="meter">
                    <div class="meter-head">
                        <span class="meter-label">Memory</span>
                        <span class="meter-value mono" :class="'lvl-' + level(system.memory?.usedPct)">{{ system.memory ? system.memory.usedPct + '%' : '-' }}</span>
                    </div>
                    <div class="bar"><div class="bar-fill" :class="level(system.memory?.usedPct)" :style="fill(system.memory?.usedPct)"></div></div>
                    <span class="meter-sub mono" v-if="system.memory">
                        {{ bytes(system.memory.usedBytes) }} / {{ bytes(system.memory.totalBytes) }}
                    </span>
                </div>

            </div>
        </div>

        <!-- Disk (per-service stacked bar) -->
        <div class="metrics-card">
            <div class="meter-head">
                <span class="meter-label">Disk <span class="meter-mount mono" v-if="disk">{{ disk.mount }}</span></span>
                <span class="meter-value mono" v-if="disk" :class="'lvl-' + diskLevel">{{ diskUsedPct }}%</span>
            </div>
            <div v-if="diskError" class="metrics-empty error">Disk usage unavailable - {{ diskError }}</div>
            <div v-else-if="!disk" class="metrics-empty">Analyzing disk usage…</div>
            <template v-else>
                <div class="disk-bar">
                    <div
                        v-for="seg in diskSegments"
                        :key="seg.key"
                        class="disk-seg"
                        :class="{ dim: hovered && hovered !== seg.key }"
                        :style="{ width: seg.width, background: seg.color }"
                        @mouseenter="hovered = seg.key"
                        @mouseleave="hovered = null"
                    >
                        <div class="disk-tooltip" v-if="hovered === seg.key">
                            <strong>{{ seg.label }}</strong>
                            <span class="mono">{{ bytes(seg.bytes) }} · {{ seg.pct }}% of disk</span>
                        </div>
                    </div>
                </div>
                <div class="disk-legend">
                    <span
                        v-for="seg in diskSegments"
                        :key="seg.key"
                        class="legend-item"
                        :class="{ dim: hovered && hovered !== seg.key }"
                        @mouseenter="hovered = seg.key"
                        @mouseleave="hovered = null"
                    >
                        <span class="legend-swatch" :style="{ background: seg.color }"></span>
                        <span class="legend-label">{{ seg.label }}</span>
                        <span class="legend-size mono">{{ bytes(seg.bytes) }}</span>
                    </span>
                </div>
                <span class="meter-sub mono">{{ bytes(disk.usedBytes) }} / {{ bytes(disk.totalBytes) }} used</span>
            </template>
        </div>

        <!-- Clients -->
        <div v-if="clientServices.length" class="metrics-card">
            <div v-if="clientsError" class="metrics-empty error">Client metrics unavailable - {{ clientsError }}</div>
            <SetupGroups :services="clientServices">
                <template #default="{ service }">
                    <div class="client-row">
                        <div class="client-head">
                            <span class="client-name">{{ service.config?.service ?? service.id }}</span>
                            <span v-if="service.metric.source === 'prometheus'" class="src-mark" :title="sourceTitle(service.metric)">prom</span>
                            <span class="client-sync" :class="syncClass(service.metric)">{{ syncLabel(service.metric) }}</span>
                        </div>

                        <!-- Both metrics render unconditionally - a missing value shows an
                             empty track and a "-" readout instead of removing the row, so
                             the layout never jumps when a single probe misses a poll. -->
                        <div class="client-metrics">
                            <div class="client-metric">
                                <span class="metric-tag">sync</span>
                                <div class="bar">
                                    <div v-if="service.metric.syncPct != null" class="bar-fill" :class="syncBarLevel(service.metric)" :style="pctFill(service.metric.syncPct)"></div>
                                    <!-- syncing but no computable %: show an indeterminate sweep -->
                                    <div v-else-if="service.metric.syncing" class="bar-fill indeterminate" :class="syncBarLevel(service.metric)"></div>
                                </div>
                                <span class="metric-val mono">{{ headLabel(service.metric) || (service.metric.syncing ? 'syncing…' : '-') }}</span>
                            </div>

                            <div class="client-metric">
                                <span class="metric-tag">peers</span>
                                <div class="bar">
                                    <div v-if="service.metric.peers != null && service.metric.maxPeers" class="bar-fill" :class="peerLevel(service.metric)" :style="peerFill(service.metric)"></div>
                                </div>
                                <span class="metric-val mono">
                                    <template v-if="service.metric.peers != null">
                                        {{ service.metric.peers }}<template v-if="service.metric.maxPeers"> / {{ service.metric.maxPeers }}</template>
                                    </template>
                                    <template v-else>-</template>
                                </span>
                            </div>
                        </div>
                    </div>
                </template>
            </SetupGroups>
        </div>
    </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import SetupGroups from './SetupGroups.vue'

const props = defineProps({
    system: { type: Object, default: null },
    clients: { type: Object, default: () => ({}) },
    disk: { type: Object, default: null },
    services: { type: Array, default: () => [] },
    systemError: { type: String, default: null },
    clientsError: { type: String, default: null },
    diskError: { type: String, default: null },
})

const hovered = ref(null)

// Fixed-order categorical palette (see base.css --chart-N). Assigned by slot, never
// cycled - a 7th+ service reuses the last slot rather than inventing a colour.
const CHART_COLORS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6']
const chartColor = (i) => `var(${CHART_COLORS[Math.min(i, CHART_COLORS.length - 1)]})`

const diskUsedPct = computed(() =>
    props.disk?.totalBytes ? Math.round((props.disk.usedBytes / props.disk.totalBytes) * 100) : 0
)

// Disk fills earlier-warning than CPU/mem - running out is fatal for a node (geth needs
// headroom to compact), so warn at 80% and alarm at 90%.
const diskLevel = computed(() => {
    const p = diskUsedPct.value
    if (p >= 90) return 'danger'
    if (p >= 80) return 'warning'
    return 'ok'
})

// Stacked segments: one per service (coloured), then "Other" used space, then free.
const diskSegments = computed(() => {
    const d = props.disk
    if (!d?.totalBytes) return []
    const segs = d.services.map((s, i) => ({
        key: s.id,
        label: s.service,
        bytes: s.bytes,
        pct: s.pct,
        color: chartColor(i),
    }))
    if (d.otherBytes > 0) {
        segs.push({ key: '__other', label: 'Other', bytes: d.otherBytes, pct: round1((d.otherBytes / d.totalBytes) * 100), color: 'var(--ev-c-gray-2)' })
    }
    // Free space tints amber/red as the disk fills, so the bar itself signals the alarm.
    const freeColor = { ok: 'var(--ev-c-gray-3)', warning: 'var(--color-warning-soft)', danger: 'var(--color-danger-soft)' }[diskLevel.value]
    segs.push({ key: '__free', label: 'Free', bytes: d.freeBytes, pct: round1((d.freeBytes / d.totalBytes) * 100), color: freeColor })
    return segs.map((s) => ({ ...s, width: `${(s.bytes / d.totalBytes) * 100}%` }))
})

// Services that have client metrics, each augmented with its `metric` so <SetupGroups>
// can group them by setup + category (EC/CC) while the slot reads service.metric directly.
const clientServices = computed(() =>
    props.services
        .filter((s) => props.clients[s.id])
        .map((s) => ({ ...s, metric: props.clients[s.id] }))
)

// Threshold colouring for the usage bars.
function level(pct) {
    if (pct == null) return 'unknown'
    if (pct >= 90) return 'danger'
    if (pct >= 70) return 'warning'
    return 'ok'
}
function fill(pct) {
    return { width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }
}

function syncClass(m) {
    if (m.error) return 'danger'
    if (m.syncing === false) return 'ok'
    return 'warning'
}

// Sync bar: amber while syncing (not done yet), green once synced.
function syncBarLevel(m) {
    return m.syncing === false ? 'ok' : 'warning'
}
function headLabel(m) {
    if (m.head == null) return ''
    const noun = m.role === 'execution' ? 'block' : 'slot'
    // Denominator: EL uses eth_syncing's highestBlock (network head); CL-via-Prometheus
    // uses the wall-clock target slot. Both only while there's a target (i.e. syncing).
    const denom = m.role === 'execution' ? m.target : (m.source === 'prometheus' ? m.clock : null)
    if (denom != null) return `${noun} ${m.head.toLocaleString()} / ${denom.toLocaleString()}`
    return `${noun} ${m.head.toLocaleString()}`
}

// Where the sync figure came from (only set for consensus clients).
function sourceTitle(m) {
    return m.source === 'prometheus'
        ? 'Sync from Prometheus - head slot vs. wall-clock target slot'
        : 'Sync from the beacon API (/eth/v1/node/syncing)'
}
function pctFill(pct) {
    return { width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }
}

// Peer bar is "fuller is better" (inverse of CPU/disk): near the target = healthy.
function peerFraction(m) {
    return m.maxPeers ? Math.min(1, m.peers / m.maxPeers) : null
}
function peerLevel(m) {
    const f = peerFraction(m)
    if (f == null) return 'unknown'
    if (f >= 0.66) return 'ok'
    if (f >= 0.33) return 'warning'
    return 'danger'
}
function peerFill(m) {
    return { width: `${(peerFraction(m) ?? 0) * 100}%` }
}
function syncLabel(m) {
    if (m.error) return 'offline'
    if (m.syncing === false) return 'synced'
    if (m.syncing === true) return m.syncPct != null ? `syncing ${m.syncPct}%` : 'syncing'
    return 'unknown'
}

function round1(n) {
    return Math.round(n * 10) / 10
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
function bytes(n) {
    if (n == null) return '-'
    let v = n, i = 0
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`
}
</script>

<style scoped>
.metrics {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
}
/* Matches the section-title recipe (see Updates.vue / design system) - without it the
   heading falls through to the base reset and renders as plain body text. */
.section-title {
    font-size: var(--font-size-button);
    font-weight: var(--font-weight-semibold);
    color: var(--ev-c-text-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.metrics-card {
    background: var(--color-background-soft);
    padding: var(--card-padding);
    border-radius: var(--radius-xl);
}
.metrics-empty {
    color: var(--ev-c-text-3);
    font-size: var(--font-size-secondary);
}
.metrics-empty.error {
    color: var(--color-danger);
}

/* System meters */
.meters {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-6);
}
.meter {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}
.meter-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
}
.meter-label {
    font-size: var(--font-size-secondary);
    color: var(--ev-c-text-2);
}
.meter-mount {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
    margin-left: var(--space-1);
}
.meter-value {
    font-size: var(--font-size-title);
    color: var(--ev-c-text-1);
}
/* Readout stays neutral when healthy; turns amber/red past the thresholds. */
.meter-value.lvl-warning { color: var(--color-warning); }
.meter-value.lvl-danger { color: var(--color-danger); }
.meter-sub {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-3);
    min-height: 1em;
}
.bar {
    height: 6px;
    border-radius: var(--radius-sm);
    background: var(--ev-c-gray-3);
    overflow: hidden;
}
.bar-fill {
    height: 100%;
    border-radius: var(--radius-sm);
    transition: width var(--transition-fast);
}
.bar-fill.ok { background: var(--color-success); }
.bar-fill.warning { background: var(--color-warning); }
.bar-fill.danger { background: var(--color-danger); }
.bar-fill.unknown { background: var(--ev-c-gray-2); }
/* Syncing with no computable %: a fixed-width fill sweeps across the (overflow-hidden)
   track. Colour still comes from the level class (amber while syncing). */
.bar-fill.indeterminate {
    width: 33%;
    animation: bar-indeterminate 1.3s linear infinite;
}
@keyframes bar-indeterminate {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(360%); }
}

/* Disk stacked bar */
.disk-bar {
    display: flex;
    height: 12px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    margin: var(--space-3) 0 var(--space-4);
    background: var(--ev-c-gray-3);
}
.disk-seg {
    position: relative;
    height: 100%;
    /* 2px surface gap between fills (marks-and-anatomy spec) */
    box-shadow: inset -2px 0 0 var(--color-background-soft);
    transition: opacity var(--transition-fast);
    cursor: default;
}
.disk-seg:last-child { box-shadow: none; }
.disk-seg.dim, .legend-item.dim { opacity: 0.4; }
.disk-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    white-space: nowrap;
    padding: var(--space-2) var(--space-3);
    background: var(--color-background-mute);
    border: 1px solid var(--ev-c-gray-2);
    border-radius: var(--radius-md);
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-1);
    z-index: 10;
    pointer-events: none;
}
.disk-tooltip .mono { color: var(--ev-c-text-2); }
.disk-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-5);
    margin-bottom: var(--space-3);
}
.legend-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-meta);
    transition: opacity var(--transition-fast);
    cursor: default;
}
.legend-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
}
.legend-label { color: var(--ev-c-text-1); }
.legend-size { color: var(--ev-c-text-3); }

/* Client rows (grouped by setup/category via <SetupGroups>) */
.client-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}
.client-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}
.client-name {
    font-size: var(--font-size-secondary);
    color: var(--ev-c-text-1);
}
.client-sync {
    margin-left: auto;
    font-size: var(--font-size-meta);
    padding: var(--chip-padding);
    border-radius: var(--radius-sm);
}
.client-sync.ok { background: var(--color-success-soft); color: var(--color-success); }
.client-sync.warning { background: var(--color-warning-soft); color: var(--color-warning); }
.client-sync.danger { background: var(--color-danger-soft); color: var(--color-danger); }
.src-mark {
    font-family: var(--font-sans);
    font-size: var(--font-size-micro);
    color: var(--ev-c-text-3);
    opacity: 0.75;
    cursor: help;
}
.client-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-6);
}
.client-metric {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    /* Two metrics share the row; each shrinks its bar and wraps below ~240px. */
    flex: 1 1 240px;
    min-width: 0;
}
.metric-tag {
    font-size: var(--font-size-micro);
    color: var(--ev-c-text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    width: 40px;
    flex-shrink: 0;
}
.client-metric .bar {
    flex: 1;
}
.metric-val {
    font-size: var(--font-size-meta);
    color: var(--ev-c-text-2);
    white-space: nowrap;
    min-width: 96px;
    text-align: right;
}
</style>
