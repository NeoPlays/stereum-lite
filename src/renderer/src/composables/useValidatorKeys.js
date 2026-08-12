import { reactive, unref } from 'vue'

/**
 * Per-service validator-key cache for the Validators tab. Wraps the read-only `list-validators`
 * IPC (keymanager /eth/v1/keystores for VCs, Web3Signer publicKeys, Charon cluster-lock DV
 * pubkeys) so the view can lazily fetch each service once and refresh on demand.
 *
 * Slice 0 returns pubkeys only; later slices merge beacon status/balance + keymanager
 * fee-recipient/graffiti into these rows (by pubkey).
 *
 * @param {Ref<string>|string} nodeId
 */
export function useValidatorKeys(nodeId) {
    // Accept a getter (() => props.nodeId), a ref, or a plain value. `unref` does NOT call
    // functions, so a getter would otherwise be sent over IPC as-is (-> undefined nodeId).
    const resolveNodeId = () => (typeof nodeId === 'function' ? nodeId() : unref(nodeId))

    // serviceId -> { loading, keys: [{ pubkey, readonly, derivationPath? }], error }
    const cache = reactive({})

    async function load(serviceId, { force = false } = {}) {
        if (!serviceId) return
        if (!force && cache[serviceId] && !cache[serviceId].error && !cache[serviceId].loading) return
        // Carry prior beacon states across a (forced) reload so enriched columns / status filters
        // don't blank out mid-refresh; the caller re-enriches right after and updates them.
        const prev = cache[serviceId] || {}
        const keep = { states: prev.states, statesSource: prev.statesSource }
        cache[serviceId] = { loading: true, keys: [], error: '', ...keep }
        try {
            const res = await window.api.invoke('list-validators', resolveNodeId(), serviceId)
            cache[serviceId] = res?.ok
                ? { loading: false, keys: res.keys || [], error: '', ...keep }
                : { loading: false, keys: [], error: res?.error || (res?.reason === 'api-not-enabled' ? 'Keymanager API not enabled' : 'Could not read keys'), ...keep }
        } catch (e) {
            cache[serviceId] = { loading: false, keys: [], error: e?.message || 'Could not read keys', ...keep }
        }
    }

    /**
     * Enrich a service's already-loaded keys with on-chain beacon state (status/balance/etc.),
     * merged by pubkey. Only meaningful for on-chain holders (solo VC keys, Charon DV pubkeys) -
     * the caller gates this off share holders. `beaconUrl` overrides the node's own beacon.
     */
    async function loadStates(serviceId, pubkeys, beaconUrl) {
        if (!serviceId || !pubkeys?.length) return
        cache[serviceId] = { ...(cache[serviceId] || { keys: [] }), statesLoading: true, statesError: '' }
        try {
            const res = await window.api.invoke('get-validator-states', resolveNodeId(), pubkeys, beaconUrl || null)
            cache[serviceId] = {
                ...cache[serviceId],
                statesLoading: false,
                states: res?.ok ? (res.states || {}) : (cache[serviceId].states || {}),
                statesError: res?.ok ? '' : (res?.error || 'Could not load validator stats'),
                statesSource: res?.source,
            }
        } catch (e) {
            cache[serviceId] = { ...cache[serviceId], statesLoading: false, statesError: e?.message || 'Could not load validator stats' }
        }
    }

    const state = (serviceId) => cache[serviceId] ?? { loading: false, keys: [], error: '' }

    return { cache, load, loadStates, state }
}
