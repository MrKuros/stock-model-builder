import { useEffect, useRef, useState } from 'react'
import { niceTicks } from './Chart'
import { dec2, fmt, money, noNegZero, type Market, type Path, type Scenario, type ValInputs, type Valuation } from './lib'

const ORDER: Scenario[] = ['bear', 'base', 'bull']
const NAMES: Record<Scenario, string> = { base: 'Base', bull: 'Bull', bear: 'Bear' }
type Unit = '%' | 'Rs' | 'cr' | ''

/** Rs per share: whole rupees from 100 up, paise below (a Rs 12 stock needs them). */
const rs = (v: number) => (Math.abs(v) >= 100 ? money(v) : dec2(v))
const signed = (v: number) => `${v > 0 ? '+' : ''}${fmt(v, 'pct')}`
const toText = (v: number, unit: Unit) => (unit === '%' ? noNegZero((v * 100).toFixed(2).replace(/\.?0+$/, '')) : String(v))

/** A typed input that commits on blur/Enter (Escape restores). Blank = null where the field has a fallback. */
function Field({ id, label, unit, value, fallback, nullable, onCommit }: {
  id: string; label: string; unit: Unit; value: number | null; fallback?: string; nullable?: boolean
  onCommit: (v: number | null) => void
}) {
  const shown = value == null ? '' : toText(value, unit)
  const [draft, setDraft] = useState(shown)
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setDraft(shown) }, [shown])
  const commit = () => {
    if (!editing.current) { setDraft(shown); return }
    editing.current = false
    const text = (unit === '%' ? draft : draft.replace(/,/g, '')).trim()
    if (!text && nullable) { onCommit(null); return }
    const n = /^-?(\d+\.?\d*|\.\d+)$/.test(text) ? parseFloat(text) : NaN
    // price and shares must be positive; the server refuses anything else
    if (Number.isFinite(n) && (unit === '%' || unit === '' || n > 0)) onCommit(unit === '%' ? n / 100 : n)
    else setDraft(shown)
  }
  return (
    <label className="vfield" htmlFor={id}>
      <span className="vfield-label">{label}</span>
      <span className="vfield-box">
        {unit === 'Rs' && <span className="unit">Rs</span>}
        <input id={id} inputMode="decimal" value={draft} placeholder={fallback}
          onFocus={e => { editing.current = true; e.currentTarget.select() }}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { setDraft(shown); editing.current = false; e.currentTarget.blur() }
          }} />
        {unit && unit !== 'Rs' && <span className="unit">{unit}</span>}
      </span>
    </label>
  )
}

interface Props {
  inputs: ValInputs
  defaults: ValInputs
  v: Valuation | null // null while a projection loads
  market?: Market
  active: Scenario
  asOf: string // last reported year: the valuation date
  growth: Path // the active scenario's revenue growth, for the reverse DCF sentence
  n: number
  onChange: (f: (p: ValInputs) => ValInputs) => void
}

