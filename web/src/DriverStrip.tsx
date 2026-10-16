import { useEffect, useRef, useState } from 'react'
import { fmt, noNegZero, type Kind, type Path } from './lib'

const W = 260, H = 44, HIST_END = 166, PROJ_START = 184, PROJ_END = W - 10, PAD_Y = 6
const MIN_SPAN: Record<Kind, number> = { pct: 0.04, days: 10, num: 50 } // keeps rounding noise from looking like volatility
const STEP: Record<Kind, { drag: number; key: number }> = {
  pct: { drag: 0.001, key: 0.005 },
  days: { drag: 1, key: 1 },
  num: { drag: 1, key: 10 },
}

type End = 'start' | 'end'

interface Props {
  id: string
  label: string
  hint: string
  kind: Kind
  history: (number | null)[]
  value: Path
  base: number
  baseLabel: string
  onChange: (p: Path) => void
  ghost?: number | null // a reference value drawn as a thin dashed ink line (revenue growth: what the price implies)
  source?: string // where the history comes from, when it isn't plain Export (model.upgrade's sources)
}

function domainOf(vals: number[], kind: Kind): [number, number] {
  // ponytail: clip one-off spikes (e.g. 400% growth in a demerger year) so they don't flatten the strip
  const clipped = kind === 'pct' ? vals.map(v => Math.max(-1, Math.min(2, v))) : vals
  let lo = Math.min(...clipped), hi = Math.max(...clipped)
  if (hi - lo < MIN_SPAN[kind]) {
    const mid = (hi + lo) / 2
    lo = mid - MIN_SPAN[kind] / 2
    hi = mid + MIN_SPAN[kind] / 2
  }
  const pad = (hi - lo) * 0.18
  return [lo - pad, hi + pad]
}

const toText = (v: number, kind: Kind) =>
  noNegZero(kind === 'pct' ? (v * 100).toFixed(1) : String(Math.round(v)))

/** Typed value box: commits on blur/Enter, Escape restores. */
function ValueInput({ id, kind, value, ariaLabel, describedBy, onCommit }:
  { id: string; kind: Kind; value: number; ariaLabel?: string; describedBy: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(toText(value, kind))
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setDraft(toText(value, kind))
  }, [value, kind])

  const commit = () => {
    if (!editing.current) { setDraft(toText(value, kind)); return } // Escape: its blur must not commit the typed text
    editing.current = false
    // thousands commas only make sense for crore amounts; "1,5" in a % box must not become 15
    const text = (kind === 'pct' ? draft : draft.replace(/,/g, '')).trim()
    const n = /^-?(\d+\.?\d*|\.\d+)$/.test(text) ? parseFloat(text) : NaN
    if (Number.isFinite(n)) onCommit(kind === 'pct' ? n / 100 : n)
    else setDraft(toText(value, kind))
  }

  return (
    <input
      id={id}
      inputMode="decimal"
      value={draft}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      onFocus={e => { editing.current = true; e.currentTarget.select() }}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') { setDraft(toText(value, kind)); editing.current = false; e.currentTarget.blur() }
      }}
    />
  )
}

