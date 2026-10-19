import { useEffect, useRef, useState, type ReactNode } from 'react'
import { niceTicks } from './Chart'
import { Bridge, RulerSection, avg, grow, grew, last3Of, subjectOf, verdictWords } from './Note'
import { Next, PageHead } from './Shell'
import { useHref } from './route'
import {
  NAMES, copyBase, dec2, drifted, fmt, gap, money, noNegZero, verdict, type Cagr, type ModelDoc, type Multiple, type Parsed, type Projection,
  type Scenario, type ValInputs, type Valuation,
} from './lib'

const ORDER: Scenario[] = ['bear', 'base', 'bull']
type Unit = '%' | 'Rs' | 'cr' | ''

/** Rs per share: whole rupees from 100 up, paise below (a Rs 12 stock needs them). */
const rs = (v: number) => (Math.abs(v) >= 100 ? money(v) : dec2(v))
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

/** "No value yet" with the fix right there: the page's answer when a case can't be valued. */
function NoValue({ parsed, projection }: { parsed: Parsed; projection: Projection | null }) {
  const href = useHref()
  const { answer, fix } = verdictWords(parsed, projection)
  return <>{answer}{fix && <> <a className="primary" href={href(fix.page, fix.anchor)}>{fix.label}</a></>}</>
}

/** Is it cheap?: today's price against our three values and how sure that is (both grids), other yardsticks, where
 * the value comes from, then the discount-rate settings and the bridge, folded. */
