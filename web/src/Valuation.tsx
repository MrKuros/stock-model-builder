import { useEffect, useRef, useState } from 'react'
import { niceTicks } from './Chart'
import { BreakEvens, Bridge, Change, Prose, Tornado, avg, shortName } from './Note'
import { PeersSection } from './Peers'
import { PageHead, Toc } from './Shell'
import { useHref } from './route'
import {
  NAMES, copyBase, dec2, drifted, fmt, money, noNegZero, type ModelDoc, type Multiple, type Parsed, type Path, type Projection, type Scenario, type ValInputs, type Valuation,
} from './lib'

const ORDER: Scenario[] = ['bear', 'base', 'bull']
type Unit = '%' | 'Rs' | 'cr' | ''

/** Rs per share: whole rupees from 100 up, paise below (a Rs 12 stock needs them). */
const rs = (v: number) => (Math.abs(v) >= 100 ? money(v) : dec2(v))
const signed = (v: number) => `${v > 0 ? '+' : ''}${fmt(v, 'pct')}`
const toText = (v: number, unit: Unit) => (unit === '%' ? noNegZero((v * 100).toFixed(2).replace(/\.?0+$/, '')) : String(v))

/** A typed input that commits on blur/Enter (Escape restores). Blank = null where the field has a fallback. */
function Field({ id, label, term, unit, value, fallback, nullable, onCommit }: {
  id: string; label: string; term: string; unit: Unit; value: number | null; fallback?: string; nullable?: boolean
  onCommit: (v: number | null) => void
}) {
  const shown = value == null ? '' : toText(value, unit)
  const [draft, setDraft] = useState(shown)
  const [bad, setBad] = useState(false) // the last typed value wasn't a number
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setDraft(shown) }, [shown])
  const commit = () => {
    if (!editing.current) { setDraft(shown); return }
    editing.current = false
    // the unit printed beside the box may be typed too: "Rs. 1,600", "5%". Commas are grouping outside % fields
    const t = draft.trim().replace(/^rs\.?\s*/i, '').replace(/\s*%$/, '')
    const text = (unit === '%' ? t : t.replace(/,/g, '')).trim()
    if (!text && nullable) { onCommit(null); return }
    const n = /^-?(\d+\.?\d*|\.\d+)$/.test(text) ? parseFloat(text) : NaN
    // price and shares must be positive; the server refuses anything else
    const ok = Number.isFinite(n) && (unit === '%' || unit === '' || n > 0)
    setBad(!ok)
    if (ok) onCommit(unit === '%' ? n / 100 : n)
    else setDraft(shown)
  }
  return (
    <label className="vfield" htmlFor={id}>
      <span className="vfield-label">{label}</span>
      <span className="term">{term}</span>
      <span className="vfield-box">
        {unit === 'Rs' && <span className="unit">Rs</span>}
        <input id={id} inputMode="decimal" value={draft} placeholder={fallback} aria-describedby={bad ? `${id}-bad` : undefined}
          onFocus={e => { editing.current = true; setBad(false); e.currentTarget.select() }}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { setDraft(shown); editing.current = false; e.currentTarget.blur() }
          }} />
        {unit && unit !== 'Rs' && <span className="unit">{unit}</span>}
      </span>
      <span id={`${id}-bad`} className="vfield-bad" role="status">{bad ? `Not ${unit === '%' || unit === '' ? 'a number' : 'a positive number'}; kept the old value` : ''}</span>
    </label>
  )
}

interface Props { parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null }

/** Valuation: the inputs first (everything below recalculates), then the value by case, what moves it, what would
 * close the gap, how sure, and the multiples. The research-note pieces (tornado, break-evens) are base case only. */
