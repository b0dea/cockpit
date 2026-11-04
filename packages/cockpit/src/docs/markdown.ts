// The Markdown reading shared by the repository's own docs lint and `cockpit docs check`: one walker,
// so both agree on what counts as prose, code and a link.

export interface ProseLine { readonly line: number; readonly prose: string; readonly comments: readonly string[] }
export interface MarkdownLink { readonly line: number; readonly label: string; readonly target: string; readonly index: number; readonly end: number }
export interface WalkedMarkdown {
    readonly lines: readonly ProseLine[]
    readonly fences: readonly Readonly<{ line: number; info: string }>[]
    /** Each line inside a fenced block, with the info string of its fence. */
    readonly fencedLines: readonly Readonly<{ line: number; info: string; text: string }>[]
    readonly links: readonly MarkdownLink[]
}

/** The visible prose of a page, line by line: fenced code and front matter removed, HTML comments lifted out. */
export function walkMarkdownProse(body: string): WalkedMarkdown {
    const lines: ProseLine[] = []
    const fences: { line: number; info: string }[] = []
    const fencedLines: { line: number; info: string; text: string }[] = []
    const links: MarkdownLink[] = []
    const rows = body.split(/\r?\n/)
    let fence: string | undefined
    const start = rows[0] === '---' ? rows.indexOf('---', 1) + 1 : 0
    let comment: { line: number; text: string } | undefined
    for (let index = start; index < rows.length; index += 1) {
        const number = index + 1
        let text = rows[index]!
        const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(text)
        if (fence !== undefined) {
            if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = undefined
            else fencedLines.push({ line: number, info: fences.at(-1)!.info, text })
            continue
        }
        if (marker && comment === undefined) {
            fence = marker[1]!
            fences.push({ line: number, info: marker[2]!.trim() })
            continue
        }
        const comments: string[] = []
        let prose = ''
        while (text !== '') {
            if (comment) {
                const close = text.indexOf('-->')
                comment.text += ` ${close === -1 ? text : text.slice(0, close)}`
                if (close === -1) { text = ''; break }
                text = text.slice(close + 3)
                const owner = lines.find(row => row.line === comment!.line)
                const done = comment.text.trim().replace(/\s+/g, ' ')
                if (owner) (owner.comments as string[]).push(done)
                else comments.push(done)
                comment = undefined
                continue
            }
            const open = text.indexOf('<!--')
            if (open === -1) { prose += text; break }
            prose += text.slice(0, open)
            comment = { line: number, text: '' }
            text = text.slice(open + 4)
        }
        lines.push({ line: number, prose, comments })
        const visible = prose.replace(/`+[^`]*`+/g, span => ' '.repeat(span.length))
        for (const match of visible.matchAll(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g)) {
            links.push({ line: number, label: match[1]!, target: match[2]!, index: match.index, end: match.index + match[0].length })
        }
    }
    if (comment) throw new Error(`HTML comment opened on line ${comment.line} is not closed`)
    return { lines, fences, fencedLines, links }
}
