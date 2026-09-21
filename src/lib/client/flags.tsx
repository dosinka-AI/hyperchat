'use client'

import { Fragment, type ReactNode } from 'react'

/** Real flag glyphs. Windows renders regional-indicator pairs as letters
 *  ("US"), so every pair of regional indicators is drawn from the bundled
 *  twemoji flag set in /public/flags instead of trusting the font. */

const REGIONAL_START = 0x1f1e6
const REGIONAL_END = 0x1f1ff

function isRegional(cp: number): boolean {
  return cp >= REGIONAL_START && cp <= REGIONAL_END
}

/** Map one flag pair (two regional indicator codepoints) to its bundled
 *  svg path, or null when the pair has no shipped glyph (fake flags stay
 *  as text so nothing renders broken). */
export function flagSrc(pair: string): string | null {
  // each regional indicator is an astral codepoint (2 UTF-16 units), so the
  // pair check counts CODEPOINTS, never .length (a pair is 4 utf-16 units)
  const cps = Array.from(pair)
  if (cps.length !== 2) return null
  const a = cps[0].codePointAt(0)!
  const b = cps[1].codePointAt(0)!
  if (!isRegional(a) || !isRegional(b)) return null
  const file = `${a.toString(16)}-${b.toString(16)}.svg`
  // every real pair ships as <a>-<b>.svg; subtag pairs like england are
  // tagged sequences that don't exist here, and missing files stay text
  return VALID_PAIRS.has(`${a.toString(16)}-${b.toString(16)}`) ? `/flags/${file}` : null
}

