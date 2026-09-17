'use client'

/**
 * Discord-style markdown tables, extracted as a pure parser so the renderer
 * and the node test share one source of truth.
 *
 * A table is a header row immediately followed by a separator row of
 * |---|---| cells (leading/trailing pipes optional, at least two columns).
 * Alignment is read from the separator: :--- left (default), :--: center,
 * ---: right. Body rows follow until the first line without a pipe.
 *
 * Known limitation this wave: cell splitting does NOT respect inline code.
 * Every pipe in a row is a cell boundary, so `` `a|b` `` becomes two cells.
 */

export type TableAlign = 'left' | 'center' | 'right'

export type ParsedTable = {
  header: string[]
  aligns: TableAlign[]
  rows: string[][]
}

/** Split one table line into trimmed cells. An optional leading/trailing
 *  pipe is dropped first; every remaining pipe is a hard boundary. */
function splitCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((cell) => cell.trim())
}

/** Parse a separator row into per-column alignments, or null when the row
 *  is not a valid separator (fewer than two dash cells, or a non-dash cell). */
function parseSeparator(line: string): TableAlign[] | null {
  const cells = splitCells(line)
  if (cells.length < 2) return null
  const aligns: TableAlign[] = []
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    aligns.push(left && right ? 'center' : right ? 'right' : 'left')
  }
  return aligns
}

/** Parse a table whose header is lines[0] and separator is lines[1]. Body
 *  rows are consumed from lines[2] while they contain a pipe. Returns null
 *  when the block is not a table (bad separator, column mismatch, or a
 *  single-column header). */
export function parseTableBlock(lines: string[]): ParsedTable | null {
  if (!Array.isArray(lines) || lines.length < 2) return null

  const header = splitCells(lines[0])
  if (header.length < 2) return null

  const aligns = parseSeparator(lines[1])
  if (!aligns || aligns.length !== header.length) return null

  const rows: string[][] = []
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].includes('|')) break
    const cells = splitCells(lines[i])
    rows.push(header.map((_, ci) => cells[ci] ?? ''))
  }

  return { header, aligns, rows }
}