export default function ValuationPage({ parsed, doc, setDoc, projection }: Props) {
  const href = useHref()
  const { company, years: histYears } = parsed
  const { active, n, valuation: inputs } = doc
  const defaults = parsed.valuation, market = company.market
  const proj = projection?.scenarios[active].length === n ? projection : null
  const v = proj?.valuation ?? null
  const asOf = histYears[histYears.length - 1], next = proj?.years[0]
  const onChange = (f: (p: ValInputs) => ValInputs) => setDoc(d => ({ ...d, valuation: f(d.valuation) }))
  const set = (k: keyof ValInputs) => (x: number | null) => onChange(p => ({ ...p, [k]: x }))
  const buildUp = v ? v.wacc_build : null
  const edited = JSON.stringify(inputs) !== JSON.stringify(defaults)
  const pct = (x: number | null | undefined) => (x == null ? '' : toText(x, '%'))
  const price = v?.price ?? null
  const sa = v?.scenarios[active], shown = sa?.per_share ?? null
  const name = subjectOf(company)
  const our = `our ${NAMES[active].toLowerCase()} value`
  const values = v ? { bear: v.scenarios.bear.per_share, base: shown, bull: v.scenarios.bull.per_share } : null
  const k = verdict(price, values).kind
  const P = price != null ? <span className="num mkt">Rs {rs(price)}</span> : null
  const V = shown != null ? <span className="num ours">Rs {rs(shown)}</span> : null
  const answer: ReactNode = !v ? 'Working out the value…'
    // the case you're on, not the central one: its own reason and the way to fix it
    : (shown == null || shown <= 0) && active !== 'base' && !v.error && v.shares != null
      ? <>Our {NAMES[active].toLowerCase()} case has no value yet: {(sa?.error ?? 'its inputs gave an error.').replace(/^./, c => c.toLowerCase())}{' '}
        <a className="primary" href={href('forecast', 'capex_pct')}>Fix the forecast</a></>
    : shown == null || shown <= 0 ? <NoValue parsed={parsed} projection={projection} />
    : price == null ? <>{our.replace(/^./, c => c.toUpperCase())} is {V} a share. There’s no share price to compare it with: type one under How we value it.</>
    : k === 'dear' ? <><b>No.</b> At {P} the price is above all three of our values: {gap(price, shown)} to {our} of {V}.</>
    : k === 'cheap' ? <><b>Yes.</b> At {P} the price is below even our cautious value: {gap(price, shown)} to {our} of {V}.</>
    : <><b>Somewhere in between.</b> At {P} the price sits inside our range: {gap(price, shown)} to {our} of {V}.</>
  const grids = v && v.steps && sa?.per_share != null && v.shares != null
  const cells = grids ? [...sa!.grid.flat(), ...sa!.grid_gm.flat()].filter((x): x is number => x != null) : []
  const peerMed = doc.peers?.approved_at ? proj?.peers?.median ?? null : null
  const m = sa?.multiples
  const tv = sa?.tv_share

  return (
    <>
      <PageHead label="Answers · Is it cheap?" title={`Is ${name} cheap?`}
        purpose={<>Today’s price against what our forecast says one share is worth, and how sure that is. To see what the price itself
          assumes, open <a href={href('priced-in')}>What does the price assume?</a></>}
        answer={answer} />
      {parsed.share_gap && shown != null && shown > 0 && <p className="guard">Shares are up {fmt(parsed.share_gap.gap, 'pct')} since the last balance
        sheet (an IPO or QIP?). The cash that raised isn’t in net debt yet, so this value per share reads low.{' '}
        <a href={href('documents', 'data')}>See the data note</a></p>}

      {v && !v.error && shown != null && v.shares != null && <>
        <section className="pane v-line" aria-labelledby="line-h">
          <h2 id="line-h">Price against our three values <span className="cnt">Rs a share</span></h2>
          <Ruler v={v} active={active} />
          {drifted(doc.scenarios) && <p className="small muted">Cautious and hopeful no longer sit at central ± 3 points of sales growth and ± 1.5 points of
            margin (one of the cases was edited). <button type="button" className="link" onClick={() => copyBase(setDoc, doc.scenarios)}>Copy central to both</button></p>}
        </section>

        <section className="blk" id="sure" aria-labelledby="sure-h">
          <h2 id="sure-h">How sure are we?</h2>
          {proj && <p className="why">{DEFINE(proj.years[n - 1])}</p>}
          {grids && price != null
            ? <p className="answer s">We tried {cells.length} combinations of the four numbers we’re least sure of around {our};{' '}
                <b>{cells.filter(x => x >= price).length} of {cells.length} are at or above today’s price.</b></p>
            : <p className="why">No share price, so nothing to compare the combinations with.</p>}
          {grids && <div className="sens-grids">
            <Grid id="sens-wacc" title="Discount rate × long-run growth" rowsName="Discount rate" colsName="long-run growth"
              grid={sa!.grid} rows={v.steps!.wacc.map(d => fmt(v.wacc + d, 'pct'))} cols={v.steps!.g.map(d => fmt(v.g + d, 'pct'))} price={price} />
            <Grid id="sens-gm" title="Sales growth × operating margin" rowsName="Sales growth, points from ours" colsName="operating margin, points from ours"
              grid={sa!.grid_gm} rows={v.steps!.growth.map(pp)} cols={v.steps!.margin.map(pp)} price={price} />
          </div>}
          {grids && price != null && <p className="small muted grid-key"><span className="gk hit">▲ Rs</span> at or above today’s price ·{' '}
            <span className="gk">Rs</span> below it · the deeper the shade, the further from the price · the boxed cell is ours</p>}
        </section>

        {m && <section className="blk" id="yardsticks" aria-labelledby="yard-h">
          <h2 id="yard-h">Other yardsticks</h2>
          <div className="table-wrap yard-wrap" tabIndex={0} role="region" aria-labelledby="yard-h">
            <table className="yard">
              <thead><tr><th scope="col"><span className="sr">Measure</span></th><th scope="col">At the price, {asOf}</th><th scope="col">At {our}</th><th scope="col">Peer median</th></tr></thead>
              <tbody>{MULTS.map(([key, label]) => (
                <tr key={key}><th scope="row">{label}</th><td className="num mkt">{fmt(m.price_last[key], 'x')}</td><td className="num ours">{fmt(m.value_last[key], 'x')}</td>
                  <td className="num">{peerMed ? fmt(peerMed[key], 'x') : '–'}</td></tr>))}</tbody>
            </table>
          </div>
          <p className="small">{peerMed && m.price_last.pe != null && peerMed.pe != null
            ? <>On earnings {name} looks {m.price_last.pe < peerMed.pe ? 'cheaper than' : 'dearer than'} its peers; on our cash-flow model it {k === 'dear' ? 'looks costly' : k === 'cheap' ? 'looks cheap' : 'sits inside our range'}. </>
            : <>No peers picked yet, so there’s no peer median. </>}
            <a className="go" href={href('peers')}>{peerMed ? 'Compare with peers' : 'Pick peers'}</a></p>
          {v.multiples && next && <details className="fold"><summary>{name}’s own multiples over the years</summary>
            <Multiples v={v} active={active} asOf={asOf} next={next} /></details>}
        </section>}

        {tv != null && tv >= 0 && tv <= 1 && <section className="blk" aria-labelledby="from-h">
          <h2 id="from-h">Where the value comes from</h2>
          <p className="why">{tv > 0.6 ? 'Most of the value sits in the years after our forecast, so the long-run growth and discount rate matter a lot.'
            : 'Most of the value comes from the forecast years themselves.'}</p>
          <div className="two-bar" role="img" aria-label={`Next ${n} years ${Math.round((1 - tv) * 100)}%, after ${proj!.years[n - 1]} ${Math.round(tv * 100)}%`}>
            <span style={{ width: `${(1 - tv) * 100}%` }}>Next {n} years {Math.round((1 - tv) * 100)}%</span>
            <span>After {proj!.years[n - 1].replace(/E$/, '')} {Math.round(tv * 100)}%</span>
          </div>
        </section>}
      </>}

      <details className="fold blk" id="how">
        <summary><span><b>How we value it (8 settings)</b>{v && <> · discount rate {fmt(v.wacc, 'pct')} · long-run growth {fmt(v.g, 'pct')}{edited ? ' · you changed some' : ' · the app’s defaults'}</>}</span></summary>
        <p className="why">The same settings apply to all three cases. A box showing a grey number uses it until you type your own.
          {edited && <> <button type="button" className="link" onClick={() => onChange(() => defaults)}>Reset all to the defaults</button></>}</p>
        <div className="wacc" role="group" aria-label="Discount rate and long-run growth settings">
          <Field id="v-rf" label="Risk-free rate" term="10-year government bond yield" unit="%" value={inputs.rf} onCommit={x => x != null && set('rf')(x)} />
          <Field id="v-erp" label="Extra return for owning shares" term="Equity risk premium, over the bond yield" unit="%" value={inputs.erp} onCommit={x => x != null && set('erp')(x)} />
          <Field id="v-beta" label="How much the stock swings (beta)" term="1 = average; the app’s default, not measured for this stock" unit="" value={inputs.beta} onCommit={x => x != null && set('beta')(x)} />
          <Field id="v-kd" label="Cost of borrowing" term="Interest rate on its debt, before tax" unit="%" value={inputs.kd} nullable fallback={pct(v?.kd)} onCommit={set('kd')} />
          <Field id="v-g" label="Long-run growth (terminal)" term="Growth a year forever after the forecast" unit="%" value={inputs.g} onCommit={x => x != null && set('g')(x)} />
          <Field id="v-wacc" label="Use my own discount rate (override)" term="Blank = built from the four above" unit="%" value={inputs.wacc_override} nullable fallback={pct(buildUp)}
            onCommit={set('wacc_override')} />
          <Field id="v-price" label="Share price" term={company.source?.symbol
            ? `From NSE, ${new Date(company.source.price_at ?? company.source.fetched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}; type today’s`
            : 'From the export; type today’s'} unit="Rs" value={inputs.price} nullable
            fallback={market?.price != null ? String(market.price) : 'none'} onCommit={set('price')} />
          <Field id="v-shares" label="Shares" term="Number of shares, in crore" unit="cr" value={inputs.shares} nullable
            fallback={market?.shares != null ? dec2(market.shares).replace(/,/g, '') : 'none'} onCommit={set('shares')} />
        </div>
        <label className="vcheck">
          <input type="checkbox" checked={inputs.mid_year} onChange={e => onChange(p => ({ ...p, mid_year: e.target.checked }))} />
          Cash arrives through the year, not at its end (mid-year)
        </label>
        {v && <p className="wacc-sum small">
          Shareholders want {fmt(v.ke, 'pct')} ({fmt(inputs.rf, 'pct')} + {inputs.beta} × {fmt(inputs.erp, 'pct')}); debt costs {fmt(v.kd_after_tax, 'pct')} after {fmt(v.tax, 'pct')} tax;
          weighted {fmt(v.we, 'pct')} equity ({v.price && v.shares ? 'at market value' : 'at book value'}), {fmt(1 - v.we, 'pct')} debt.{' '}
          <b>Discount rate <span className="num ours">{fmt(v.wacc, 'pct')}</span></b>{inputs.wacc_override != null && <> (yours; the build-up gives {fmt(buildUp, 'pct')})</>}.
        </p>}
        {v?.error && <p className="val-error" role="alert">{v.error}</p>}
      </details>

      {v && !v.error && v.shares != null && <details className="fold" id="bridge">
        <summary><span><b>From company value to share value</b> · the three cases, and the central value built up</span></summary>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="By case: company value to equity to per share">
          <table className="val-table">
            <thead><tr><th scope="col">Rs crore</th><th scope="col">Company value (EV)</th><th scope="col">Shareholders’ value</th><th scope="col">Per share (Rs)</th><th scope="col">Against the price</th></tr></thead>
            <tbody>{ORDER.map(s => {
              const x = v.scenarios[s]
              return <tr key={s} className={s === active ? 'is-active' : undefined}><th scope="row">{NAMES[s]}</th><td>{money(x.ev)}</td><td>{money(x.equity)}</td>
                <td>{x.per_share == null ? '–' : rs(x.per_share)}</td><td>{price != null && x.per_share != null ? gap(price, x.per_share) : '–'}</td></tr>
            })}</tbody>
          </table>
        </div>
        {v.scenarios.base.per_share != null && proj && <Bridge v={v} value={v.scenarios.base.per_share} price={price} years={proj.years} />}
        <p className="small muted">Shareholders’ value = company value − borrowings{v.lease ? ' and lease liabilities' : ''} Rs {money(v.borrowings)} cr + cash Rs {money(v.cash)} cr +
          investments Rs {money(v.investments)} cr ({asOf}){v.nci > 0 && <> − minority holders’ {fmt(v.nci, 'pct')} share of profit</>}. After the forecast: the last year’s free cash
          flow growing {fmt(v.g, 'pct')} a year forever. Free cash flow = operating profit after tax + depreciation − capex − change in working capital.</p>
      </details>}

      <Next lead="Disagree with the value? Change the sales growth or margin and watch it move."><a className="btn" href={href('forecast')}>Change the forecast</a></Next>
    </>
  )
}

