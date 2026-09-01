import { describe, it, expect } from 'vitest'
import {
    INTERCHANGE_FORMAT_VERSION, parseInterchange, validateInterchange, interchangeSummary,
    hasStringNumerics,
} from '@main/nodes/slashingProtection'

const GVR = '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'
const KEY_A = '0x' + 'a'.repeat(96)
const KEY_B = '0x' + 'b'.repeat(96)

const block = (slot = '81952') => ({ slot, signing_root: '0x' + '1'.repeat(64) })
const attestation = (source = '2290', target = '3007') => ({
    source_epoch: source,
    target_epoch: target,
    signing_root: '0x' + '2'.repeat(64),
})

/** A well-formed EIP-3076 file. Overrides are shallow-merged into metadata/data. */
function file({ version = '5', root = GVR, data } = {}) {
    return JSON.stringify({
        metadata: { interchange_format_version: version, genesis_validators_root: root },
        data: data ?? [{ pubkey: KEY_A, signed_blocks: [block()], signed_attestations: [attestation()] }],
    })
}

describe('parseInterchange', () => {
    it('parses a valid file', () => {
        const result = parseInterchange(file())
        expect(result.ok).toBe(true)
        expect(result.json.metadata.genesis_validators_root).toBe(GVR)
    })

    it('reports unreadable JSON', () => {
        const result = parseInterchange('{ "metadata": ')
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/not valid json/i)
    })

    it('rejects a JSON array or scalar (parses, but is not an interchange file)', () => {
        expect(parseInterchange('[]').ok).toBe(false)
        expect(parseInterchange('42').ok).toBe(false)
        expect(parseInterchange('null').ok).toBe(false)
    })

    it('reports an empty file distinctly from a parse error', () => {
        expect(parseInterchange('').error).toMatch(/empty/i)
        expect(parseInterchange('   \n ').error).toMatch(/empty/i)
    })

    it('tolerates undefined / null / non-string input', () => {
        for (const input of [undefined, null, 42, {}, []]) {
            const result = parseInterchange(input)
            expect(result.ok).toBe(false)
            expect(typeof result.error).toBe('string')
        }
    })
})

describe('validateInterchange - the happy path', () => {
    it('passes a valid file cleanly', () => {
        const result = validateInterchange(file(), { pubkeys: [KEY_A], genesisValidatorsRoot: GVR })
        expect(result).toEqual({ ok: true, errors: [], warnings: [], covered: [KEY_A], missing: [] })
    })

    it('passes with no pubkeys and no expected GVR supplied', () => {
        const result = validateInterchange(file())
        expect(result.ok).toBe(true)
        expect(result.missing).toEqual([])
    })

    it('accepts a numeric interchange_format_version of 5 (compared as a string)', () => {
        const text = JSON.stringify({
            metadata: { interchange_format_version: 5, genesis_validators_root: GVR },
            data: [{ pubkey: KEY_A, signed_blocks: [block()], signed_attestations: [] }],
        })
        expect(validateInterchange(text, { pubkeys: [KEY_A] }).ok).toBe(true)
    })

    it('exports the pinned format version', () => {
        expect(INTERCHANGE_FORMAT_VERSION).toBe('5')
    })
})

describe('validateInterchange - blocking: unreadable file', () => {
    it('blocks on unparseable JSON and reports every key as missing', () => {
        const result = validateInterchange('not json at all', { pubkeys: [KEY_A, KEY_B] })
        expect(result.ok).toBe(false)
        expect(result.errors).toHaveLength(1)
        expect(result.covered).toEqual([])
        expect(result.missing).toEqual([KEY_A, KEY_B])
    })

    it('tolerates undefined / null / garbage input without throwing', () => {
        for (const input of [undefined, null, 0, {}, []]) {
            const result = validateInterchange(input)
            expect(result.ok).toBe(false)
            expect(result.errors.length).toBeGreaterThan(0)
        }
        expect(() => validateInterchange(file(), null)).not.toThrow()
    })
})