export default function ValuationPanel({ inputs, defaults, v, market, active, asOf, growth, n, onChange }: Props) {
  const set = (k: keyof ValInputs) => (x: number | null) => onChange(p => ({ ...p, [k]: x }))
  const buildUp = v ? v.we * v.ke + (1 - v.we) * v.kd_after_tax : null
  const edited = JSON.stringify(inputs) !== JSON.stringify(defaults)
  const pct = (x: number | null | undefined) => (x == null ? '' : toText(x, '%'))

  return (
    <section className="valuation" aria-labelledby="val-head">
      <div className="val-top">
        <h2 id="val-head">Valuation</h2>
        {edited && <button type="button" className="link small" onClick={() => onChange(() => defaults)}>Reset valuation inputs</button>}
      </div>
      <p className="muted small">
        Discounted cash flow of free cash flow to firm, valued at the {asOf} year end. The same inputs apply to all
        three scenarios. Blank fields use the value shown in grey.
      </p>

      <div className="wacc" role="group" aria-label="WACC and terminal value inputs">
        <Field id="v-rf" label="Risk-free (10-yr G-sec)" unit="%" value={inputs.rf} onCommit={x => x != null && set('rf')(x)} />
        <Field id="v-erp" label="Equity risk premium" unit="%" value={inputs.erp} onCommit={x => x != null && set('erp')(x)} />
        <Field id="v-beta" label="Beta" unit="" value={inputs.beta} onCommit={x => x != null && set('beta')(x)} />
        <Field id="v-kd" label="Cost of debt, pre-tax" unit="%" value={inputs.kd} nullable fallback={pct(v?.kd)}
          onCommit={set('kd')} />
        <Field id="v-g" label="Terminal growth" unit="%" value={inputs.g} onCommit={x => x != null && set('g')(x)} />
        <Field id="v-wacc" label="WACC override" unit="%" value={inputs.wacc_override} nullable fallback={pct(buildUp)}
          onCommit={set('wacc_override')} />
        <Field id="v-price" label="Share price" unit="Rs" value={inputs.price} nullable
          fallback={market?.price != null ? String(market.price) : 'none'} onCommit={set('price')} />
        <Field id="v-shares" label="Shares" unit="cr" value={inputs.shares} nullable
          fallback={market?.shares != null ? dec2(market.shares).replace(/,/g, '') : 'none'} onCommit={set('shares')} />
        <label className="vcheck">
          <input type="checkbox" checked={inputs.mid_year} onChange={e => onChange(p => ({ ...p, mid_year: e.target.checked }))} />
          Mid-year discounting
        </label>
      </div>

      {v && (
        <p className="wacc-sum">
          Cost of equity {fmt(v.ke, 'pct')} · debt {fmt(v.kd_after_tax, 'pct')} after {fmt(v.tax, 'pct')} tax ·
          weights {fmt(v.we, 'pct')} equity ({v.price && v.shares ? 'market cap' : 'book, no share price'}), {fmt(1 - v.we, 'pct')} debt ·{' '}
          <b>WACC <span className="pencil-num">{fmt(v.wacc, 'pct')}</span></b>
          {inputs.wacc_override != null && <> (typed; the build-up gives {fmt(buildUp, 'pct')})</>}
        </p>
      )}

      {v?.error && <p className="val-error" role="alert">{v.error}</p>}
      {v && !v.error && <>
        {v.shares == null
          ? <p className="val-empty">Enter shares to get a per-share value.</p>
          : <Ruler v={v} active={active} />}
        {v.shares != null && v.price == null && <p className="muted small">Enter a share price to see the upside.</p>}
        <Implied v={v} active={active} growth={growth} n={n} />
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Valuation by scenario">
          <table className="val-table">
            <thead>
              <tr>
                <th scope="col">Rs crore</th><th scope="col">Enterprise value</th><th scope="col">Equity value</th>
                <th scope="col">Per share (Rs)</th><th scope="col">Upside</th><th scope="col">Explicit / terminal</th>
              </tr>
            </thead>
            <tbody>
              {ORDER.map(s => {
                const x = v.scenarios[s]
                return (
                  <tr key={s} className={s === active ? 'is-active' : undefined}>
                    <th scope="row">{NAMES[s]}</th>
                    <td>{money(x.ev)}</td>
                    <td>{money(x.equity)}</td>
                    <td>{x.per_share == null ? '–' : rs(x.per_share)}</td>
                    <td>{x.upside == null ? '–' : signed(x.upside)}</td>
                    <td><Split share={x.tv_share} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {v.shares != null && v.steps && <Sensitivity v={v} active={active} />/* steps: a server not yet restarted has none */}
        <p className="muted small">
          Equity value = enterprise value − borrowings Rs {money(v.borrowings)} cr + cash Rs {money(v.cash)} cr +
          investments Rs {money(v.investments)} cr ({asOf}). Terminal value: Gordon growth at {fmt(v.g, 'pct')} on the
          final year’s free cash flow. Free cash flow to firm = EBIT after tax + depreciation − capex − change in working
          capital; other income is left out because its cash and investments are added here instead.
        </p>
      </>}
    </section>
  )
}

/** Reverse DCF in one sentence: the flat revenue growth today's price implies, against the scenario's own. */
function Implied({ v, active, growth, n }: { v: Valuation; active: Scenario; growth: Path; n: number }) {
  const x = v.scenarios[active].implied_growth, range = v.steps?.implied
  if (x === undefined || !range || v.price == null || v.shares == null) return null // old server, or nothing to solve
  const yours = growth.end == null ? fmt(growth.start, 'pct') : `${fmt(growth.start, 'pct')} fading to ${fmt(growth.end, 'pct')}`
  return x == null
    ? <p className="implied">
        No flat revenue growth between {fmt(range[0], 'pct')} and +{fmt(range[1], 'pct')} a year gets the{' '}
        {NAMES[active].toLowerCase()} case to today’s price of Rs {rs(v.price)}, with its other assumptions as set.
      </p>
    : <p className="implied">
        Today’s price of Rs {rs(v.price)} implies revenue growth of <b>{fmt(x, 'pct')}</b> a year for {n} years,
        versus your <span className="pencil-num">{yours}</span> ({NAMES[active].toLowerCase()} case, other
        assumptions as set). The dashed line on the revenue growth strip marks it.
      </p>
}

/** Share of EV from the explicit years vs the terminal value, as words and a thin bar. */
function Split({ share }: { share: number | null }) {
  if (share == null || share < 0 || share > 1) return <>–</>
  const t = Math.round(share * 100)
  return (
    <span className="split" aria-label={`${100 - t}% explicit years, ${t}% terminal value`}>
      <span aria-hidden="true">{100 - t} / {t}%</span>
      <span className="split-bar" aria-hidden="true"><span style={{ width: `${100 - t}%` }} /></span>
    </span>
  )
}

const PAD = 12, ROW = 17, CH = 7 // label row height; approx. width of one 12px mono character

/** One axis: today's price in ink, each scenario's value per share in pencil, labels stacked so they never collide. */
function Ruler({ v, active }: { v: Valuation; active: Scenario }) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [])

  const marks = [
    ...(v.price != null ? [{ key: 'price', ink: true, value: v.price, text: `Price Rs ${rs(v.price)}` }] : []),
    ...ORDER.flatMap(s => {
      const x = v.scenarios[s]
      return x.per_share == null ? [] : [{
        key: s, ink: false, value: x.per_share,
        text: `${NAMES[s]} Rs ${rs(x.per_share)}${x.upside == null ? '' : ` ${signed(x.upside)}`}`,
      }]
    }),
  ]
  const vals = marks.map(m => m.value)
  let lo = Math.min(...vals), hi = Math.max(...vals)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12
  lo -= pad; hi += pad
  const ticks = niceTicks(lo, hi).filter(t => t >= lo && t <= hi)
  const x = (val: number) => PAD + ((val - lo) / (hi - lo)) * (w - 2 * PAD)

  // greedy rows: each label takes the first row where it clears the last label's right edge
  const ends: number[] = []
  const placed = [...marks].sort((a, b) => a.value - b.value).map(m => {
    const half = (m.text.length * CH) / 2
    const cx = Math.max(half, Math.min(w - half, x(m.value)))
    let row = ends.findIndex(e => cx - half > e + 8)
    if (row < 0) row = ends.length
    ends[row] = cx + half
    return { ...m, cx, row }
  })
  const rows = Math.max(1, ends.length)
  const axis = 10 + rows * ROW + 14
  const H = axis + 30

  return (
    <div className="ruler" ref={box}>
      <svg width={w} height={H} role="img"
        aria-label={`Value per share: ${marks.map(m => m.text).join(', ')}`}>
        <line className="ruler-axis" x1={PAD} x2={w - PAD} y1={axis} y2={axis} />
        {ticks.map(t => (
          <g key={t}>
            <line className="ruler-tick" x1={x(t)} x2={x(t)} y1={axis} y2={axis + 5} />
            <text className="ruler-num" x={x(t)} y={axis + 18} textAnchor="middle">{money(t)}</text>
          </g>
        ))}
        {placed.map(m => {
          const y = 10 + m.row * ROW + 11 // label baseline
          return (
            <g key={m.key} className={`${m.ink ? 'mark-ink' : 'mark-pencil'}${m.key === active ? ' is-active' : ''}`}>
              <line className="mark-lead" x1={x(m.value)} x2={x(m.value)} y1={y + 4} y2={axis + (m.ink ? 7 : 0)} />
              <circle className="mark-dot" cx={x(m.value)} cy={axis} r={m.ink ? 4 : 4.5} />
              <text className="mark-text" x={m.cx} y={y} textAnchor="middle">{m.text}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

const pp = (d: number) => (d === 0 ? 'as set' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100)} pp`)

/** The two 5 x 5 grids for the active scenario: valuation inputs, then operating assumptions. */
function Sensitivity({ v, active }: { v: Valuation; active: Scenario }) {
  const x = v.scenarios[active], st = v.steps
  return (
    <div className="sens">
      <h3>Sensitivity · {NAMES[active]} scenario</h3>
      <p className="muted small">
        Value per share in Rs.{' '}
        {v.price != null
          ? <>Blue cells are above today’s price of Rs {rs(v.price)}, amber below; the deeper the shade, the further away.</>
          : <>No share price, so the cells aren’t shaded.</>}{' '}
        The outlined cell is the current model. Growth and margin shifts apply to every projected year.
      </p>
      <div className="sens-grids">
        <Grid id="sens-wacc" title="WACC (rows) × terminal growth (columns)" corner="WACC / growth" grid={x.grid}
          rows={st.wacc.map(d => fmt(v.wacc + d, 'pct'))} cols={st.g.map(d => fmt(v.g + d, 'pct'))} price={v.price} />
        <Grid id="sens-gm" title="Revenue growth (rows) × EBITDA margin (columns)"
          corner="Growth / margin" grid={x.grid_gm} rows={st.growth.map(pp)} cols={st.margin.map(pp)} price={v.price} />
      </div>
    </div>
  )
}

function Grid({ id, title, corner, grid, rows, cols, price }: {
  id: string; title: string; corner: string; grid: (number | null)[][]; rows: string[]; cols: string[]; price: number | null
}) {
  const mid = Math.floor(rows.length / 2)
  return (
    <div className="table-wrap sens-wrap" tabIndex={0} role="region" aria-labelledby={id}>
      <table className="sens-table">
        <caption id={id}>{title}</caption>
        <thead>
          <tr><th scope="col">{corner}</th>{cols.map(c => <th scope="col" key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {grid.map((row, k) => (
            <tr key={rows[k]}>
              <th scope="row">{rows[k]}</th>
              {row.map((val, i) => {
                const cur = k === mid && i === mid
                // ponytail: shade depth is linear in the gap to price, capped at ±50%
                const gap = val != null && price ? val / price - 1 : null
                const style = gap == null ? undefined : {
                  background: `color-mix(in srgb, var(${gap >= 0 ? '--pencil' : '--amber'}) ${Math.round(8 + Math.min(1, Math.abs(gap) / 0.5) * 30)}%, transparent)`,
                }
                return (
                  <td key={i} className={cur ? 'is-current' : undefined} style={style}>
                    {val == null ? '–' : rs(val)}
                    {cur && <span className="visually-hidden"> (current model)</span>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
