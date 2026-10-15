import { useEffect, useRef, useState } from 'react'
import { fmt, noNegZero, type Kind } from './lib'

const W = 260, H = 44, HIST_END = 166, PROJ_START = 184, PROJ_END = W - 10, PAD_Y = 6
const MIN_SPAN: Record<Kind, number> = { pct: 0.04, days: 10, num: 50 } // keeps rounding noise from looking like volatility
const STEP: Record<Kind, { drag: number; key: number }> = {
  pct: { drag: 0.001, key: 0.005 },
  days: { drag: 1, key: 1 },
  num: { drag: 1, key: 10 },
}

interface Props {
  id: string
  label: string
  hint: string
  kind: Kind
  history: (number | null)[]
  value: number
  base: number
  baseLabel: string
  onChange: (v: number) => void
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

export default function DriverStrip({ id, label, hint, kind, history, value, base, baseLabel, onChange }: Props) {
  const known = history.filter((v): v is number => v != null && Number.isFinite(v))
  const live = domainOf([...known, value, base], kind)
  const [frozen, setFrozen] = useState<[number, number] | null>(null) // fixed scale while dragging
  const [lo, hi] = frozen ?? live
  const y = (v: number) => PAD_Y + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 2 * PAD_Y)
  const svgRef = useRef<SVGSVGElement>(null)

  const [draft, setDraft] = useState(toText(value, kind))
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setDraft(toText(value, kind))
  }, [value, kind])

  const fromPointer = (clientY: number, [l, h]: [number, number]) => {
    const r = svgRef.current!.getBoundingClientRect()
    const vy = ((clientY - r.top) / r.height) * H
    const v = l + (1 - (vy - PAD_Y) / (H - 2 * PAD_Y)) * (h - l)
    const s = STEP[kind].drag
    onChange(Math.round(Math.max(l, Math.min(h, v)) / s) * s)
  }

  const commitDraft = () => {
    editing.current = false
    // thousands commas only make sense for crore amounts; "1,5" in a % box must not become 15
    const text = (kind === 'pct' ? draft : draft.replace(/,/g, '')).trim()
    const n = /^-?(\d+\.?\d*|\.\d+)$/.test(text) ? parseFloat(text) : NaN
    if (Number.isFinite(n)) onChange(kind === 'pct' ? n / 100 : n)
    else setDraft(toText(value, kind))
  }

  const n = history.length
  const hx = (i: number) => (n <= 1 ? HIST_END : 6 + (i / (n - 1)) * (HIST_END - 6))
  const pts = history.map((v, i) => (v == null || !Number.isFinite(v) ? null : [hx(i), y(v)] as const))
  const path = pts.reduce((d, p, i) => (p ? d + `${d && pts[i - 1] ? 'L' : 'M'}${p[0]},${p[1]}` : d), '')
  const showZero = lo < 0 && hi > 0
  const changed = Math.abs(value - base) > STEP[kind].drag / 2
  const scale = kind === 'pct' ? 100 : 1 // aria values in the units the user sees

  return (
    <div className="strip">
      <div className="strip-head">
        <label htmlFor={`${id}-input`} className="strip-label">{label}</label>
        <span className="strip-value">
          <input
            id={`${id}-input`}
            inputMode="decimal"
            value={draft}
            aria-describedby={`${id}-hint`}
            onFocus={e => { editing.current = true; e.currentTarget.select() }}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') { setDraft(toText(value, kind)); editing.current = false; e.currentTarget.blur() }
            }}
          />
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
        <line className="pencil-line" x1={PROJ_START} x2={PROJ_END} y1={y(value)} y2={y(value)} />
        <circle
          className="handle"
          cx={PROJ_END}
          cy={y(value)}
          r={6}
          tabIndex={0}
          role="slider"
          aria-label={label}
          aria-orientation="vertical"
          aria-valuemin={+(lo * scale).toFixed(1)}
          aria-valuemax={+(hi * scale).toFixed(1)}
          aria-valuenow={+(value * scale).toFixed(1)}
          aria-valuetext={fmt(value, kind)}
          onKeyDown={e => {
            const s = STEP[kind].key * (e.shiftKey ? 10 : 1)
            const map: Record<string, number> = { ArrowUp: value + s, ArrowRight: value + s, ArrowDown: value - s, ArrowLeft: value - s, Home: base }
            if (e.key in map) {
              e.preventDefault()
              onChange(Math.round(map[e.key] / STEP[kind].drag) * STEP[kind].drag)
            }
          }}
        />
      </svg>
      {/* Drag zone over the projection side only, so taps and swipes on history still scroll the page. */}
      <div
        className="strip-hit"
        style={{ left: `${((PROJ_START - 12) / W) * 100}%` }}
        aria-hidden="true"
        onPointerDown={e => {
          setFrozen(live)
          e.currentTarget.setPointerCapture(e.pointerId)
          if (e.pointerType !== 'touch') fromPointer(e.clientY, live) // touch: only a deliberate drag moves it
        }}
        onPointerMove={e => { if (frozen) fromPointer(e.clientY, frozen) }}
        onPointerUp={() => setFrozen(null)}
        onPointerCancel={() => setFrozen(null)}
      />
      </div>
      <div className="strip-foot" id={`${id}-hint`}>
        <span>{hint}</span>
        {changed ? (
          <button type="button" className="reset" onClick={() => onChange(base)} title={`Reset to ${baseLabel}`}>
            Reset to {baseLabel}
          </button>
        ) : (
          <span className="base-note">{baseLabel}</span>
        )}
      </div>
    </div>
  )
}