describe('validateInterchange - blocking: format version', () => {
    it('blocks a version other than 5 and names the actual value', () => {
        const result = validateInterchange(file({ version: '4' }), { pubkeys: [KEY_A] })
        expect(result.ok).toBe(false)
        expect(result.errors.join(' ')).toContain('"4"')
    })

    it('blocks a missing version', () => {
        const text = JSON.stringify({ metadata: { genesis_validators_root: GVR }, data: [] })
        const result = validateInterchange(text)
        expect(result.ok).toBe(false)
        expect(result.errors.join(' ')).toMatch(/interchange_format_version/)
    })

    it('blocks when metadata is missing entirely', () => {
        const result = validateInterchange(JSON.stringify({ data: [] }))
        expect(result.ok).toBe(false)
        expect(result.errors.join(' ')).toMatch(/interchange_format_version/)
        expect(result.errors.join(' ')).toMatch(/genesis_validators_root/)
    })
})

describe('validateInterchange - blocking: genesis validators root', () => {
    it('blocks a missing genesis_validators_root', () => {
        const text = JSON.stringify({ metadata: { interchange_format_version: '5' }, data: [] })
        const result = validateInterchange(text)
        expect(result.ok).toBe(false)
        expect(result.errors.join(' ')).toMatch(/genesis_validators_root/)
    })

    it('blocks history from another chain', () => {
        const other = '0x' + '9'.repeat(64)
        const result = validateInterchange(file({ root: other }), { pubkeys: [KEY_A], genesisValidatorsRoot: GVR })
        expect(result.ok).toBe(false)
        expect(result.errors.join(' ')).toMatch(/wrong chain/i)
    })

    it('accepts a GVR differing only in case', () => {
        const upper = '0x4B363DB94E286120D76EB905340FDD4E54BFE9F06BF33FF6CF5AD27F511BFE95'
        const result = validateInterchange(file({ root: upper }), { pubkeys: [KEY_A], genesisValidatorsRoot: GVR })
        expect(result.ok).toBe(true)
        expect(result.errors).toEqual([])
    })

    it('does not compare when no expected GVR is supplied', () => {
        const other = '0x' + '9'.repeat(64)
        expect(validateInterchange(file({ root: other }), { pubkeys: [KEY_A] }).ok).toBe(true)
        expect(validateInterchange(file({ root: other }), { pubkeys: [KEY_A], genesisValidatorsRoot: '' }).ok).toBe(true)
        expect(validateInterchange(file({ root: other }), { pubkeys: [KEY_A], genesisValidatorsRoot: null }).ok).toBe(true)
    })
})

describe('validateInterchange - blocking: data array', () => {
    it('blocks when data is not an array', () => {
        for (const data of [undefined, null, {}, 'x']) {
            const text = JSON.stringify({
                metadata: { interchange_format_version: '5', genesis_validators_root: GVR },
                data,
            })
            const result = validateInterchange(text, { pubkeys: [KEY_A] })
            expect(result.ok).toBe(false)
            expect(result.errors.join(' ')).toMatch(/data/)
            expect(result.missing).toEqual([KEY_A])
        }
    })
})

