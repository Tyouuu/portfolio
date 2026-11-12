'use client'

import { useLayoutEffect, useRef } from 'react'

// A figure that CHANGES while the page is open counts to its new value in .5s, ease-out (owner 2026-10-17, round 5): the hero figures, the tiles of the
// Transactions / Stock cards, the Monthly page, the dealer's figures, the top-bar balance. Never on the first draw, never under reduced motion, never in a hidden tab.
//   - The DOM text is ALWAYS the final value as far as React is concerned (it renders `text`); the animation only overwrites the text node's data for
//     a few frames and ends on the final text again, and `data-final` holds the final value the whole time.
//   - A SCREEN READER never hears a number on its way: while the count runs, the moving figure is aria-hidden and a visually hidden copy of the FINAL value
//     sits beside it (the copy is taken away when the count ends, so the page keeps one copy of every figure the rest of the time).
//   - Only the first number in the text moves ("1,250 pts" -> "1,310 pts"); the words and the sign around it stay. If the text around the number
//     differs (a sign flipped, a different unit), it simply changes.
//   - tabular figures (every digit the same width), so the number does not jitter sideways.
const NUMBER = /\d[\d,]*(?:\.\d+)?/
const FALLBACK_MS = 500
const reduced = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The count's length is the one token in globals.css (--dur-count), read once per count. */
function countMs(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-count').trim()
  const n = parseFloat(v)
  if (!Number.isFinite(n) || n <= 0) return FALLBACK_MS
  return v.endsWith('ms') ? n : n * 1000
}

/** The pieces of a figure's text: what is before the number, the number, what is after. null when there is no number. */
export function figureParts(text: string): { pre: string; value: number; decimals: number; grouped: boolean; pad: number; post: string } | null {
  const m = NUMBER.exec(text)
  if (!m) return null
  const raw = m[0].replace(/,/g, '')
  // "05" (the cents of RM 12.05): the zero in front stays while the digits run.
  const whole = raw.split('.')[0]
  const pad = whole.length > 1 && whole.startsWith('0') ? whole.length : 0
  return { pre: text.slice(0, m.index), value: Number(raw), decimals: raw.includes('.') ? raw.length - raw.indexOf('.') - 1 : 0, grouped: m[0].includes(','), pad, post: text.slice(m.index + m[0].length) }
}

/** The text of the figure when it is `v` of the way between two values (same words round it as the final text has). */
export function frameText(to: NonNullable<ReturnType<typeof figureParts>>, value: number): string {
  const body = value.toLocaleString('en-MY', { minimumFractionDigits: to.decimals, maximumFractionDigits: to.decimals, useGrouping: to.grouped })
  return `${to.pre}${to.pad ? body.padStart(to.pad, '0') : body}${to.post}`
}

export function CountUp({ text, className = 'tabular-nums', attrs }: { text: string; className?: string; attrs?: Record<string, string | true> }) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(text)
  useLayoutEffect(() => {
    const before = prev.current
    prev.current = text
    const el = ref.current
    if (!el || before === text || process.env.NODE_ENV === 'test' || reduced() || document.hidden) return
    const a = figureParts(before)
    const b = figureParts(text)
    if (!a || !b || a.pre !== b.pre || a.post !== b.post || a.value === b.value) return
    const ms = countMs()
    // The frames are grouped (1,250) if EITHER end is, so a figure that falls from 54,258 to 890 does not lose its comma on the way.
    const frame = { ...b, grouped: a.grouped || b.grouped }
    // The final value for a screen reader, beside the moving copy; the moving copy is hidden from it until the count has ended.
    const spoken = document.createElement('span')
    spoken.className = 'sr-only'
    spoken.setAttribute('data-count-spoken', '')
    spoken.textContent = text
    el.setAttribute('aria-hidden', 'true')
    el.insertAdjacentElement('afterend', spoken)
    const end = () => {
      el.removeAttribute('aria-hidden')
      spoken.remove()
    }
    // The first painted frame is the OLD figure (React has just drawn the new text; without this the new value would show for one frame before the first tick).
    if (el.firstChild) el.firstChild.nodeValue = before
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      // `now` is the frame's own start time, which can be a hair BEFORE t0: a negative progress made the figure step the wrong way first (4-6% above the old value on a figure that falls). Never below 0.
      const p = Math.min(Math.max((now - t0) / ms, 0), 1)
      const eased = 1 - Math.pow(1 - p, 3)
      const node = el.firstChild
      if (node) node.nodeValue = p >= 1 ? text : frameText(frame, a.value + (b.value - a.value) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
      else end()
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      if (el.firstChild) el.firstChild.nodeValue = text
      end()
    }
  }, [text])
  return (
    <span ref={ref} className={className} {...attrs} data-final={text}>
      {text}
    </span>
  )
}