export default function ValuationPage({ parsed, doc, setDoc, projection }: Props) {
  const href = useHref()
  const { company, years: histYears } = parsed
  const { active, n, valuation: inputs } = doc
  const defaults = parsed.valuation, market = company.market
  const proj = projection?.scenarios[active].length === n ? projection : null
  const v = proj?.valuation ?? null
  const asOf = histYears[histYears.length - 1], next = proj?.years[0]
  const growth = doc.scenarios[active].growth
  const onChange = (f: (p: ValInputs) => ValInputs) => setDoc(d => ({ ...d, valuation: f(d.valuation) }))
  const set = (k: keyof ValInputs) => (x: number | null) => onChange(p => ({ ...p, [k]: x }))
  const buildUp = v ? v.wacc_build : null
  const edited = JSON.stringify(inputs) !== JSON.stringify(defaults)
  const head = useRef<HTMLHeadingElement>(null)
  const burn = v ? ORDER.filter(s => v.scenarios[s].error) : [] // scenarios with no terminal value (same message)
  const pct = (x: number | null | undefined) => (x == null ? '' : toText(x, '%'))
  const sv = v?.scenarios.base, value = sv?.per_share ?? null, price = v?.price ?? null
  const sa = v?.scenarios[active], shown = sa?.per_share ?? null // the headline follows the case picked at the top
  const base = doc.scenarios.base
  const oursOf = (k: string) => (k === 'wacc' ? v?.wacc ?? 0 : k === 'g' ? v?.g ?? 0 : avg(base[k]))
  const nb = v?.note ?? null, be = nb?.breakevens ?? {}
  const tn = doc.note
  const P = (text: string, _refs: unknown, uid: string) => (tn ? <Prose text={text} refs={[]} tn={tn} refN={new Map()} uid={uid} /> : null)
  const c3 = parsed.cagrs?.['3'] ?? []
  const short = shortName(company.name)
  const why = !v ? 'Calculating…' : v.error ?? sa?.error ?? (v.shares == null ? 'There is no share count in this file: type one below.' : '')

  return (
    <>
      <PageHead label={<>Valuation · <b>{NAMES[active].toLowerCase()} case</b> · discounted cash flow, valued at the {asOf} year end</>}
        title={shown != null ? <>What {short} is worth{active !== 'base' ? ` in the ${active} case` : ''}: <span className="ours">Rs {rs(shown)}</span> a share</> : 'No value yet'}
        purpose={shown != null
          ? <>We add up the cash the business should make over the forecast, discount it to today and compare it with the
            price{price != null ? <> of <span className="num mkt">Rs {rs(price)}</span></> : ' (none in this file: type one below)'}. Change the inputs in the first box; everything below recalculates.</>
          : sa?.error && !v?.error
            ? <>{why} <a href={href('forecast', 'capex_pct')}>Change capex or growth in Forecast</a></>
            : <>{why} Fix it in the inputs below and the value appears.</>}
        next={<a className="btn" href="#inputs">Change the inputs</a>} />
      <Toc page="valuation" />

      <section className="blk first card" id="inputs" aria-labelledby="val-head">
        <div className="strip-head">
          <h2 id="val-head" tabIndex={-1} ref={head}>Inputs for valuing the cash flows</h2>
          {/* the button unmounts once inputs match the defaults, so focus moves to the heading */}
          {edited && <button type="button" className="link small"
            onClick={() => { onChange(() => defaults); head.current?.focus() }}>Reset to the defaults</button>}
        </div>
        <p className="why">The same inputs apply to bear, base and bull. A box showing a grey number uses it until you type your own.</p>
        <div className="wacc" role="group" aria-label="Discount rate and terminal value inputs">
          <Field id="v-rf" label="Risk-free rate" term="10-year government bond yield" unit="%" value={inputs.rf} onCommit={x => x != null && set('rf')(x)} />
          <Field id="v-erp" label="Equity risk premium" term="Extra return investors want for owning shares" unit="%" value={inputs.erp} onCommit={x => x != null && set('erp')(x)} />
          <Field id="v-beta" label="Beta" term="How much the stock swings with the market; 1 = average" unit="" value={inputs.beta} onCommit={x => x != null && set('beta')(x)} />
          <Field id="v-kd" label="Cost of debt, before tax" term="Interest rate on borrowings" unit="%" value={inputs.kd} nullable fallback={pct(v?.kd)}
            onCommit={set('kd')} />
          <Field id="v-g" label="Terminal growth" term="Growth a year forever after the forecast" unit="%" value={inputs.g} onCommit={x => x != null && set('g')(x)} />
          <Field id="v-wacc" label="Discount rate (WACC)" term="The return investors need; built from the four above" unit="%" value={inputs.wacc_override} nullable fallback={pct(buildUp)}
            onCommit={set('wacc_override')} />
          <Field id="v-price" label="Share price" term={company.source?.symbol
            ? `From NSE, ${new Date(company.source.price_at ?? company.source.fetched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}; type today’s`
            : 'From the export; type today’s'} unit="Rs" value={inputs.price} nullable
            fallback={market?.price != null ? String(market.price) : 'none'} onCommit={set('price')} />
          <Field id="v-shares" label="Shares" term="Number of shares, in crore" unit="cr" value={inputs.shares} nullable
            fallback={market?.shares != null ? dec2(market.shares).replace(/,/g, '') : 'none'} onCommit={set('shares')} />
        </div>
        {v && (
          <p className="wacc-sum">
            Cost of equity {fmt(v.ke, 'pct')} · debt {fmt(v.kd_after_tax, 'pct')} after {fmt(v.tax, 'pct')} tax ·
            weights {fmt(v.we, 'pct')} equity ({v.price && v.shares ? 'market cap' : v.price ? 'book, no share count' : 'book, no share price'}), {fmt(1 - v.we, 'pct')} debt ·{' '}
            <b>Discount rate <span className="pencil-num">{fmt(v.wacc, 'pct')}</span></b>
            {inputs.wacc_override != null && <> (typed; the build-up gives {fmt(buildUp, 'pct')})</>}
            <label className="vcheck">
              <input type="checkbox" checked={inputs.mid_year} onChange={e => onChange(p => ({ ...p, mid_year: e.target.checked }))} />
              Mid-year discounting <span className="dim">(cash arrives through the year, not at its end)</span>
            </label>
          </p>
        )}
        {v?.error && <p className="val-error" role="alert">{v.error}</p>}
      </section>

      {v && !v.error && <>
        <section className="blk" id="worth" aria-labelledby="worth-h">
          <h2 id="worth-h">Value by case</h2>
          <p className="why">Bull and bear start at base ± 3 points of revenue growth and ± 1.5 points of EBITDA margin; the
            {' '}{NAMES[active].toLowerCase()} case is highlighted. Business value (enterprise value) is the cash flows discounted;
            equity value adds cash and takes off debt.</p>
          {drifted(doc.scenarios) && <p className="small-note">Bull and bear no longer sit at base ± 3 / ± 1.5 points (one of
            the cases was edited).{' '}<button type="button" className="link" onClick={() => copyBase(setDoc, doc.scenarios)}>Copy base to bull and bear</button></p>}
          {burn.length > 0 && (
            <p className="val-error">{burn.map((s, i) => (i ? NAMES[s].toLowerCase() : NAMES[s])).join(', ').replace(/, (?=[^,]*$)/, ' and ')}{' '}
              {burn.length > 1 ? 'cases' : 'case'}: {v.scenarios[burn[0]].error}{' '}<a href={href('forecast', 'capex_pct')}>Open capex in Forecast</a></p>
          )}
          {v.shares == null
            ? <p className="val-empty">No share count, so no value per share. <a href="#v-shares">Type the share count</a></p>
            : <Ruler v={v} active={active} />}
          {v.shares != null && v.price == null && <p className="val-empty">No share price in this file, so no upside. <a href="#v-price">Type a price</a></p>}
          <Implied v={v} active={active} growth={growth} n={n} />
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Valuation by case: business value to equity to per share">
            <table className="val-table">
              <thead>
                <tr>
                  <th scope="col">Rs crore</th><th scope="col">Business value</th><th scope="col">Equity value</th>
                  <th scope="col">Per share (Rs)</th><th scope="col">vs price</th><th scope="col">Forecast / after it</th>
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
          {value != null && proj && <Bridge v={v} value={value} price={price} years={proj.years} />}
        </section>

        <section className="blk" id="hinges" aria-labelledby="hinges-h">
          <h2 id="hinges-h">What moves the value{active !== 'base' && ' (base case)'}</h2>
          <p className="why">Each input moved one step either way, the rest left at base. The longest bar matters most.</p>
          {nb && nb.impact.length > 0 && value != null
            ? <div className="split2">
                <Tornado impact={nb.impact.slice(0, 5)} base={value} price={price} oursOf={oursOf} />
                {price != null
                  ? <BreakEvens be={be} price={price} oursOf={oursOf} c3={c3} hist={parsed.hist ?? company.hist} v={v} vi={inputs} beta0={defaults.beta} />
                  : <p className="val-empty">Break-evens need a share price. <a href="#v-price">Type a price</a></p>}
              </div>
            : <p className="val-empty">Needs a base value per share first.</p>}
        </section>

        <section className="blk" id="gap" aria-labelledby="gap-h">
          <h2 id="gap-h">What would close or widen the gap{active !== 'base' && ' (base case)'}</h2>
          {nb && value != null && price != null
            ? <Change impact={nb.impact} base={value} price={price} oursOf={oursOf} v={v} be={be} tn={tn} P={P} />
            : value == null ? <p className="val-empty">Needs a base value per share first.</p>
            : <p className="val-empty">Needs a share price. <a href="#v-price">Type a price</a></p>}
        </section>

        <section className="blk" id="sure" aria-labelledby="sure-h">
          <h2 id="sure-h">How sure: what-if cases</h2>
          {v.shares == null ? <p className="val-empty">Needs a share count. <a href="#v-shares">Type it</a></p>
            : v.steps && v.scenarios[active].per_share != null ? <Sensitivity v={v} active={active} />
            : <p className="val-empty">Needs a value per share in the {NAMES[active].toLowerCase()} case first.</p>}
        </section>

        <section className="blk" id="multiples" aria-labelledby="mult-h">
          <h2 id="mult-h">Cross-check with multiples</h2>
          {v.shares != null && v.multiples && next ? <Multiples v={v} active={active} asOf={asOf} next={next} />
            : <p className="val-empty">Needs a share count and a forecast year.</p>}
        </section>

        <details className="audit">
          <summary>How this is computed</summary>
          <p className="muted small">
            Equity value = enterprise value − borrowings{v.lease ? ' and lease liabilities' : ''} Rs {money(v.borrowings)} cr + cash Rs {money(v.cash)} cr +
            investments Rs {money(v.investments)} cr ({asOf})
            {v.nci > 0 && <> − minority interest, estimated as minorities’ {fmt(v.nci, 'pct')} share of profit</>}.
            Terminal value: Gordon growth at {fmt(v.g, 'pct')} on the
            final year’s free cash flow. Free cash flow to firm (FCFF) = operating profit after tax + depreciation − capex − change in working
            capital; other income is left out because its cash and investments are added here instead.
          </p>
        </details>
      </>}

      <PeersSection parsed={parsed} doc={doc} setDoc={setDoc} projection={projection} short={short} />
    </>
  )
}

