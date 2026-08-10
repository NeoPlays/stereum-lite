/**
 * Checkpoint-sync URL validation: pure, unit-testable helpers mirroring stereum's
 * one-click installer check (launcher/src/backend/Monitoring.js `isCheckpointValid`).
 * Stereum GETs `<url>/eth/v2/debug/beacon/states/finalized` with `--head` + a 5s
 * timeout and accepts the source iff the status is 200 - it reads only the status,
 * never the (multi-hundred-MB SSZ) body, and does no cross-provider comparison.
 *
 * The exec side lives in Node.checkCheckpointSync; everything here is side-effect-free.
 */
export const CHECKPOINT_CHECK_PATH = '/eth/v2/debug/beacon/states/finalized'
export const CHECKPOINT_CHECK_TIMEOUT_S = 5

/**
 * Trim + validate a checkpoint base URL, returning it without a trailing slash, or
 * null if it isn't a plain http(s) URL. The allowlist rejects any shell/glob
 * metacharacter (the URL is embedded in a docker curl command run over SSH); real
 * checkpoint endpoints only use scheme/host/port/path characters.
 */
export function normalizeCheckpointUrl(url) {
    if (typeof url !== 'string') return null
    const trimmed = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[A-Za-z0-9._:/-]+$/i.test(trimmed)) return null
    return trimmed
}

/**
 * The inner `sh -c` script that HEAD-probes the finalized-state endpoint and prints
 * just the HTTP status code. Returns null for an invalid URL (caller must abort).
 * `--head -X GET` fetches headers only, so the huge finalized state is never downloaded.
 */
export function buildCheckpointProbeScript(url) {
    const base = normalizeCheckpointUrl(url)
    if (!base) return null
    const target = base + CHECKPOINT_CHECK_PATH
    return `curl -s -o /dev/null --head --max-time ${CHECKPOINT_CHECK_TIMEOUT_S}` +
        ` -w '%{http_code}' -X GET -H 'Accept: application/octet-stream' '${target}'`
}

/**
 * Parse the probe's stdout (the HTTP status code) into a result.
 * @returns {{ ok: boolean, httpCode?: number, error?: string }}
 */
export function parseCheckpointResult(stdout) {
    const code = parseInt(String(stdout ?? '').trim().match(/\b\d{3}\b/)?.[0] ?? '', 10)
    if (code === 200) return { ok: true, httpCode: 200 }
    // curl writes `000` for http_code when it never connected (timeout / DNS / refused).
    if (Number.isFinite(code) && code > 0) return { ok: false, httpCode: code, error: `Endpoint responded HTTP ${code}` }
    return { ok: false, error: 'Endpoint unreachable or timed out' }
}