/** The two settings every grid and table here leans on, in one plain line. */
const DEFINE = (last: string, n?: number) => `Discount rate = the yearly return you’d want for the risk of owning this business; long-run growth = how fast its cash grows each year after ${n ? `the ${n} forecast years` : last.replace(/E$/, '')}, forever.`

const pp = (d: number) => (d === 0 ? 'ours' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100)}`)

/** A 5 × 5 grid: cells at or above the price get ▲ and an outline; the cell we use is boxed and labelled "ours". */
function Grid({ id, title, rowsName, colsName, grid, rows, cols, price }: {
  id: string; title: string; rowsName: string; colsName: string; grid: (number | null)[][]; rows: string[]; cols: string[]; price: number | null
}) {
  const mid = Math.floor(rows.length / 2)
  const all = grid.flat().filter((x): x is number => x != null)
  const up = price == null ? 0 : all.filter(x => x >= price).length
  return (
    <figure className="grid-f">
      <figcaption id={id}><b>{title}</b>{price != null && <span className="small"> {up} of {all.length} at or above today’s price.</span>}
        <span className="small muted"> Value a share, Rs.</span></figcaption>
      <div className="table-wrap sens-wrap" tabIndex={0} role="region" aria-labelledby={id}>
        <table className="sens-table">
          <thead><tr><th scope="col" className="g-corner">{rowsName} ↓<br />{colsName} →</th>{cols.map(c => <th scope="col" key={c}>{c}</th>)}</tr></thead>
          <tbody>{grid.map((row, k) => (
            <tr key={rows[k]}><th scope="row">{rows[k]}</th>
              {row.map((val, i) => {
                const cur = k === mid && i === mid, hit = val != null && price != null && val >= price
                // ponytail: shade depth linear in the gap to the price, capped at ±50%
                const g = val != null && price ? Math.min(1, Math.abs(val / price - 1) / 0.5) : 0
                const style = val == null || price == null ? undefined : { background: `color-mix(in srgb, var(${hit ? '--ours-soft' : '--market-soft'}) ${Math.round(45 + g * 55)}%, var(--panel))` }
                return <td key={i} className={`${cur ? 'is-current' : ''}${hit ? ' hit' : ''}`} style={style}>
                  {hit && <span aria-hidden="true">▲ </span>}{val == null ? '–' : rs(val)}
                  {cur && <span className="ours-tag" aria-hidden="true">ours</span>}{cur && <span className="sr"> (ours)</span>}
                  {hit && <span className="sr"> (at or above the price)</span>}
                </td>
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </figure>
  )
}

/** What does the price assume?: the reverse view only. The ruler, then one table: each input one step either way and
 * the level at which the price would be fair. */
export function PricedIn({ parsed, doc, projection }: Props) {
  const href = useHref()
  const v = projection?.valuation ?? null
  const sv = v?.scenarios.base, value = sv?.per_share ?? null, price = v?.price ?? null
  const name = subjectOf(parsed.company)
  const best = (cs: Cagr[] = []) => (cs.length ? cs.reduce((a, b) => (b.value > a.value ? b : a)) : null)
  const b5 = best(parsed.cagrs?.['5'])
  const implied = sv?.implied_growth ?? null, l3 = last3Of(parsed)
  const P = price != null ? <span className="num mkt">Rs {rs(price)}</span> : null
  const answer: ReactNode = !v ? 'Working out the value…'
    : value == null || value <= 0 ? <NoValue parsed={parsed} projection={projection} />
    : price == null ? <>There’s no share price, so there’s nothing to work backwards from.</>
    : implied == null ? <>No steady sales growth between −30% and +80% a year gets our central value to {P}.</>
    : implied < 0 ? <>The price assumes sales {grow(implied)} a year.{l3 != null && <> {name} {grew(l3)} a year over the last three.</>}</>
    : <>Sales growth of {fmt(implied, 'pct')} a year for {doc.n} years, with everything else as in our forecast.
      {b5 && <> {name}’s best five years were {fmt(b5.value, 'pct')} ({b5.from}–{b5.to.slice(-2)}).</>}</>
  return (
    <>
      <PageHead label="Answers · What does the price assume?" title="What does the price assume?"
        purpose={<>Works backwards from today’s price{P && <> of {P}</>}: what the business would have to do for it to be fair. Our own value and how sure it is are
          on <a href={href('value')}>Is it cheap?</a></>}
        answer={answer} />
      {v && value != null && value > 0 && <>
        <RulerSection parsed={parsed} doc={doc} projection={projection} />
        {price != null && v.note && <Moves parsed={parsed} doc={doc} v={v} value={value} price={price} />}
      </>}
      <Next lead="Think one of these is reachable?"><a className="btn" href={href('forecast', 'growth')}>Change it in the forecast</a></Next>
    </>
  )
}

const MOVES: Record<string, [string, string]> = {
  growth: ['Sales growth', 'a year'], ebitda_margin: ['Operating margin', 'of sales'], wacc: ['Discount rate', 'a year'], g: ['Long-run growth', 'after the forecast'],
}
const stepWords = (s: number) => `${+(s * 100).toFixed(1)} point${s === 0.01 ? '' : 's'}`

/** What moves the value: each input one step lower and higher (one shared scale, centred on our value), and the level
 * at which the price would be fair, tagged against the company's own record. */
function Moves({ parsed, doc, v, value, price }: { parsed: Parsed; doc: ModelDoc; v: Valuation; value: number; price: number }) {
  const href = useHref()
  const be = v.note!.breakevens
  const rows = v.note!.impact.filter(d => d.key in MOVES)
  if (!rows.length) return null
  const base = doc.scenarios.base
  const ours = (k: string) => (k === 'wacc' ? v.wacc : k === 'g' ? v.g : avg(base[k]))
  const hist = parsed.hist ?? parsed.company.hist
  const margins = hist.map((h, i) => [h.revenue ? (h.ebitda ?? 0) / h.revenue : null, parsed.years[i]] as const).filter((x): x is readonly [number, string] => x[0] != null)
  const bestM = margins.length ? margins.reduce((a, b) => (b[0] > a[0] ? b : a)) : null
  const b5 = (parsed.cagrs?.['5'] ?? []).reduce<Cagr | null>((a, b) => (!a || b.value > a.value ? b : a), null)
  const vals = rows.flatMap(d => [d.down, d.up]).filter((x): x is number => x != null)
  const lo = Math.min(value, ...vals), hi = Math.max(value, ...vals)
  const w = Math.max(hi - value, value - lo) || 1
  const x = (n: number) => 50 + ((n - value) / w) * 50
  const tag = (k: string, need: number | null): ReactNode => {
    if (need == null) return null
    if (k === 'wacc' || k === 'g') return <span className="tg judge">a judgement call</span>
    const rec = k === 'growth' ? b5?.value : bestM?.[0]
    return rec != null && need > rec ? <span className="tg never" title={k === 'growth' && b5 ? `Best five years: ${fmt(b5.value, 'pct')} (${b5.from}–${b5.to.slice(-2)})` : bestM ? `Best year: ${fmt(bestM[0], 'pct')} (${bestM[1]})` : undefined}>never done</span>
      : <span className="tg ok">within its record</span>
  }
  const tryIt = (k: string) => (k === 'wacc' || k === 'g' ? href('value', 'how') : href('forecast', k))
  return (
    <section className="blk" aria-labelledby="moves-h" id="moves">
      <h2 id="moves-h">What moves the value</h2>
      <p className="why">Each input moved one step lower and higher, the rest of our central case left alone. The bar is centred on our value of{' '}
        <span className="num ours">Rs {rs(value)}</span>; blue raises the value, grey lowers it. The last column is where that input would have to be for{' '}
        <span className="num mkt">Rs {rs(price)}</span> to be fair. {DEFINE('', doc.n)}</p>
      <div className="table-wrap moves-wrap">
        <table className="moves">
          <thead><tr><th scope="col">Input · ours · step</th><th scope="col">Value if the input is one step lower</th><th scope="col"><span className="sr">Bar</span></th>
            <th scope="col">Value if one step higher</th><th scope="col">For the price to be fair</th><th scope="col"><span className="sr">Try it</span></th></tr></thead>
          <tbody>{rows.map(d => {
            const b = be[d.key as keyof typeof be], need = b?.value ?? null
            const ends = [d.down, d.up].filter((y): y is number => y != null)
            const l = Math.min(...ends), r = Math.max(...ends)
            return <tr key={d.key}>
              <th scope="row"><b>{MOVES[d.key][0]}</b><span className="small muted">{fmt(ours(d.key), 'pct')} {MOVES[d.key][1]} · step ±{stepWords(d.step)}</span></th>
              <td data-label="One step lower" className="num">{d.down == null ? 'no value' : `Rs ${rs(d.down)}`}</td>
              <td className="mv-bar" aria-hidden="true"><span className="mv-track">
                {l < value && <i className="lo" style={{ left: `${x(l)}%`, width: `${x(value) - x(l)}%` }} />}
                {r > value && <i className="hi" style={{ left: `${x(value)}%`, width: `${x(r) - x(value)}%` }} />}
                <i className="mid" /></span></td>
              <td data-label="One step higher" className="num">{d.up == null ? 'no value' : `Rs ${rs(d.up)}`}</td>
              <td data-label="For the price to be fair">{need != null ? <><span className="num">{fmt(need, 'pct')}</span> {tag(d.key, need)}</>
                : <span className="tg none">no level{b?.range ? ` in ${fmt(b.range[0], 'pct')} to ${fmt(b.range[1], 'pct')}` : ''} gets there</span>}</td>
              <td><a className="go" href={tryIt(d.key)}>Try it{d.key === 'wacc' || d.key === 'g' ? '' : ' in the forecast'}</a></td>
            </tr>
          })}</tbody>
        </table>
      </div>
      <p className="small muted">A lower discount rate raises the value, so its bar runs the other way round. Payout, other income and interest don’t move a
        cash-flow value, so they aren’t here.</p>
    </section>
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
        text: `${NAMES[s]} Rs ${rs(x.per_share)}`,
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

const MULTS: [Multiple, string, string][] = [
  ['pe', 'Price ÷ earnings (P/E)', 'market cap / net profit'],
  ['ev_ebitda', 'Company value ÷ operating profit (EV/EBITDA)', 'enterprise value / EBITDA'],
  ['pb', 'Price ÷ book value (P/B)', 'market cap / book equity'],
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
      <td className={`${pencil ? 'ours' : ''}${dir ? ' is-out' : ''}`}>
        {x(val)}
        {dir !== 0 && <><span className="mult-flag" aria-hidden="true"> {dir > 0 ? '▲' : '▼'}</span>
          <span className="visually-hidden"> ({dir > 0 ? 'above the historical high' : 'below the historical low'})</span></>}
      </td>
    )
  }
  return (
    <div className="mult">
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
              <th scope="colgroup" colSpan={2} className="ours">
                {NAMES[active]} value{ps != null && <> Rs {rs(ps)}</>}
              </th>
            </tr>
            <tr>
              <th scope="col">Median</th><th scope="col">Low–high</th>
              <th scope="col">{asOf}</th><th scope="col">{next}</th>
              <th scope="col" className="ours">{asOf}</th><th scope="col" className="ours">{next}</th>
            </tr>
          </thead>
          <tbody>
            {MULTS.map(([k, name, what]) => (
              <tr key={k}>
                <th scope="row" title={what}>{name}</th>
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
