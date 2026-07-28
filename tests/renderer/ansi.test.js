import { describe, it, expect } from 'vitest'
import { parseAnsi, stripAnsi } from '@utils/ansi'

const ESC = '\x1b'

describe('stripAnsi', () => {
    it('removes SGR sequences', () => {
        expect(stripAnsi(`${ESC}[31mhello${ESC}[0m`)).toBe('hello')
    })
    it('removes cursor-movement / erase CSI sequences too', () => {
        expect(stripAnsi(`a${ESC}[2Kb${ESC}[3;5Hc`)).toBe('abc')
    })
    it('passes through plain text unchanged', () => {
        expect(stripAnsi('no escapes here')).toBe('no escapes here')
    })
})

describe('parseAnsi', () => {
    it('returns a single segment with no classes when input is plain text', () => {
        expect(parseAnsi('hello')).toEqual([{ text: 'hello', classes: [] }])
    })

    it('returns an empty array for an empty string', () => {
        expect(parseAnsi('')).toEqual([])
    })

    it('tags a coloured segment with its ANSI class', () => {
        const segs = parseAnsi(`${ESC}[31mred text${ESC}[0m`)
        expect(segs).toEqual([{ text: 'red text', classes: ['ansi-red'] }])
    })

    it('emits surrounding plain text as separate unstyled segments', () => {
        const segs = parseAnsi(`pre ${ESC}[32mgreen${ESC}[0m post`)
        expect(segs).toEqual([
            { text: 'pre ', classes: [] },
            { text: 'green', classes: ['ansi-green'] },
            { text: ' post', classes: [] },
        ])
    })

    it('combines style attributes via semicolons (bold + colour)', () => {
        const segs = parseAnsi(`${ESC}[1;33mbold-yellow${ESC}[0m`)
        expect(segs[0].classes).toEqual(expect.arrayContaining(['ansi-yellow', 'ansi-bold']))
    })

    it('resets style with code 0 (bare ESC[m equivalent)', () => {
        const segs = parseAnsi(`${ESC}[31ma${ESC}[mb`)
        expect(segs).toEqual([
            { text: 'a', classes: ['ansi-red'] },
            { text: 'b', classes: [] },
        ])
    })

    it('treats SGR 22 as cancelling bold + dim only (other styles persist)', () => {
        const segs = parseAnsi(`${ESC}[1;2;4ma${ESC}[22mb`)
        expect(segs[0].classes).toEqual(expect.arrayContaining(['ansi-bold', 'ansi-dim', 'ansi-underline']))
        expect(segs[1].classes).toContain('ansi-underline')
        expect(segs[1].classes).not.toContain('ansi-bold')
        expect(segs[1].classes).not.toContain('ansi-dim')
    })

    it('SGR 39 resets only foreground colour', () => {
        const segs = parseAnsi(`${ESC}[1;31ma${ESC}[39mb`)
        expect(segs[0].classes).toEqual(expect.arrayContaining(['ansi-red', 'ansi-bold']))
        expect(segs[1].classes).toEqual(['ansi-bold'])
    })

    it('maps bright foreground (90-97) to ansi-br-<colour>', () => {
        const segs = parseAnsi(`${ESC}[94mblue${ESC}[0m`)
        expect(segs[0].classes).toContain('ansi-br-blue')
    })

    it('silently consumes non-SGR CSI sequences (cursor / erase)', () => {
        const segs = parseAnsi(`a${ESC}[2Kb${ESC}[3Hc`)
        expect(segs).toEqual([
            { text: 'a', classes: [] },
            { text: 'b', classes: [] },
            { text: 'c', classes: [] },
        ])
    })

    it('skips 256-colour foreground triplet (ESC[38;5;Nm) without affecting following text', () => {
        const segs = parseAnsi(`${ESC}[38;5;202morange${ESC}[0m next`)
        // 256-colour codes are intentionally not mapped - segment should carry no fg class
        expect(segs[0].text).toBe('orange')
        expect(segs[0].classes).not.toContain(expect.stringMatching(/^ansi-/))
        expect(segs[1].text).toBe(' next')
    })

    it('skips 24-bit RGB foreground (ESC[38;2;R;G;Bm) without breaking parsing', () => {
        const segs = parseAnsi(`${ESC}[38;2;255;100;50morange${ESC}[0m tail`)
        expect(segs[0].text).toBe('orange')
        expect(segs.map(s => s.text).join('')).toBe('orange tail')
    })

    it('preserves style across consecutive segments separated by plain text', () => {
        const segs = parseAnsi(`${ESC}[31mfoo${ESC}[1m bar${ESC}[0m baz`)
        expect(segs[0].classes).toEqual(['ansi-red'])
        expect(segs[1].classes).toEqual(expect.arrayContaining(['ansi-red', 'ansi-bold']))
        expect(segs[2].classes).toEqual([])
    })

    it('lone reset (ESC[0m) emits no segments when surrounded by no text', () => {
        expect(parseAnsi(`${ESC}[0m`)).toEqual([])
    })
})
