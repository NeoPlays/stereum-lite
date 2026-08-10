import { describe, it, expect } from 'vitest'
import {
    CHECKPOINT_CHECK_PATH,
    normalizeCheckpointUrl,
    buildCheckpointProbeScript,
    parseCheckpointResult,
} from '@main/nodes/checkpoint'

describe('normalizeCheckpointUrl', () => {
    it('trims and strips a trailing slash', () => {
        expect(normalizeCheckpointUrl('  https://beaconstate.info/  ')).toBe('https://beaconstate.info')
        expect(normalizeCheckpointUrl('https://x.io///')).toBe('https://x.io')
    })
    it('accepts http(s) with host, port and path', () => {
        expect(normalizeCheckpointUrl('http://10.0.0.5:5052/base')).toBe('http://10.0.0.5:5052/base')
    })
    it('rejects non-URLs and shell/glob metacharacters', () => {
        for (const bad of ['', 'ftp://x.io', 'notaurl', 'https://x.io/$(rm)', "https://x.io/'", 'https://x.io/;ls', 'https://x.io/*', undefined, null, 42]) {
            expect(normalizeCheckpointUrl(bad)).toBeNull()
        }
    })
})

describe('buildCheckpointProbeScript', () => {
    it('probes the finalized-state endpoint HEAD-only with the finalized path appended', () => {
        const script = buildCheckpointProbeScript('https://beaconstate.info/')
        expect(script).toContain(`'https://beaconstate.info${CHECKPOINT_CHECK_PATH}'`)
        expect(script).toContain('--head')       // headers only - never downloads the huge SSZ state
        expect(script).toContain('--max-time 5')
        expect(script).toContain("-w '%{http_code}'")
    })
    it('returns null for an invalid URL (caller aborts)', () => {
        expect(buildCheckpointProbeScript('nope')).toBeNull()
    })
})

describe('parseCheckpointResult', () => {
    it('accepts iff the status is exactly 200', () => {
        expect(parseCheckpointResult('200')).toEqual({ ok: true, httpCode: 200 })
        expect(parseCheckpointResult(' 200 \n')).toEqual({ ok: true, httpCode: 200 })
    })
    it('rejects a non-200 status and surfaces the code', () => {
        expect(parseCheckpointResult('404')).toMatchObject({ ok: false, httpCode: 404 })
        expect(parseCheckpointResult('503')).toMatchObject({ ok: false, httpCode: 503 })
    })
    it('reports unreachable for an empty body or curl\'s `000` (timeout / connection failure)', () => {
        expect(parseCheckpointResult('')).toEqual({ ok: false, error: 'Endpoint unreachable or timed out' })
        expect(parseCheckpointResult('000')).toEqual({ ok: false, error: 'Endpoint unreachable or timed out' })
    })
})