/** every pair with a shipped glyph (fake pairs stay as text) */
const VALID_PAIRS = new Set([
  '1f1e6-1f1e8',
  '1f1e6-1f1e9',
  '1f1e6-1f1ea',
  '1f1e6-1f1eb',
  '1f1e6-1f1ec',
  '1f1e6-1f1ee',
  '1f1e6-1f1f1',
  '1f1e6-1f1f2',
  '1f1e6-1f1f4',
  '1f1e6-1f1f6',
  '1f1e6-1f1f7',
  '1f1e6-1f1f8',
  '1f1e6-1f1f9',
  '1f1e6-1f1fa',
  '1f1e6-1f1fc',
  '1f1e6-1f1fd',
  '1f1e6-1f1ff',
  '1f1e7-1f1e6',
  '1f1e7-1f1e7',
  '1f1e7-1f1e9',
  '1f1e7-1f1ea',
  '1f1e7-1f1eb',
  '1f1e7-1f1ec',
  '1f1e7-1f1ed',
  '1f1e7-1f1ee',
  '1f1e7-1f1ef',
  '1f1e7-1f1f1',
  '1f1e7-1f1f2',
  '1f1e7-1f1f3',
  '1f1e7-1f1f4',
  '1f1e7-1f1f6',
  '1f1e7-1f1f7',
  '1f1e7-1f1f8',
  '1f1e7-1f1f9',
  '1f1e7-1f1fb',
  '1f1e7-1f1fc',
  '1f1e7-1f1fe',
  '1f1e7-1f1ff',
  '1f1e8-1f1e6',
  '1f1e8-1f1e8',
  '1f1e8-1f1e9',
  '1f1e8-1f1eb',
  '1f1e8-1f1ec',
  '1f1e8-1f1ed',
  '1f1e8-1f1ee',
  '1f1e8-1f1f0',
  '1f1e8-1f1f1',
  '1f1e8-1f1f2',
  '1f1e8-1f1f3',
  '1f1e8-1f1f4',
  '1f1e8-1f1f5',
  '1f1e8-1f1f7',
  '1f1e8-1f1fa',
  '1f1e8-1f1fb',
  '1f1e8-1f1fc',
  '1f1e8-1f1fd',
  '1f1e8-1f1fe',
  '1f1e8-1f1ff',
  '1f1e9-1f1ea',
  '1f1e9-1f1ec',
  '1f1e9-1f1ef',
  '1f1e9-1f1f0',
  '1f1e9-1f1f2',
  '1f1e9-1f1f4',
  '1f1e9-1f1ff',
  '1f1ea-1f1e6',
  '1f1ea-1f1e8',
  '1f1ea-1f1ea',
  '1f1ea-1f1ec',
  '1f1ea-1f1ed',
  '1f1ea-1f1f7',
  '1f1ea-1f1f8',
  '1f1ea-1f1f9',
  '1f1ea-1f1fa',
  '1f1eb-1f1ee',
  '1f1eb-1f1ef',
  '1f1eb-1f1f0',
  '1f1eb-1f1f2',
  '1f1eb-1f1f4',
  '1f1eb-1f1f7',
  '1f1ec-1f1e6',
  '1f1ec-1f1e7',
  '1f1ec-1f1e9',
  '1f1ec-1f1ea',
  '1f1ec-1f1eb',
  '1f1ec-1f1ec',
  '1f1ec-1f1ed',
  '1f1ec-1f1ee',
  '1f1ec-1f1f1',
  '1f1ec-1f1f2',
  '1f1ec-1f1f3',
  '1f1ec-1f1f5',
  '1f1ec-1f1f6',
  '1f1ec-1f1f7',
  '1f1ec-1f1f8',
  '1f1ec-1f1f9',
  '1f1ec-1f1fa',
  '1f1ec-1f1fc',
  '1f1ec-1f1fe',
  '1f1ed-1f1f0',
  '1f1ed-1f1f2',
  '1f1ed-1f1f3',
  '1f1ed-1f1f7',
  '1f1ed-1f1f9',
  '1f1ed-1f1fa',
  '1f1ee-1f1e8',
  '1f1ee-1f1e9',
  '1f1ee-1f1ea',
  '1f1ee-1f1f1',
  '1f1ee-1f1f2',
  '1f1ee-1f1f3',
  '1f1ee-1f1f4',
  '1f1ee-1f1f6',
  '1f1ee-1f1f7',
  '1f1ee-1f1f8',
  '1f1ee-1f1f9',
  '1f1ef-1f1ea',
  '1f1ef-1f1f2',
  '1f1ef-1f1f4',
  '1f1ef-1f1f5',
  '1f1f0-1f1ea',
  '1f1f0-1f1ec',
  '1f1f0-1f1ed',
  '1f1f0-1f1ee',
  '1f1f0-1f1f2',
  '1f1f0-1f1f3',
  '1f1f0-1f1f5',
  '1f1f0-1f1f7',
  '1f1f0-1f1fc',
  '1f1f0-1f1fe',
  '1f1f0-1f1ff',
  '1f1f1-1f1e6',
  '1f1f1-1f1e7',
  '1f1f1-1f1e8',
  '1f1f1-1f1ee',
  '1f1f1-1f1f0',
  '1f1f1-1f1f7',
  '1f1f1-1f1f8',
  '1f1f1-1f1f9',
  '1f1f1-1f1fa',
  '1f1f1-1f1fb',
  '1f1f1-1f1fe',
  '1f1f2-1f1e6',
  '1f1f2-1f1e8',
  '1f1f2-1f1e9',
  '1f1f2-1f1ea',
  '1f1f2-1f1eb',
  '1f1f2-1f1ec',
  '1f1f2-1f1ed',
  '1f1f2-1f1f0',
  '1f1f2-1f1f1',
  '1f1f2-1f1f2',
  '1f1f2-1f1f3',
  '1f1f2-1f1f4',
  '1f1f2-1f1f5',
  '1f1f2-1f1f6',
  '1f1f2-1f1f7',
  '1f1f2-1f1f8',
  '1f1f2-1f1f9',
  '1f1f2-1f1fa',
  '1f1f2-1f1fb',
  '1f1f2-1f1fc',
  '1f1f2-1f1fd',
  '1f1f2-1f1fe',
  '1f1f2-1f1ff',
  '1f1f3-1f1e6',
  '1f1f3-1f1e8',
  '1f1f3-1f1ea',
  '1f1f3-1f1eb',
  '1f1f3-1f1ec',
  '1f1f3-1f1ee',
  '1f1f3-1f1f1',
  '1f1f3-1f1f4',
  '1f1f3-1f1f5',
  '1f1f3-1f1f7',
  '1f1f3-1f1fa',
  '1f1f3-1f1ff',
  '1f1f4-1f1f2',
  '1f1f5-1f1e6',
  '1f1f5-1f1ea',
  '1f1f5-1f1eb',
  '1f1f5-1f1ec',
  '1f1f5-1f1ed',
  '1f1f5-1f1f0',
  '1f1f5-1f1f1',
  '1f1f5-1f1f2',
  '1f1f5-1f1f3',
  '1f1f5-1f1f7',
  '1f1f5-1f1f8',
  '1f1f5-1f1f9',
  '1f1f5-1f1fc',
  '1f1f5-1f1fe',
  '1f1f6-1f1e6',
  '1f1f7-1f1ea',
  '1f1f7-1f1f4',
  '1f1f7-1f1f8',
  '1f1f7-1f1fa',
  '1f1f7-1f1fc',
  '1f1f8-1f1e6',
  '1f1f8-1f1e7',
  '1f1f8-1f1e8',
  '1f1f8-1f1e9',
  '1f1f8-1f1ea',
  '1f1f8-1f1ec',
  '1f1f8-1f1ed',
  '1f1f8-1f1ee',
  '1f1f8-1f1ef',
  '1f1f8-1f1f0',
  '1f1f8-1f1f1',
  '1f1f8-1f1f2',
  '1f1f8-1f1f3',
  '1f1f8-1f1f4',
  '1f1f8-1f1f7',
  '1f1f8-1f1f8',
  '1f1f8-1f1f9',
  '1f1f8-1f1fb',
  '1f1f8-1f1fd',
  '1f1f8-1f1fe',
  '1f1f8-1f1ff',
  '1f1f9-1f1e6',
  '1f1f9-1f1e8',
  '1f1f9-1f1e9',
  '1f1f9-1f1eb',
  '1f1f9-1f1ec',
  '1f1f9-1f1ed',
  '1f1f9-1f1ef',
  '1f1f9-1f1f0',
  '1f1f9-1f1f1',
  '1f1f9-1f1f2',
  '1f1f9-1f1f3',
  '1f1f9-1f1f4',
  '1f1f9-1f1f7',
  '1f1f9-1f1f9',
  '1f1f9-1f1fb',
  '1f1f9-1f1fc',
  '1f1f9-1f1ff',
  '1f1fa-1f1e6',
  '1f1fa-1f1ec',
  '1f1fa-1f1f2',
  '1f1fa-1f1f3',
  '1f1fa-1f1f8',
  '1f1fa-1f1fe',
  '1f1fa-1f1ff',
  '1f1fb-1f1e6',
  '1f1fb-1f1e8',
  '1f1fb-1f1ea',
  '1f1fb-1f1ec',
  '1f1fb-1f1ee',
  '1f1fb-1f1f3',
  '1f1fb-1f1fa',
  '1f1fc-1f1eb',
  '1f1fc-1f1f8',
  '1f1fd-1f1f0',
  '1f1fe-1f1ea',
  '1f1fe-1f1f9',
  '1f1ff-1f1e6',
  '1f1ff-1f1f2',
  '1f1ff-1f1fc',
])

