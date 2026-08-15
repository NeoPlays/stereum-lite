// ANSI handling for log rendering: only SGR ('m') affects styling; other CSI sequences are stripped silently.

// eslint-disable-next-line no-control-regex -- matching the ESC control character is the job here
const CSI = /\x1b\[[0-9;]*[a-zA-Z]/g

const FG = {
    30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
    90: 'br-black', 91: 'br-red', 92: 'br-green', 93: 'br-yellow', 94: 'br-blue', 95: 'br-magenta', 96: 'br-cyan', 97: 'br-white',
}

function emptyStyle() {
    return { fg: null, bold: false, dim: false, italic: false, underline: false }
}

function styleClasses(style) {
    const classes = []
    if (style.fg) classes.push(`ansi-${style.fg}`)
    if (style.bold) classes.push('ansi-bold')
    if (style.dim) classes.push('ansi-dim')
    if (style.italic) classes.push('ansi-italic')
    if (style.underline) classes.push('ansi-underline')
    return classes
}

/** Remove every CSI escape sequence (for clipboard copy / plain-text export). */
export function stripAnsi(s) {
    return s.replace(CSI, '')
}

/**
 * Parse a single line into styled segments.
 * @param {string} line
 * @returns {{ text: string, classes: string[] }[]}
 */
export function parseAnsi(line) {
    const segments = []
    // eslint-disable-next-line no-control-regex -- matching the ESC control character is the job here
    const re = /\x1b\[([0-9;]*)([a-zA-Z])/g
    let last = 0
    let style = emptyStyle()
    const push = (text) => {
        if (!text) return
        segments.push({ text, classes: styleClasses(style) })
    }
    let m
    while ((m = re.exec(line)) !== null) {
        push(line.slice(last, m.index))
        last = m.index + m[0].length
        if (m[2] !== 'm') continue
        const codes = m[1] === '' ? [0] : m[1].split(';').map(n => Number(n) || 0)
        for (let i = 0; i < codes.length; i++) {
            const c = codes[i]
            if (c === 0) style = emptyStyle()
            else if (c === 1) style.bold = true
            else if (c === 2) style.dim = true
            else if (c === 3) style.italic = true
            else if (c === 4) style.underline = true
            else if (c === 22) { style.bold = false; style.dim = false }
            else if (c === 23) style.italic = false
            else if (c === 24) style.underline = false
            else if (c === 39) style.fg = null
            else if (FG[c]) style.fg = FG[c]
            else if (c === 38 && codes[i + 1] === 5) i += 2   // skip 256-color index
            else if (c === 38 && codes[i + 1] === 2) i += 4   // skip RGB triplet
            // background colours (40-49, 100-107) intentionally ignored
        }
    }
    push(line.slice(last))
    return segments
}