/** Reverse DCF in one sentence: the flat revenue growth today's price implies, against the scenario's own. */
function Implied({ v, active, growth, n }: { v: Valuation; active: Scenario; growth: Path; n: number }) {
  const x = v.scenarios[active].implied_growth, range = v.steps?.implied
  if (x === undefined || !range || v.price == null || v.shares == null) return null // old server, or nothing to solve
  const yours = growth.end == null || growth.end === growth.start ? fmt(growth.start, 'pct') : `${fmt(growth.start, 'pct')} fading to ${fmt(growth.end, 'pct')}`
  return x == null
    ? <p className="implied">
        No flat revenue growth between {fmt(range[0], 'pct')} and +{fmt(range[1], 'pct')} a year gets the{' '}
        {NAMES[active].toLowerCase()} case to today’s price of Rs {rs(v.price)}, with its other assumptions as set.
      </p>
    : <p className="implied">
        Today’s price of Rs {rs(v.price)} implies revenue growth of <b>{fmt(x, 'pct')}</b> a year for {n} years,
        versus your <span className="pencil-num">{yours}</span> ({NAMES[active].toLowerCase()} case, other
        assumptions as set). The dashed line on the revenue growth input in Forecast marks it.
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

const PAD = 12, ROW = 17, CH = 7.5 // label row height; width of one 12px mono character (7.2) plus the halo

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
  if (!marks.length) return null // no price and no scenario value
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
    return { ...m, cx, row, half }
  })
  const base = (m: { row: number }) => 10 + m.row * ROW + 11 // label baseline
  const cls = (m: { ink: boolean; key: string }) => `${m.ink ? 'mark-ink' : 'mark-pencil'}${m.key === active ? ' is-active' : ''}`
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
        {/* leads and dots first, then every label on a sheet-coloured box, so no lead runs through a label */}
        {placed.map(m => (
          <g key={m.key} className={cls(m)}>
            <line className="mark-lead" x1={x(m.value)} x2={x(m.value)} y1={base(m) + 4} y2={axis + (m.ink ? 7 : 0)} />
            <circle className="mark-dot" cx={x(m.value)} cy={axis} r={m.ink ? 4 : 4.5} />
          </g>
        ))}
        {placed.map(m => (
          <g key={m.key} className={cls(m)}>
            <rect className="mark-bg" x={m.cx - m.half} y={base(m) - 11} width={2 * m.half} height={14} />
            <text className="mark-text" x={m.cx} y={base(m)} textAnchor="middle">{m.text}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

const pp = (d: number) => (d === 0 ? 'as set' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100)} pp`)

/** The two 5 x 5 grids for the active scenario: valuation inputs, then operating assumptions. */
function Sensitivity({ v, active }: { v: Valuation; active: Scenario }) {
  const x = v.scenarios[active], st = v.steps!
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

const MULTS: [Multiple, string, string][] = [
  ['pe', 'P/E', 'market cap / net profit'],
  ['ev_ebitda', 'EV/EBITDA', 'enterprise value / EBITDA'],
  ['pb', 'P/B', 'market cap / book equity'],
]

/** Today's price and the active scenario's value as P/E, EV/EBITDA and P/B, against the company's own history. */
function Multiples({ v, active, asOf, next }: { v: Valuation; active: Scenario; asOf: string; next: string }) {
  const h = v.multiples!, m = v.scenarios[active].multiples!, ps = v.scenarios[active].per_share
  const years = h.hist.pe.length
  const priced = MULTS.some(([k]) => h.median[k] != null)
  const x = (val: number | null) => (val == null ? '–' : fmt(val, 'x'))
  /** A multiple with a ▲/▼ when it sits outside the history's low–high range. */
  const cell = (k: Multiple, val: number | null, pencil: boolean) => {
    const lo = h.min[k], hi = h.max[k]
    const dir = val == null || lo == null || hi == null ? 0 : val > hi ? 1 : val < lo ? -1 : 0
    return (
      <td className={`${pencil ? 'pencil-num' : ''}${dir ? ' is-out' : ''}`}>
        {x(val)}
        {dir !== 0 && <><span className="mult-flag" aria-hidden="true"> {dir > 0 ? '▲' : '▼'}</span>
          <span className="visually-hidden"> ({dir > 0 ? 'above the historical high' : 'below the historical low'})</span></>}
      </td>
    )
  }
  return (
    <div className="mult">
      <h3>Multiples cross-check · {NAMES[active]} scenario</h3>
      <p className="muted small">
        {priced
          ? <>The company’s own multiples at each of its {years} reported year ends set the reference. ▲ / ▼ marks a
            multiple above the historical high or below the low.</>
          : <>No year-end share prices for past years, so there is nothing to compare with.</>}{' '}
        EV = market cap + borrowings − cash − investments. Blank where the value or the earnings are zero or negative.
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="mult-cap">
        <table className="mult-table">
          <caption id="mult-cap" className="visually-hidden">Multiples: history, today’s price and the {NAMES[active].toLowerCase()} value per share</caption>
          <thead>
            <tr>
              <td rowSpan={2} />
              <th scope="colgroup" colSpan={2}>History</th>
              <th scope="colgroup" colSpan={2}>Price{v.price != null && <> Rs {rs(v.price)}</>}</th>
              <th scope="colgroup" colSpan={2} className="pencil-num">
                {NAMES[active]} value{ps != null && <> Rs {rs(ps)}</>}
              </th>
            </tr>
            <tr>
              <th scope="col">Median</th><th scope="col">Low–high</th>
              <th scope="col">{asOf}</th><th scope="col">{next}</th>
              <th scope="col" className="pencil-num">{asOf}</th><th scope="col" className="pencil-num">{next}</th>
            </tr>
          </thead>
          <tbody>
            {MULTS.map(([k, name, what]) => (
              <tr key={k}>
                <th scope="row"><abbr title={what}>{name}</abbr></th>
                <td>{x(h.median[k])}</td>
                <td>{h.min[k] == null ? '–' : `${x(h.min[k])}–${x(h.max[k])}`}</td>
                {cell(k, m.price_last[k], false)}{cell(k, m.price_next[k], false)}
                {cell(k, m.value_last[k], true)}{cell(k, m.value_next[k], true)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