/** Split text into plain runs and flag pairs. Longer regional runs collapse
 *  into left-to-right pairs the way fonts do. */
export type FlagPart = { kind: 'text'; text: string } | { kind: 'flag'; pair: string; src: string }

export function splitFlagText(text: string): FlagPart[] {
  const parts: FlagPart[] = []
  let plain = ''
  let i = 0
  const cps = Array.from(text)
  while (i < cps.length) {
    const cp = cps[i].codePointAt(0)!
    if (isRegional(cp) && i + 1 < cps.length) {
      const next = cps[i + 1].codePointAt(0)!
      if (isRegional(next)) {
        const pair = cps[i] + cps[i + 1]
        const src = flagSrc(pair)
        if (src) {
          if (plain) parts.push({ kind: 'text', text: plain })
          plain = ''
          parts.push({ kind: 'flag', pair, src })
          i += 2
          continue
        }
      }
    }
    plain += cps[i]
    i += 1
  }
  if (plain) parts.push({ kind: 'text', text: plain })
  return parts
}

/** True when the string carries at least one renderable flag pair. */
export function hasFlags(text: string): boolean {
  for (const part of splitFlagText(text)) {
    if (part.kind === 'flag') return true
  }
  return false
}

/** Render text with flags as mixed text + inline images. Plain strings with
 *  no flags return fast without wrapping. */
export function FlagText({ text, className }: { text: string; className?: string }): ReactNode {
  if (!hasFlags(text)) return <span className={className}>{text}</span>
  const parts = splitFlagText(text)
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <img
            key={i}
            src={p.src}
            alt={p.pair}
            draggable={false}
            className="emoji-img inline-block size-[1.2em] object-contain align-[-0.22em] pointer-events-none select-none"
          />
        )
      )}
    </span>
  )
}
