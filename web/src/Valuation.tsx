import { useEffect, useRef, useState, type ReactNode } from 'react'
import { niceTicks } from './Chart'
import { Bridge, RulerSection, avg, baseCagr, last3Of, subjectOf, verdictWords } from './Note'
import { Next, PageHead } from './Shell'
import { useHref } from './route'
import { T, def } from './Term'
import {
  NAMES, copyBase, dec2, drifted, fmt, fy, gap, money, noNegZero, verdict, type Cagr, type ModelDoc, type Multiple, type Parsed, type Projection,
  type Scenario, type ValInputs, type Valuation,
} from './lib'

const ORDER: Scenario[] = ['bear', 'base', 'bull']
type Unit = '%' | 'Rs' | 'cr' | ''

/** Rs per share: whole rupees from 100 up, paise below (a Rs 12 stock needs them). */
const rs = (v: number) => (Math.abs(v) >= 100 ? money(v) : dec2(v))
const toText = (v: number, unit: Unit) => (unit === '%' ? noNegZero((v * 100).toFixed(2).replace(/\.?0+$/, '')) : String(v))

/** A typed input that commits on blur/Enter (Escape restores). Blank = null where the field has a fallback. */
export function Field({ id, label, term, unit, value, fallback, nullable, onCommit }: {
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

/** "No fair value" with the fix right there: the page's answer when a scenario can't be valued. */
function NoValue({ parsed, projection }: { parsed: Parsed; projection: Projection | null }) {
  const href = useHref()
  const { answer, fix } = verdictWords(parsed, projection)
  return <>{answer}{fix && <> <a className="primary" href={href(fix.page, fix.anchor)}>{fix.label}</a></>}</>
}

/** Valuation: CMP against bear/base/bull fair value, sensitivity (both grids), multiples, TV share, then the WACC
 * inputs and the EV-to-equity bridge, folded. */
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
  const our = `${NAMES[active].toLowerCase()}-case fair value`
  const values = v ? { bear: v.scenarios.bear.per_share, base: shown, bull: v.scenarios.bull.per_share } : null
  const k = verdict(price, values).kind
  const P = price != null ? <span className="num mkt">Rs {rs(price)}</span> : null
  const V = shown != null ? <span className="num ours">Rs {rs(shown)}</span> : null
  const pe = sa?.multiples?.price_next.pe
  const at = <><T k="cmp" /> {P}{pe != null && proj ? <> ({pe.toFixed(1)}x {fy(proj.years[0])} <T k="pe" />)</> : null}</>
  const answer: ReactNode = !v ? 'Running the DCF…'
    // the scenario you're on, not the base: its own reason and the way to fix it
    : (shown == null || shown <= 0) && active !== 'base' && !v.error && v.shares != null
      ? <>No {NAMES[active].toLowerCase()}-case fair value: {(sa?.error ?? 'its inputs gave an error.').replace(/^./, c => c.toLowerCase())}{' '}
        <a className="primary" href={href('forecast', 'capex_pct')}>Fix the forecast</a></>
    : shown == null || shown <= 0 ? <NoValue parsed={parsed} projection={projection} />
    : price == null ? <>{our.replace(/^./, c => c.toUpperCase())} {V}/share. No CMP: enter one under DCF inputs.</>
    : k === 'dear' ? <>{at} is above all three fair values: {gap(price, shown)} to {our} of {V}.</>
    : k === 'cheap' ? <>{at} is below all three fair values: {gap(price, shown)} to {our} of {V}.</>
    : <>{at} is within the bear–bull range: {gap(price, shown)} to {our} of {V}.</>
  const grids = v && v.steps && sa?.per_share != null && v.shares != null
  const cells = grids ? [...sa!.grid.flat(), ...sa!.grid_gm.flat()].filter((x): x is number => x != null) : []
  const peerMed = doc.peers?.approved_at ? proj?.peers?.median ?? null : null
  const m = sa?.multiples
  const tv = sa?.tv_share

  return (
    <>
      <PageHead label="Analysis · Valuation" title="Valuation"
        purpose={<><T k="dcf" /> (<T k="fcff" /> at <T k="wacc" />, Gordon-growth <T k="tv" />): fair value per share by scenario, sensitivity, and
          multiples. For what CMP implies, see <a href={href('reverse-dcf')}>Reverse DCF</a>.</>}
        answer={answer} />
      {parsed.share_gap && shown != null && shown > 0 && <p className="guard">Share count up {fmt(parsed.share_gap.gap, 'pct')} since the last balance
        sheet (IPO/QIP?). The proceeds aren’t in net debt yet, so fair value per share is understated.{' '}
        <a href={href('documents', 'data')}>Data note</a></p>}

      {v && !v.error && shown != null && v.shares != null && <>
        <section className="pane v-line" aria-labelledby="line-h">
          <h2 id="line-h">CMP vs fair value <span className="cnt">Rs/share</span></h2>
          <Ruler v={v} active={active} />
          {drifted(doc.scenarios) && <p className="small muted">Bear and bull no longer sit at base ∓/±3 pp revenue growth and ∓/±1.5 pp EBITDA
            margin (a scenario was edited). <button type="button" className="link" onClick={() => copyBase(setDoc, doc.scenarios)}>Re-seed from base</button></p>}
        </section>

        <section className="blk" id="sure" aria-labelledby="sure-h">
          <h2 id="sure-h">Sensitivity</h2>
                    {grids && price != null
            ? <p className="answer s"><b>{cells.filter(x => x >= price).length} of {cells.length}</b> sensitivity cells are at or above CMP
                (WACC × TG and revenue growth × EBITDA margin, around {our}).</p>
            : <p className="why">No CMP to compare the grid with.</p>}
          {grids && <div className="sens-grids">
            <Grid id="sens-wacc" title="WACC × terminal growth" rowsName="WACC" colsName="TG"
              grid={sa!.grid} rows={v.steps!.wacc.map(d => fmt(v.wacc + d, 'pct'))} cols={v.steps!.g.map(d => fmt(v.g + d, 'pct'))} price={price} />
            <Grid id="sens-gm" title="Revenue growth × EBITDA margin" rowsName="Growth Δpp" colsName="Margin Δpp"
              grid={sa!.grid_gm} rows={v.steps!.growth.map(pp)} cols={v.steps!.margin.map(pp)} price={price} />
          </div>}
          {grids && price != null && <p className="small muted grid-key"><span className="gk hit">▲ Rs</span> ≥ CMP ·{' '}
            <span className="gk">Rs</span> &lt; CMP · shade deepens with distance from CMP · boxed: current inputs</p>}
        </section>

        {m && <section className="blk" id="yardsticks" aria-labelledby="yard-h">
          <h2 id="yard-h">Multiples</h2>
          <div className="table-wrap yard-wrap" tabIndex={0} role="region" aria-labelledby="yard-h">
            <table className="yard">
              <thead><tr><th scope="col"><span className="sr">Multiple</span></th><th scope="col">At CMP, {fy(asOf)}</th><th scope="col">At {NAMES[active].toLowerCase()} FV</th><th scope="col">Peer median</th></tr></thead>
              <tbody>{MULTS.map(([key]) => (
                <tr key={key}><th scope="row"><T k={key} /></th><td className="num mkt">{fmt(m.price_last[key], 'x')}</td><td className="num ours">{fmt(m.value_last[key], 'x')}</td>
                  <td className="num">{peerMed ? fmt(peerMed[key], 'x') : '–'}</td></tr>))}</tbody>
            </table>
          </div>
          <p className="small">{peerMed && m.price_last.pe != null && peerMed.pe != null
            ? <>{name} trades at a {m.price_last.pe < peerMed.pe ? 'discount' : 'premium'} to the peer median on P/E ({fmt(m.price_last.pe, 'x')} vs {fmt(peerMed.pe, 'x')}); on DCF, CMP is {k === 'dear' ? 'above the bull case' : k === 'cheap' ? 'below the bear case' : 'within the bear–bull range'}. </>
            : <>No peer set yet, so no peer median. </>}
            <a className="go" href={href('peers')}>{peerMed ? 'Peers' : 'Choose peers'}</a></p>
          {v.multiples && next && <details className="fold"><summary>Historical multiples (own range)</summary>
            <Multiples v={v} active={active} asOf={asOf} next={next} /></details>}
        </section>}

        {tv != null && tv >= 0 && tv <= 1 && <section className="blk" aria-labelledby="from-h">
          <h2 id="from-h">Explicit period vs terminal value</h2>
          <p className="why">{tv > 0.6 ? <>Terminal value is {Math.round(tv * 100)}% of EV: fair value is highly sensitive to WACC and terminal growth.</>
            : <>Terminal value is {Math.round(tv * 100)}% of EV; most value sits in the explicit forecast.</>}</p>
          <div className="two-bar" role="img" aria-label={`PV of FCFF ${fy(proj!.years[0])}–${fy(proj!.years[n - 1])} ${Math.round((1 - tv) * 100)}%, PV of TV ${Math.round(tv * 100)}%`}>
            <span style={{ width: `${(1 - tv) * 100}%` }}>PV of FCFF, {n}Y {Math.round((1 - tv) * 100)}%</span>
            <span>PV of TV {Math.round(tv * 100)}%</span>
          </div>
        </section>}
      </>}

      <details className="fold blk" id="how">
        <summary><span><b>DCF inputs (8)</b>{v && <> · WACC {fmt(v.wacc, 'pct')} · TG {fmt(v.g, 'pct')}{edited ? ' · edited' : ' · defaults'}</>}</span></summary>
        <p className="why">Common to all three scenarios.
          {edited && <> <button type="button" className="link" onClick={() => onChange(() => defaults)}>Reset to defaults</button></>}</p>
        <div className="wacc" role="group" aria-label="WACC and terminal growth inputs">
          <Field id="v-rf" label="Risk-free rate (Rf)" term={def('rf')} unit="%" value={inputs.rf} onCommit={x => x != null && set('rf')(x)} />
          <Field id="v-erp" label="Equity risk premium (ERP)" term={def('erp')} unit="%" value={inputs.erp} onCommit={x => x != null && set('erp')(x)} />
          <Field id="v-beta" label="Beta" term={def('beta')} unit="" value={inputs.beta} onCommit={x => x != null && set('beta')(x)} />
          <Field id="v-kd" label="Cost of debt (Kd, pre-tax)" term="Blank = base-case interest rate" unit="%" value={inputs.kd} nullable fallback={pct(v?.kd)} onCommit={set('kd')} />
          <Field id="v-g" label="Terminal growth (TG)" term="FCFF growth in perpetuity after the explicit period" unit="%" value={inputs.g} onCommit={x => x != null && set('g')(x)} />
          <Field id="v-wacc" label="WACC override" term="Blank = CAPM build-up" unit="%" value={inputs.wacc_override} nullable fallback={pct(buildUp)}
            onCommit={set('wacc_override')} />
          <Field id="v-price" label="CMP" term={company.source?.symbol
            ? `NSE, ${new Date(company.source.price_at ?? company.source.fetched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}; enter to override`
            : 'From the export; enter to override'} unit="Rs" value={inputs.price} nullable
            fallback={market?.price != null ? String(market.price) : 'none'} onCommit={set('price')} />
          <Field id="v-shares" label="Shares outstanding" term="Crore" unit="cr" value={inputs.shares} nullable
            fallback={market?.shares != null ? dec2(market.shares).replace(/,/g, '') : 'none'} onCommit={set('shares')} />
        </div>
        <label className="vcheck">
          <input type="checkbox" checked={inputs.mid_year} onChange={e => onChange(p => ({ ...p, mid_year: e.target.checked }))} />
          Mid-year discounting convention
        </label>
        {v && <p className="wacc-sum small">
          <T k="ke" /> {fmt(v.ke, 'pct')} ({fmt(inputs.rf, 'pct')} + {inputs.beta} × {fmt(inputs.erp, 'pct')}); post-tax Kd {fmt(v.kd_after_tax, 'pct')} at {fmt(v.tax, 'pct')} tax;
          weights {fmt(v.we, 'pct')} equity ({v.price && v.shares ? 'market value' : 'book value'}), {fmt(1 - v.we, 'pct')} debt.{' '}
          <b>WACC <span className="num ours">{fmt(v.wacc, 'pct')}</span></b>{inputs.wacc_override != null && <> (override; build-up {fmt(buildUp, 'pct')})</>}.
        </p>}
        {v?.error && <p className="val-error" role="alert">{v.error}</p>}
      </details>

      {v && !v.error && v.shares != null && <details className="fold" id="bridge">
        <summary><span><b>EV to equity bridge</b> · by scenario, and the base-case build-up</span></summary>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="By scenario: EV to equity value to per share">
          <table className="val-table">
            <thead><tr><th scope="col">Rs cr</th><th scope="col">EV</th><th scope="col">Equity value</th><th scope="col">FV/share (Rs)</th><th scope="col">Upside/(downside)</th></tr></thead>
            <tbody>{ORDER.map(s => {
              const x = v.scenarios[s]
              return <tr key={s} className={s === active ? 'is-active' : undefined}><th scope="row">{NAMES[s]}</th><td>{money(x.ev)}</td><td>{money(x.equity)}</td>
                <td>{x.per_share == null ? '–' : rs(x.per_share)}</td><td>{price != null && x.per_share != null && x.per_share > 0 ? signed(x.per_share / price - 1) : '–'}</td></tr>
            })}</tbody>
          </table>
        </div>
        {v.scenarios.base.per_share != null && proj && <Bridge v={v} value={v.scenarios.base.per_share} price={price} years={proj.years} />}
        <p className="small muted">Equity value = EV − borrowings{v.lease ? ' incl. lease liabilities' : ''} Rs {money(v.borrowings)} cr + cash Rs {money(v.cash)} cr +
          investments Rs {money(v.investments)} cr ({fy(asOf)}){v.nci > 0 && <> − minority interest (NCI share of PAT, {fmt(v.nci, 'pct')}, applied to equity value)</>}. TV: final-year FCFF growing at
          {' '}{fmt(v.g, 'pct')} in perpetuity. FCFF = EBIT × (1 − t) + D&A − capex − Δ working capital.</p>
      </details>}

      <Next lead="Fair value moves with revenue growth and EBITDA margin; edit the drivers in Forecast."><a className="btn" href={href('forecast')}>Forecast</a></Next>
    </>
  )
}


/** Upside/(downside) in the accounting style of the column head: 12% or (83%). */
export const signed = (g: number) => { const t = noNegZero((Math.abs(g) * 100).toFixed(0)); return g < 0 && t !== '0' ? `(${t}%)` : `${t}%` }
const pp = (d: number) => (d === 0 ? 'base' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100)}`)

/** A 5 × 5 grid: cells at or above CMP get ▲ and an outline; the current cell is boxed and labelled "base". */
export function Grid({ id, title, rowsName, colsName, grid, rows, cols, price }: {
  id: string; title: string; rowsName: string; colsName: string; grid: (number | null)[][]; rows: string[]; cols: string[]; price: number | null
}) {
  const mid = Math.floor(rows.length / 2)
  const all = grid.flat().filter((x): x is number => x != null)
  const up = price == null ? 0 : all.filter(x => x >= price).length
  return (
    <figure className="grid-f">
      <figcaption id={id}><b>{title}</b>{price != null && <span className="small"> {up}/{all.length} ≥ CMP.</span>}
        <span className="small muted"> FV/share, Rs.</span></figcaption>
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
                  {cur && <span className="ours-tag" aria-hidden="true">now</span>}{cur && <span className="sr"> (current inputs)</span>}
                  {hit && <span className="sr"> (at or above CMP)</span>}
                </td>
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </figure>
  )
}

/** Reverse DCF: the implied view only. The ruler, then one table: each driver one step either way and the break-even
 * level at which base-case fair value equals CMP. */
export function PricedIn({ parsed, doc, projection }: Props) {
  const href = useHref()
  const v = projection?.valuation ?? null
  const sv = v?.scenarios.base, value = sv?.per_share ?? null, price = v?.price ?? null
  const best = (cs: Cagr[] = []) => (cs.length ? cs.reduce((a, b) => (b.value > a.value ? b : a)) : null)
  const b5 = best(parsed.cagrs?.['5'])
  const implied = sv?.implied_growth ?? null, l3 = last3Of(parsed)
  const P = price != null ? <span className="num mkt">Rs {rs(price)}</span> : null
  const ours = baseCagr(parsed, projection)
  const answer: ReactNode = !v ? 'Running the DCF…'
    : value == null || value <= 0 ? <NoValue parsed={parsed} projection={projection} />
    : price == null ? <>No CMP, so nothing to solve for.</>
    : implied == null ? <>No flat revenue growth between −30% and +80% reconciles base-case FV to {P}.</>
    : <><T k="cmp" /> {P} implies {fmt(implied, 'pct')} revenue <T k="cagr" /> over {doc.n} years (other drivers at base){ours != null ? <> vs {fmt(ours, 'pct')} in our base case</> : null}.
      {l3 != null && <> Last 3 years: {fmt(l3, 'pct')}.</>}{b5 && <> Best 5-year CAGR: {fmt(b5.value, 'pct')} ({fy(b5.from)}–{b5.to.slice(-2)}).</>}</>
  return (
    <>
      <PageHead label="Analysis · Reverse DCF" title="Reverse DCF"
        purpose={<>Implied expectations: the driver levels at which base-case fair value equals CMP{P && <> of {P}</>}. Fair value and sensitivity are
          on <a href={href('valuation')}>Valuation</a>.</>}
        answer={answer} />
      {v && value != null && value > 0 && <>
        <RulerSection parsed={parsed} doc={doc} projection={projection} />
        {price != null && v.note && <Moves parsed={parsed} doc={doc} v={v} value={value} price={price} />}
      </>}
      <Next lead="Test an implied level against the base case."><a className="btn" href={href('forecast', 'growth')}>Forecast</a></Next>
    </>
  )
}

const MOVES: Record<string, [string, string]> = {
  growth: ['Revenue growth', 'YoY'], ebitda_margin: ['EBITDA margin', ''], wacc: ['WACC', ''], g: ['Terminal growth', ''],
}
const stepWords = (s: number) => `${+(s * 100).toFixed(1)} pp`

/** Driver sensitivity: each driver one step lower and higher (one shared scale, centred on base FV), and the break-even
 * level at which FV equals CMP, tagged against the company's own record. */
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
    if (k === 'wacc' || k === 'g') {
      const bps = Math.round((need - ours(k)) * 10000)
      return <span className="tg judge">{bps > 0 ? '+' : bps < 0 ? '−' : ''}{Math.abs(bps)} bps vs base</span>
    }
    const rec = k === 'growth' ? b5?.value : bestM?.[0]
    return rec != null && need > rec ? <span className="tg never" title={k === 'growth' && b5 ? `Best 5-year CAGR: ${fmt(b5.value, 'pct')} (${fy(b5.from)}–${b5.to.slice(-2)})` : bestM ? `Best year: ${fmt(bestM[0], 'pct')} (${fy(bestM[1])})` : undefined}>above track record</span>
      : <span className="tg ok">within track record</span>
  }
  const tryIt = (k: string) => (k === 'wacc' || k === 'g' ? href('valuation', 'how') : href('forecast', k))
  return (
    <section className="blk" aria-labelledby="moves-h" id="moves">
      <h2 id="moves-h">Break-even drivers</h2>
      <p className="why">Each driver flexed one step either way, others at base. Bars centre on base-case FV{' '}
        <span className="num ours">Rs {rs(value)}</span> (blue: higher, grey: lower). Break-even: the flat level at which FV equals CMP{' '}
        <span className="num mkt">Rs {rs(price)}</span>.</p>
      <div className="table-wrap moves-wrap">
        <table className="moves">
          <thead><tr><th scope="col">Driver · base · step</th><th scope="col">FV at −1 step</th><th scope="col"><span className="sr">Bar</span></th>
            <th scope="col">FV at +1 step</th><th scope="col">Break-even</th><th scope="col"><span className="sr">Edit</span></th></tr></thead>
          <tbody>{rows.map(d => {
            const b = be[d.key as keyof typeof be], need = b?.value ?? null
            const ends = [d.down, d.up].filter((y): y is number => y != null)
            const l = Math.min(...ends), r = Math.max(...ends)
            return <tr key={d.key}>
              <th scope="row"><b>{MOVES[d.key][0]}</b><span className="small muted">{fmt(ours(d.key), 'pct')}{MOVES[d.key][1] && ` ${MOVES[d.key][1]}`} · step ±{stepWords(d.step)}</span></th>
              <td data-label="FV at −1 step" className="num">{d.down == null ? 'n/a' : `Rs ${rs(d.down)}`}</td>
              <td className="mv-bar" aria-hidden="true"><span className="mv-track">
                {l < value && <i className="lo" style={{ left: `${x(l)}%`, width: `${x(value) - x(l)}%` }} />}
                {r > value && <i className="hi" style={{ left: `${x(value)}%`, width: `${x(r) - x(value)}%` }} />}
                <i className="mid" /></span></td>
              <td data-label="FV at +1 step" className="num">{d.up == null ? 'n/a' : `Rs ${rs(d.up)}`}</td>
              <td data-label="Break-even">{need != null ? <><span className="num">{fmt(need, 'pct')}</span> {tag(d.key, need)}</>
                : <span className="tg none">none{b?.range ? ` in ${fmt(b.range[0], 'pct')} to ${fmt(b.range[1], 'pct')}` : ''}</span>}</td>
              <td><a className="go" href={tryIt(d.key)}>{d.key === 'wacc' || d.key === 'g' ? 'DCF inputs' : 'Forecast'}</a></td>
            </tr>
          })}</tbody>
        </table>
      </div>
      <p className="small muted">WACC is inversely related to FV, so its bar runs the other way. Payout, other income and interest don’t enter FCFF, so they
        aren’t shown.</p>
    </section>
  )
}

const PAD = 12, ROW = 17, CH = 8.2 // label row height; width of one 12px mono character (7.2) plus the halo

/** One axis: CMP in ink, each scenario's fair value in pencil, labels stacked so they never collide. */
function Ruler({ v, active }: { v: Valuation; active: Scenario }) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [])

  const marks = [
    ...(v.price != null ? [{ key: 'price', ink: true, value: v.price, text: `CMP Rs ${rs(v.price)}` }] : []),
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
        aria-label={`Fair value per share: ${marks.map(m => m.text).join(', ')}`}>
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
  ['pe', 'P/E', def('pe')],
  ['ev_ebitda', 'EV/EBITDA', def('ev_ebitda')],
  ['pb', 'P/B', def('pb')],
]

/** CMP and the active scenario's fair value as P/E, EV/EBITDA and P/B, against the company's own history. */
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
          ? <>Reference: own multiples at {years} reported year-ends. ▲ / ▼: above the historical high / below the low.</>
          : <>No historical year-end prices, so no own range.</>}{' '}
        EV = market cap + borrowings − cash − investments. Blank where the denominator or value is ≤ 0.
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="mult-cap">
        <table className="mult-table">
          <caption id="mult-cap" className="visually-hidden">Multiples: history, at CMP and at {NAMES[active].toLowerCase()}-case fair value</caption>
          <thead>
            <tr>
              <td rowSpan={2} />
              <th scope="colgroup" colSpan={2}>History</th>
              <th scope="colgroup" colSpan={2}>CMP{v.price != null && <> Rs {rs(v.price)}</>}</th>
              <th scope="colgroup" colSpan={2} className="ours">
                {NAMES[active]} FV{ps != null && <> Rs {rs(ps)}</>}
              </th>
            </tr>
            <tr>
              <th scope="col">Median</th><th scope="col">Low–high</th>
              <th scope="col">{fy(asOf)}</th><th scope="col">{fy(next)}</th>
              <th scope="col" className="ours">{fy(asOf)}</th><th scope="col" className="ours">{fy(next)}</th>
            </tr>
          </thead>
          <tbody>
            {MULTS.map(([k]) => (
              <tr key={k}>
                <th scope="row"><T k={k} /></th>
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