export default function DriverStrip({ id, label, hint, kind, history, value, base, baseLabel, onChange, ghost, source }: Props) {
  const fade = value.end != null
  const end = value.end ?? value.start
  const known = history.filter((v): v is number => v != null && Number.isFinite(v))
  const live = domainOf([...known, value.start, end, base, ...(ghost == null ? [] : [ghost])], kind)
  // fixed scale and the handle being dragged, so the strip doesn't rescale under the pointer
  const [drag, setDrag] = useState<{ dom: [number, number]; which: End } | null>(null)
  const [lo, hi] = drag?.dom ?? live
  const y = (v: number) => PAD_Y + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 2 * PAD_Y)
  const svgRef = useRef<SVGSVGElement>(null)

  const snap = (v: number) => Math.round(v / STEP[kind].drag) * STEP[kind].drag
  const set = (which: End, v: number) =>
    onChange(which === 'start' ? { start: v, end: value.end } : { start: value.start, end: v })

  const fromPointer = (clientY: number, [l, h]: [number, number], which: End) => {
    const r = svgRef.current!.getBoundingClientRect()
    const vy = ((clientY - r.top) / r.height) * H
    const v = l + (1 - (vy - PAD_Y) / (H - 2 * PAD_Y)) * (h - l)
    set(which, snap(Math.max(l, Math.min(h, v))))
  }

  const n = history.length
  const hx = (i: number) => (n <= 1 ? HIST_END : 6 + (i / (n - 1)) * (HIST_END - 6))
  const pts = history.map((v, i) => (v == null || !Number.isFinite(v) ? null : [hx(i), y(v)] as const))
  const path = pts.reduce((d, p, i) => (p ? d + `${d && pts[i - 1] ? 'L' : 'M'}${p[0]},${p[1]}` : d), '')
  const showZero = lo < 0 && hi > 0
  const changed = fade || Math.abs(value.start - base) > STEP[kind].drag / 2
  const scale = kind === 'pct' ? 100 : 1 // aria values in the units the user sees
  const hintId = `${id}-hint`

  const handle = (which: End, cx: number, v: number, name: string) => (
    <circle
      className="handle"
      cx={cx}
      cy={y(v)}
      r={6}
      tabIndex={0}
      role="slider"
      aria-label={name}
      aria-orientation="vertical"
      aria-valuemin={+(lo * scale).toFixed(1)}
      aria-valuemax={+(hi * scale).toFixed(1)}
      aria-valuenow={+(v * scale).toFixed(1)}
      aria-valuetext={fmt(v, kind)}
      onKeyDown={e => {
        const s = STEP[kind].key * (e.shiftKey ? 10 : 1)
        const map: Record<string, number> = { ArrowUp: v + s, ArrowRight: v + s, ArrowDown: v - s, ArrowLeft: v - s, Home: base }
        if (e.key in map) {
          e.preventDefault()
          set(which, snap(map[e.key]))
        }
      }}
    />
  )

  return (
    <div className="strip">
      <div className="strip-head">
        <label htmlFor={`${id}-input`} className="strip-label">{label}</label>
        <span className="strip-value">
          <ValueInput id={`${id}-input`} kind={kind} value={value.start} describedBy={hintId}
            ariaLabel={fade ? `${label}, first projected year` : undefined} onCommit={v => set('start', v)} />
          {fade && <>
            <span className="arrow" aria-hidden="true">→</span>
            <ValueInput id={`${id}-end`} kind={kind} value={end} describedBy={hintId}
              ariaLabel={`${label}, last projected year`} onCommit={v => set('end', v)} />
          </>}
          <span className="unit">{kind === 'pct' ? '%' : kind === 'days' ? 'days' : 'cr'}</span>
        </span>
      </div>
      <div className="strip-chart-wrap">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="strip-chart">
        {showZero && <line className="zero" x1={0} x2={W} y1={y(0)} y2={y(0)} />}
        <line className="today" x1={(HIST_END + PROJ_START) / 2} x2={(HIST_END + PROJ_START) / 2} y1={2} y2={H - 2} />
        <path className="ink-line" d={path} />
        {pts.map((p, i) => p && <circle key={i} className="ink-dot" cx={p[0]} cy={p[1]} r={i === n - 1 ? 2.6 : 1.8} />)}
        <line className="base-line" x1={PROJ_START} x2={PROJ_END} y1={y(base)} y2={y(base)} />
        {ghost != null && <g className="ghost">
          <line x1={PROJ_START} x2={PROJ_END} y1={y(ghost)} y2={y(ghost)} />
          {/* label on the far side from the pencil line, flipped when that side has no room */}
          <text x={PROJ_END} y={(ghost >= (value.start + end) / 2 ? y(ghost) >= 10 : y(ghost) > H - 9)
            ? y(ghost) - 3.5 : y(ghost) + 9} textAnchor="end">
            price implies {fmt(ghost, kind)}
          </text>
        </g>}
        <line className="pencil-line" x1={PROJ_START} x2={PROJ_END} y1={y(value.start)} y2={y(end)} />
        {fade
          ? <>{handle('start', PROJ_START, value.start, `${label}, first projected year`)}
              {handle('end', PROJ_END, end, `${label}, last projected year`)}</>
          : handle('start', PROJ_END, value.start, label)}
      </svg>
      {/* Drag zone over the projection side only, so taps and swipes on history still scroll the page. */}
      <div
        className="strip-hit"
        style={{ left: `${((PROJ_START - 12) / W) * 100}%` }}
        aria-hidden="true"
        onPointerDown={e => {
          // with a fade, the half of the zone you grab picks the handle
          const r = svgRef.current!.getBoundingClientRect()
          const x = ((e.clientX - r.left) / r.width) * W
          const which: End = fade && x >= (PROJ_START + PROJ_END) / 2 ? 'end' : 'start'
          setDrag({ dom: live, which })
          e.currentTarget.setPointerCapture(e.pointerId)
          if (e.pointerType !== 'touch') fromPointer(e.clientY, live, which) // touch: only a deliberate drag moves it
        }}
        onPointerMove={e => { if (drag) fromPointer(e.clientY, drag.dom, drag.which) }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      />
      </div>
      <div className="strip-foot">
        <span id={hintId}>{hint}{source && <span className="strip-source">{source}</span>}</span>
        <span className="strip-tools">
          <button type="button" className="fade" aria-pressed={fade} aria-label={`Fade ${label}`}
            title={fade ? 'Hold one value every year' : 'Slope from a first-year value to a last-year value'}
            onClick={() => onChange({ start: value.start, end: fade ? null : value.start })}>
            Fade
          </button>
          {changed ? (
            <button type="button" className="reset" onClick={() => onChange({ start: base, end: null })}
              aria-label={`Reset to ${baseLabel}, ${label}`}>
              Reset to {baseLabel}
            </button>
          ) : (
            <span className="base-note">{baseLabel}</span>
          )}
        </span>
      </div>
    </div>
  )
}