describe('validateInterchange - blocking: missing pubkeys', () => {
    it('blocks when one of several keys has no entry', () => {
        const data = [{ pubkey: KEY_A, signed_blocks: [block()], signed_attestations: [attestation()] }]
        const result = validateInterchange(file({ data }), { pubkeys: [KEY_A, KEY_B], genesisValidatorsRoot: GVR })
        expect(result.ok).toBe(false)
        expect(result.covered).toEqual([KEY_A])
        expect(result.missing).toEqual([KEY_B])
    })

    it('counts a pubkey present with different casing as covered', () => {
        const data = [{ pubkey: KEY_A.toUpperCase().replace('0X', '0x'), signed_blocks: [block()], signed_attestations: [] }]
        const result = validateInterchange(file({ data }), { pubkeys: [KEY_A], genesisValidatorsRoot: GVR })
        expect(result.missing).toEqual([])
        expect(result.covered).toEqual([KEY_A])
        expect(result.errors).toEqual([])
    })

    it('matches a requested pubkey given in upper case', () => {
        const result = validateInterchange(file(), { pubkeys: [KEY_A.toUpperCase().replace('0X', '0x')] })
        expect(result.missing).toEqual([])
    })

    it('reports every key missing when data is empty', () => {
        const result = validateInterchange(file({ data: [] }), { pubkeys: [KEY_A, KEY_B] })
        expect(result.ok).toBe(false)
        expect(result.missing).toEqual([KEY_A, KEY_B])
        expect(result.covered).toEqual([])
    })

    it('dedups repeated requested keys and repeated data entries', () => {
        const data = [
            { pubkey: KEY_A, signed_blocks: [block()], signed_attestations: [] },
            { pubkey: KEY_A, signed_blocks: [block('81953')], signed_attestations: [] },
        ]
        const result = validateInterchange(file({ data }), { pubkeys: [KEY_A, KEY_A] })
        expect(result.covered).toEqual([KEY_A])
        expect(result.missing).toEqual([])
    })

    it('ignores entries with a blank or absent pubkey', () => {
        const data = [{ signed_blocks: [block()] }, { pubkey: '   ' }]
        const result = validateInterchange(file({ data }), { pubkeys: [KEY_A] })
        expect(result.covered).toEqual([])
        expect(result.missing).toEqual([KEY_A])
    })
})

describe('hasStringNumerics', () => {
    it('is true for a file whose slots and epochs are strings', () => {
        expect(hasStringNumerics(JSON.parse(file()))).toBe(true)
    })

    it('is false for a numeric slot', () => {
        const data = [{ pubkey: KEY_A, signed_blocks: [{ slot: 81952 }], signed_attestations: [] }]
        expect(hasStringNumerics(JSON.parse(file({ data })))).toBe(false)
    })

    it('is false for a numeric source_epoch or target_epoch', () => {
        const source = [{ pubkey: KEY_A, signed_blocks: [], signed_attestations: [{ source_epoch: 2290, target_epoch: '3007' }] }]
        const target = [{ pubkey: KEY_A, signed_blocks: [], signed_attestations: [{ source_epoch: '2290', target_epoch: 3007 }] }]
        expect(hasStringNumerics(JSON.parse(file({ data: source })))).toBe(false)
        expect(hasStringNumerics(JSON.parse(file({ data: target })))).toBe(false)
    })

    it('finds a numeric field on any entry, not just the first', () => {
        const data = [
            { pubkey: KEY_A, signed_blocks: [block()], signed_attestations: [attestation()] },
            { pubkey: KEY_B, signed_blocks: [{ slot: 5 }], signed_attestations: [] },
        ]
        expect(hasStringNumerics(JSON.parse(file({ data })))).toBe(false)
    })

    it('accepts raw text as well as a parsed object', () => {
        const data = [{ pubkey: KEY_A, signed_blocks: [{ slot: 1 }], signed_attestations: [] }]
        expect(hasStringNumerics(file({ data }))).toBe(false)
        expect(hasStringNumerics(file())).toBe(true)
    })

    it('is true (nothing to find) for garbage input', () => {
        for (const input of [undefined, null, 'not json', 42, {}, { data: 'x' }, { data: [null, 1] }]) {
            expect(hasStringNumerics(input)).toBe(true)
        }
    })

    it('does not mutate the input', () => {
        const json = JSON.parse(file())
        const before = JSON.stringify(json)
        hasStringNumerics(json)
        validateInterchange(JSON.stringify(json), { pubkeys: [KEY_A], genesisValidatorsRoot: GVR })
        expect(JSON.stringify(json)).toBe(before)
    })
})

