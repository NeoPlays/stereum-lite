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
    // serviceId -> { loading, keys: [{ pubkey, readonly, derivationPath? }], error }
    const cache = reactive({})

    async function load(serviceId, { force = false } = {}) {
        if (!serviceId) return
        if (!force && cache[serviceId] && !cache[serviceId].error && !cache[serviceId].loading) return
        cache[serviceId] = { loading: true, keys: [], error: '' }
        try {
            const res = await window.api.invoke('list-validators', unref(nodeId), serviceId)
            cache[serviceId] = res?.ok
                ? { loading: false, keys: res.keys || [], error: '' }
                : { loading: false, keys: [], error: res?.error || (res?.reason === 'api-not-enabled' ? 'Keymanager API not enabled' : 'Could not read keys') }
        } catch (e) {
            cache[serviceId] = { loading: false, keys: [], error: e?.message || 'Could not read keys' }
        }
    }

    const state = (serviceId) => cache[serviceId] ?? { loading: false, keys: [], error: '' }

    return { cache, load, state }
}