describe('validateInterchange - blocking: numeric uint64 fields', () => {
    it('blocks a file with numeric slots even though every other rule passes', () => {
        // Built via JSON.parse rather than a literal, which is exactly how the corruption arises
        // in the wild: a file whose slot was written as a JSON number, decoded into a float.
        const slot = JSON.parse('9007199254740993')
        const data = [{ pubkey: KEY_A, signed_blocks: [{ slot }], signed_attestations: [] }]
        const result = validateInterchange(file({ data }), { pubkeys: [KEY_A], genesisValidatorsRoot: GVR })
        expect(result.ok).toBe(false)
        expect(result.errors.join(' ')).toMatch(/strings/i)
        expect(result.covered).toEqual([KEY_A]) // still parsed enough to know the key is there
    })
})

describe('validateInterchange - warnings', () => {
    it('warns about an entry with neither signed blocks nor attestations', () => {
        const data = [{ pubkey: KEY_A, signed_blocks: [], signed_attestations: [] }]
        const result = validateInterchange(file({ data }), { pubkeys: [KEY_A], genesisValidatorsRoot: GVR })
        expect(result.ok).toBe(true) // a warning must never block
        expect(result.warnings).toHaveLength(1)
        expect(result.warnings[0]).toContain(KEY_A)
    })

    it('warns when both fields are absent entirely', () => {
        const result = validateInterchange(file({ data: [{ pubkey: KEY_A }] }), { pubkeys: [KEY_A] })
        expect(result.warnings).toHaveLength(1)
    })

    it('does not warn when only one of the two is empty', () => {
        const onlyBlocks = [{ pubkey: KEY_A, signed_blocks: [block()], signed_attestations: [] }]
        const onlyAtts = [{ pubkey: KEY_A, signed_blocks: [], signed_attestations: [attestation()] }]
        expect(validateInterchange(file({ data: onlyBlocks }), { pubkeys: [KEY_A] }).warnings).toEqual([])
        expect(validateInterchange(file({ data: onlyAtts }), { pubkeys: [KEY_A] }).warnings).toEqual([])
    })

    it('warns only about keys being imported when pubkeys are supplied', () => {
        const data = [
            { pubkey: KEY_A, signed_blocks: [block()], signed_attestations: [attestation()] },
            { pubkey: KEY_B, signed_blocks: [], signed_attestations: [] },
        ]
        expect(validateInterchange(file({ data }), { pubkeys: [KEY_A] }).warnings).toEqual([])
        expect(validateInterchange(file({ data }), { pubkeys: [KEY_B] }).warnings).toHaveLength(1)
    })

    it('warns about every empty entry when no pubkeys are supplied', () => {
        const data = [
            { pubkey: KEY_A, signed_blocks: [], signed_attestations: [] },
            { pubkey: KEY_B, signed_blocks: [], signed_attestations: [] },
        ]
        expect(validateInterchange(file({ data })).warnings).toHaveLength(2)
    })
})

describe('interchangeSummary', () => {
    it('counts pubkeys, blocks and attestations across entries', () => {
        const data = [
            { pubkey: KEY_A, signed_blocks: [block(), block('81953')], signed_attestations: [attestation()] },
            { pubkey: KEY_B, signed_blocks: [], signed_attestations: [attestation(), attestation('2291', '3008')] },
        ]
        expect(interchangeSummary(file({ data }))).toEqual({
            pubkeyCount: 2,
            blockCount: 2,
            attestationCount: 3,
            genesisValidatorsRoot: GVR,
        })
    })

    it('handles missing data and metadata without throwing', () => {
        expect(interchangeSummary('{}')).toEqual({
            pubkeyCount: 0, blockCount: 0, attestationCount: 0, genesisValidatorsRoot: null,
        })
    })

    it('returns null for anything unreadable', () => {
        for (const input of [undefined, null, '', 'not json', '[]', 42]) {
            expect(interchangeSummary(input)).toBeNull()
        }
    })
})
