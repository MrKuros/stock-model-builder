import type { ReactNode } from 'react'
import { Field, Grid, signed } from './Valuation'
import { Plot, cagrOf, med } from './Fundamentals'
import { Bars } from './Summary'
import { subjectOf, type Fix } from './Note'
import { More, Next, PageHead, Scale, ScaleHead } from './Shell'
import { useHref } from './route'
import { T, def } from './Term'
import {
  NAMES, copyBase, dec2, drifted, fmt, fy, gap, money, properName, rs, verdict, type LenderValuation, type ModelDoc, type Parsed,
  type Projection, type Row, type Scenario, type ValInputs,
} from './lib'

/** Banks and NBFCs (6.1): the pages that differ from a non-financial's. Every number comes from lender.py by rules;
 * this file only lays them out. */

const ORDER: Scenario[] = ['bear', 'base', 'bull']
const pc = (x: number | null | undefined) => fmt(x, 'pct')
const xx = (x: number | null | undefined) => fmt(x, 'x')
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x)

/** The lender's valuation, or null for everyone else. */
export const lenderOf = (p: Projection | null | undefined) =>
  p?.valuation.kind === 'lender' ? p.valuation as unknown as LenderValuation : null
export const isLender = (parsed: Parsed) => parsed.kind === 'lender' || parsed.company.kind === 'lender'

/** The answer line for a lender (Summary, Valuation, the note): CMP against the residual-income range, then the RoE the
 * price implies against the base case's and the last reported year's. */
export function lenderWords(parsed: Parsed, projection: Projection | null): { answer: ReactNode; fix: Fix | null } {
  const v = lenderOf(projection)
  if (!v) return { answer: <>Running the valuation…</>, fix: null }
  const sv = v.scenarios.base, value = sv.per_share, price = v.price
  if (value == null || value <= 0) {
    if (!v.error && v.shares == null) return { answer: <>No fair value: share count missing.</>,
      fix: { page: 'valuation', anchor: 'v-shares', label: 'Enter shares outstanding' } }
    return { answer: <>No fair value: {(v.error ?? sv.error ?? 'the inputs gave an error.').replace(/^./, c => c.toLowerCase())}</>,
      fix: v.error ? { page: 'valuation', anchor: 'how', label: 'Open valuation inputs' } : { page: 'forecast', anchor: 'credit_cost', label: 'Check the forecast' } }
  }
  const V = (x: number) => <span className="num ours">Rs {rs(x)}</span>
  if (price == null) return { answer: <>Base-case fair value {V(value)}/share; no CMP.</>, fix: { page: 'valuation', anchor: 'v-price', label: 'Enter CMP' } }
  const bear = v.scenarios.bear.per_share, bull = v.scenarios.bull.per_share
  const P = <span className="num mkt">Rs {rs(price)}</span>
  const at = <><T k="cmp" /> {P}{v.pb != null ? <> ({v.pb.toFixed(2)}x <T k="pb" />)</> : null}</>
  const k = verdict(price, { bear, base: value, bull }).kind, g = gap(price, value)
  const first = k === 'dear' ? <>{at} is above bull-case fair value of {V(bull!)}; {g} to base-case {V(value)}.</>
    : k === 'cheap' ? <>{at} is below bear-case fair value of {V(bear!)}; {g} to base-case {V(value)}.</>
    : k === 'fix' ? <>{at}: {g} to base-case fair value of {V(value)}; a scenario has no value, so no full range.</>
    : <>{at} is within the bear–bull fair-value range ({V(bear!)}–{V(bull!)}); {g} to base-case {V(value)}.</>
  const r = parsed.ratios[parsed.ratios.length - 1]?.roe ?? null, end = projection!.years[projection!.years.length - 1]
  const second = v.implied_roe == null ? null
    : <> Market-implied <T k="roe_ss">steady-state RoE</T> {pc(v.implied_roe)} vs {pc(sv.roe_t)} in our base case ({fy(end)} PAT on opening book){r != null ? <> and {pc(r)} reported <T k="roe_l" /> in {fy(parsed.years[parsed.years.length - 1])}</> : null}.</>
  return { answer: <>{first}{second}</>, fix: null }
}

type SetDoc = (f: (d: ModelDoc) => ModelDoc) => void
interface Props { parsed: Parsed; doc: ModelDoc; setDoc: SetDoc; projection: Projection | null }

/** Valuation for a lender: residual income (P/B-based), by scenario; Ke x RoE sensitivity; P/B, P/ABV and P/E at CMP
 * and at fair value; the RI build-up; the inputs. */
export function LenderValuationPage({ parsed, doc, setDoc, projection }: Props) {
  const href = useHref()
  const { company, years: histYears } = parsed
  const { active, n, valuation: inputs } = doc
  const proj = projection?.scenarios[active].length === n ? projection : null
  const v = lenderOf(proj)
  const sa = v?.scenarios[active], shown = sa?.per_share ?? null, price = v?.price ?? null
  const onChange = (f: (p: ValInputs) => ValInputs) => setDoc(d => ({ ...d, valuation: f(d.valuation) }))
  const set = (k: keyof ValInputs) => (x: number | null) => onChange(p => ({ ...p, [k]: x }))
  const edited = JSON.stringify(inputs) !== JSON.stringify(parsed.valuation)
  const market = company.market
  const our = `${NAMES[active].toLowerCase()}-case fair value`
  const V = shown != null ? <span className="num ours">Rs {rs(shown)}</span> : null
  const P = price != null ? <span className="num mkt">Rs {rs(price)}</span> : null
  const k = v ? verdict(price, { bear: v.scenarios.bear.per_share, base: shown, bull: v.scenarios.bull.per_share }).kind : 'none'
  const answer: ReactNode = !v ? 'Running the valuation…'
    : shown == null || shown <= 0 ? lenderWords(parsed, projection).answer
    : price == null ? <>{our.replace(/^./, c => c.toUpperCase())} {V}/share. No CMP: enter one under valuation inputs.</>
    : <><T k="cmp" /> {P} at {xx(v.pb)} <T k="pb" /> is {k === 'dear' ? 'above all three fair values' : k === 'cheap' ? 'below all three fair values' : 'within the bear–bull range'}:{' '}
      {gap(price, shown)} to {our} of {V} ({xx(sa?.pb_value)} book).</>
  const peerMed = doc.peers?.approved_at ? proj?.peers?.median ?? null : null
  const last = fy(histYears[histYears.length - 1])
  const cells = sa ? sa.grid.flat().filter((x): x is number => x != null) : []
  return (
    <>
      <PageHead label="Analysis · Valuation" title="Valuation"
        purpose={<>Residual income (<T k="ri" />): book value plus the present value of profit above the cost of equity (<T k="ke" />), by
          scenario. No <T k="fcff" /> DCF for a lender: deposits and borrowings are its raw material, not financing. What CMP implies is on{' '}
          <a href={href('reverse-dcf')}>Implied RoE</a>.</>}
        answer={answer} />
      {v && !v.error && shown != null && v.shares != null && <>
        <section className="pane v-line" aria-labelledby="line-h">
          <h2 id="line-h">CMP vs fair value <span className="cnt">Rs/share</span></h2>
          <div className="lv-scale"><ScaleHead /><Scale price={price} bear={v.scenarios.bear.per_share} base={shown} bull={v.scenarios.bull.per_share} /></div>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Fair value by scenario">
            <table className="val-table">
              <thead><tr><th scope="col">Scenario</th><th scope="col">FV/share (Rs)</th><th scope="col">Upside/(downside)</th>
                <th scope="col"><T k="roe_ss" /></th><th scope="col"><T k="jpb" /></th><th scope="col">P/B at FV</th></tr></thead>
              <tbody>{ORDER.map(s => {
                const x = v.scenarios[s]
                return <tr key={s} className={s === active ? 'is-active' : undefined}><th scope="row">{NAMES[s]}</th>
                  <td>{x.per_share == null ? '–' : rs(x.per_share)}</td>
                  <td>{price != null && x.per_share != null && x.per_share > 0 ? signed(x.per_share / price - 1) : '–'}</td>
                  <td>{pc(x.roe_t)}</td><td>{xx(x.justified_pb)}</td><td>{xx(x.pb_value)}</td></tr>
              })}</tbody>
            </table>
          </div>
          <p className="small muted">Ochre: CMP. Steady-state RoE: the last forecast year’s PAT on its opening book, held for the terminal
            value. Justified P/B = (RoE − g) ÷ (Ke − g) at Ke {pc(v.ke)} and g {pc(v.g)}.</p>
          {drifted(doc.scenarios) && <p className="small muted">Bear and bull no longer sit at base ∓/±3 pp loan growth, ∓/±15 bps NIM and
            ±/∓25 bps credit cost. <button type="button" className="link" onClick={() => copyBase(setDoc, doc.scenarios)}>Re-seed from base</button></p>}
        </section>

        <section className="blk" id="sure" aria-labelledby="sure-h">
          <h2 id="sure-h">Sensitivity</h2>
          {price != null && <p className="answer s"><b>{cells.filter(x => x >= price).length} of {cells.length}</b> cells are at or above CMP
            (Ke × steady-state RoE, around {our}).</p>}
          <div className="sens-grids">
            <Grid id="sens-ke" title="Ke × steady-state RoE" rowsName="Ke" colsName="RoE" grid={sa!.grid}
              rows={v.steps.ke.map(d => pc(v.ke + d))} cols={v.steps.roe.map(d => pc((sa!.roe_t ?? 0) + d))} price={price} />
          </div>
        </section>

        <section className="blk" id="yardsticks" aria-labelledby="yard-h">
          <h2 id="yard-h">Multiples</h2>
          <div className="table-wrap yard-wrap" tabIndex={0} role="region" aria-labelledby="yard-h">
            <table className="yard">
              <thead><tr><th scope="col"><span className="sr">Multiple</span></th><th scope="col">At CMP, {last}</th><th scope="col">At {NAMES[active].toLowerCase()} FV</th><th scope="col">Peer median</th></tr></thead>
              <tbody>
                <tr><th scope="row"><T k="pb" /></th><td className="num mkt">{xx(v.pb)}</td><td className="num ours">{xx(sa?.pb_value)}</td><td className="num">{peerMed ? xx(peerMed.pb) : '–'}</td></tr>
                <tr><th scope="row"><T k="pabv" /></th><td className="num mkt">{xx(v.pabv)}</td>
                  <td className="num ours">{shown != null && v.abvps ? xx(shown / v.abvps) : '–'}</td><td className="num">–</td></tr>
                <tr><th scope="row"><T k="pe" /> ({fy(proj!.years[0])})</th><td className="num mkt">{xx(sa?.pe_price)}</td><td className="num ours">{xx(sa?.pe_value)}</td>
                  <td className="num">{peerMed ? xx(peerMed.pe) : '–'}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="small"><T k="bvps" /> Rs {v.bvps != null ? dec2(v.bvps) : '–'}{v.abvps != null ? <>; <T k="abv" /> Rs {dec2(v.abvps)} (net NPA Rs {money(v.nnpa)} cr)</>
            : <>; no net NPA filed, so no ABV</>}.{' '}<a className="go" href={href('peers')}>{peerMed ? 'Peers' : 'Choose peers'}</a></p>
        </section>

        {sa && sa.ri && sa.pv && <details className="fold" id="bridge">
          <summary><span><b>Residual income build-up</b> · {NAMES[active]} case</span></summary>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Residual income by year">
            <table className="val-table">
              <thead><tr><th scope="col">Rs cr</th>{proj!.years.map(y => <th scope="col" key={y}>{fy(y)}</th>)}</tr></thead>
              <tbody>
                <tr><th scope="row"><T k="pat" /></th>{proj!.scenarios[active].map((r, i) => <td key={i}>{money(r.pat)}</td>)}</tr>
                <tr><th scope="row">Opening book</th>{proj!.scenarios[active].map((_, i) => <td key={i}>{money(i ? proj!.scenarios[active][i - 1].equity : v.book)}</td>)}</tr>
                <tr><th scope="row">Residual income</th>{sa.ri.map((x, i) => <td key={i}>{money(x)}</td>)}</tr>
                <tr><th scope="row">PV at Ke</th>{sa.pv.map((x, i) => <td key={i}>{money(x)}</td>)}</tr>
              </tbody>
            </table>
          </div>
          <p className="small">Book Rs {money(v.book)} cr + PV of residual income Rs {money(sa.pv_sum)} cr + PV of terminal RI Rs {money(sa.pv_tv)} cr
            {' '}= equity Rs {money(sa.equity)} cr ÷ {dec2(v.shares!)} cr shares = <b className="num ours">Rs {rs(shown)}</b>. Terminal RI = (steady-state
            RoE {pc(sa.roe_t)} − Ke {pc(v.ke)}) × final book ÷ (Ke − g); {pc(sa.tv_share)} of value. Equity raised to hold the CET1 floor counts
            as a negative dividend, so dilution is in the value.</p>
        </details>}
      </>}

      <details className="fold blk" id="how">
        <summary><span><b>Valuation inputs (7)</b>{v && <> · Ke {pc(v.ke)} · TG {pc(v.g)}{edited ? ' · edited' : ' · defaults'}</>}</span></summary>
        <p className="why">Common to all three scenarios.
          {edited && <> <button type="button" className="link" onClick={() => onChange(() => parsed.valuation)}>Reset to defaults</button></>}</p>
        <div className="wacc" role="group" aria-label="Cost of equity and terminal growth inputs">
          <Field id="v-rf" label="Risk-free rate (Rf)" term={def('rf')} unit="%" value={inputs.rf} onCommit={x => x != null && set('rf')(x)} />
          <Field id="v-erp" label="Equity risk premium (ERP)" term={def('erp')} unit="%" value={inputs.erp} onCommit={x => x != null && set('erp')(x)} />
          <Field id="v-beta" label="Beta" term={def('beta')} unit="" value={inputs.beta} onCommit={x => x != null && set('beta')(x)} />
          <Field id="v-g" label="Terminal growth (TG)" term="Growth of book and residual income after the explicit period" unit="%" value={inputs.g}
            onCommit={x => x != null && set('g')(x)} />
          <Field id="v-wacc" label="Ke override" term="Blank = CAPM build-up" unit="%" value={inputs.wacc_override} nullable
            fallback={v ? (v.ke_build * 100).toFixed(2) : ''} onCommit={set('wacc_override')} />
          <Field id="v-price" label="CMP" term={company.source?.symbol ? 'From NSE; enter to override' : 'From the export; enter to override'} unit="Rs"
            value={inputs.price} nullable fallback={market?.price != null ? String(market.price) : 'none'} onCommit={set('price')} />
          <Field id="v-shares" label="Shares outstanding" term="Crore" unit="cr" value={inputs.shares} nullable
            fallback={market?.shares != null ? dec2(market.shares).replace(/,/g, '') : 'none'} onCommit={set('shares')} />
        </div>
        {v && <p className="wacc-sum small"><T k="ke" /> <b className="num ours">{pc(v.ke)}</b>{inputs.wacc_override != null
          ? <> (override; build-up {pc(v.ke_build)})</> : <> = {pc(inputs.rf)} + {inputs.beta} × {pc(inputs.erp)}</>}. Cost of debt and WACC don’t
          apply: a lender is valued on equity.</p>}
        {v?.error && <p className="val-error" role="alert">{v.error}</p>}
      </details>
      <Next lead="Fair value moves most with loan growth, credit cost and NIM; edit them in Forecast."><a className="btn" href={href('forecast')}>Forecast</a></Next>
    </>
  )
}

/** Implied RoE (the lender's reverse valuation): the steady-state RoE that today's P/B prices in, against the base
 * case and the record, the Ke the price implies at the base case's RoE, and what moves value one step either way. */
export function LenderImpliedPage({ parsed, doc, projection }: Omit<Props, 'setDoc'>) {
  const href = useHref()
  const v = lenderOf(projection)
  const sv = v?.scenarios.base, value = sv?.per_share ?? null, price = v?.price ?? null
  const roe = parsed.ratios.map(r => r.roe ?? null).filter(fin)
  const last = roe.length ? roe[roe.length - 1] : null, med3 = med(roe.slice(-3))
  const end = projection ? fy(projection.years[projection.years.length - 1]) : ''
  const P = price != null ? <span className="num mkt">Rs {rs(price)}</span> : null
  const answer: ReactNode = !v ? 'Running the valuation…'
    : value == null || value <= 0 ? lenderWords(parsed, projection).answer
    : price == null || v.implied_roe == null ? <>No CMP, so nothing to solve for.</>
    : <><T k="cmp" /> {P} at {xx(v.pb)} <T k="pb" /> implies a <T k="roe_ss">steady-state RoE</T> of <b className="num mkt">{pc(v.implied_roe)}</b> at Ke {pc(v.ke)} and
      g {pc(v.g)}, vs {pc(sv!.roe_t)} in our base case ({end} PAT on opening book){last != null ? <> and {pc(last)} reported <T k="roe_l" /> on average book ({fy(parsed.years[parsed.years.length - 1])})</> : null}.
      {v.implied_ke != null && <> At our base-case RoE the price implies a Ke of {pc(v.implied_ke)}.</>}</>
  const imp = v?.note?.impact ?? []
  return (
    <>
      <PageHead label="Analysis · Implied RoE" title="Implied RoE"
        purpose={<>Implied expectations for a lender: the <T k="roe_ss">steady-state RoE</T> at which the justified P/B, (RoE − g) ÷ (Ke − g), equals P/B
          at CMP. The reverse DCF’s counterpart; fair value is on <a href={href('valuation')}>Valuation</a>.</>}
        answer={answer} />
      {v && value != null && value > 0 && price != null && v.implied_roe != null && <>
        <section className="blk" aria-labelledby="ir-h">
          <h2 id="ir-h">RoE: implied vs ours vs reported</h2>
          <Bars rows={[['Implied by CMP', v.implied_roe, 'mkt'], ['Base case (steady state)', sv!.roe_t ?? 0, 'ink'],
            ...(last != null ? [[`Reported ${fy(parsed.years[parsed.years.length - 1])} (avg book)`, last, 'ink'] as const] : []),
            ...(med3 != null && roe.length >= 3 ? [['Median, last 3 yrs (avg book)', med3, 'ink'] as const] : [])]} />
          <p className="small muted">{v.implied_roe > (sv!.roe_t ?? 0) + 0.02 ? 'The price needs a markedly higher RoE than the base case delivers.'
            : v.implied_roe < (sv!.roe_t ?? 0) - 0.02 ? 'The price needs less RoE than the base case delivers.' : 'The price and the base case roughly agree on RoE.'}
            {' '}Single-stage: it reads today’s book at a steady RoE; growth before the steady state is on Valuation. Steady-state RoE is on
            opening book, so it runs above the forecast and reported RoE on average book by about half the book growth.</p>
        </section>
        {v.note?.roe_scale && <section className="blk" aria-labelledby="sc-h">
          <h2 id="sc-h">Fair value at a steady RoE</h2>
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="sc-h">
            <table className="yard">
              <thead><tr><th scope="col">Steady-state RoE</th>{v.note.roe_scale.filter((_, i) => i % 2 === 0).map(([r]) => <th scope="col" key={r}>{pc(r)}</th>)}</tr></thead>
              <tbody><tr><th scope="row">FV at justified P/B (Rs)</th>{v.note.roe_scale.filter((_, i) => i % 2 === 0).map(([r, x]) =>
                <td key={r} className={`num${x != null && price != null && x >= price ? ' ours' : ''}`}>{x == null || x <= 0 ? '–' : rs(x)}</td>)}</tr></tbody>
            </table>
          </div>
          <p className="small muted">BVPS Rs {v.bvps != null ? dec2(v.bvps) : '–'} × (RoE − {pc(v.g)}) ÷ ({pc(v.ke)} − {pc(v.g)}); blue: at or above CMP;
            – : no value (RoE at or below g).</p>
        </section>}
        {imp.length > 0 && <section className="blk" aria-labelledby="mv-h">
          <h2 id="mv-h">What moves fair value</h2>
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="mv-h">
            <table className="yard">
              <thead><tr><th scope="col">Driver (base case)</th><th scope="col">One step</th><th scope="col">Down (Rs)</th><th scope="col">Up (Rs)</th><th scope="col">Swing</th></tr></thead>
              <tbody>{imp.map(r => <tr key={r.key}><th scope="row"><a href={href('forecast', r.key)}>{r.label}</a></th>
                <td>{r.step < 0.01 ? `${Math.round(r.step * 1e4)} bps` : `${+(r.step * 100).toFixed(1)} pp`}</td>
                <td className="num">{r.down == null ? '–' : rs(r.down)}</td><td className="num">{r.up == null ? '–' : rs(r.up)}</td>
                <td className="num">{r.swing == null ? '–' : `Rs ${money(Math.round(r.swing))}`}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="small muted">Each driver moved one step either way in every forecast year, the others at base; base FV Rs {rs(value)}.</p>
        </section>}
      </>}
      <Next lead="Test an implied RoE against the drivers behind it."><a className="btn" href={href('forecast', 'credit_cost')}>Forecast</a></Next>
    </>
  )
}

/** Financials for a lender: growth, the RoA tree and asset quality, from the reported years. */
export function LenderFinancials({ parsed }: { parsed: Parsed }) {
  const href = useHref()
  const hist = parsed.hist ?? parsed.company.hist, years = parsed.years, n = hist.length, r = parsed.ratios
  const col = (k: string) => hist.map(h => h[k] ?? null), rc = (k: string) => r.map(x => x[k] ?? null)
  const short = properName(parsed.company.name).replace(/\s+(ltd\.?|limited)$/i, '').trim()
  const last = fy(years[n - 1]), first = fy(years[0])
  const st = (sub: string, key: string) => href('statements', key, sub)
  const spans = [3, 5, 10].filter(k => k <= n - 1)
  if (!spans.length && n > 1) spans.push(n - 1)
  const adv = col('advances'), nii = col('nii'), pat = col('pat'), dep = col('deposits'), eq = col('equity')
  const roa = rc('roa'), roe = rc('roe'), nim = rc('nim'), ci = rc('cost_income'), cc = rc('credit_cost')
  const gnpa = col('gnpa_pct'), nnpa = col('nnpa_pct'), pcr = col('pcr'), cet1 = col('cet1')
  const lit = (key: string) => (parsed.forensic ?? []).find(f => f.key === key && ['high', 'medium', 'low'].includes(f.severity)) ?? null
  const g3 = cagrOf(adv, Math.min(3, n - 1))
  const cards: { id: string; title: string; big: string; says: ReactNode; chart: ReactNode; to: string; table: string; lit?: ReturnType<typeof lit> }[] = [
    { id: 'advances', title: 'Advances and deposits', big: `Rs ${money(adv[n - 1])} cr`, to: st('balance-sheet', 'advances'), table: 'Balance sheet',
      says: <>{g3 != null ? <>Loan <T k="cagr" /> {pc(g3)} over {Math.min(3, n - 1)} years. </> : null}{dep[n - 1] ? <><T k="cd_ratio" /> {pc(rc('cd_ratio')[n - 1])}.</> : 'Not deposit-funded.'}</>,
      chart: <Plot years={years} kind="bars" lines={[{ v: adv, name: 'Advances' }, { v: dep, cls: 'out', name: 'Deposits' }]} show={money} label="Advances and deposits by year, Rs cr" /> },
    { id: 'nii', title: 'NII and PAT', big: `Rs ${money(nii[n - 1])} cr`, to: st('profit-and-loss', 'nii'), table: 'P&L',
      says: <><T k="nii" /> and <T k="pat" />, Rs cr. PAT {last}: Rs {money(pat[n - 1])} cr.</>,
      chart: <Plot years={years} kind="bars" neg lines={[{ v: nii, name: 'NII' }, { v: pat, cls: 'out', name: 'PAT' }]} show={money} label="NII and PAT by year, Rs cr" /> },
    { id: 'nim', title: 'NIM, yield and cost of funds', big: pc(nim[n - 1]), to: st('ratios', 'nim'), table: 'Ratios', lit: lit('nim') ?? lit('spread'),
      says: <><T k="nim" /> on average total assets; <T k="yld" /> and <T k="cof" /> beside it.</>,
      chart: <Plot years={years} kind="lines" lines={[{ v: nim, name: 'NIM' }, { v: rc('yield'), cls: 'alt', name: 'Yield' }, { v: rc('cof'), cls: 'out', name: 'Cost of funds' }]} show={pc} label="NIM, yield and cost of funds by year" /> },
    { id: 'roa', title: 'RoA and RoE', big: pc(roe[n - 1]), to: st('ratios', 'roe'), table: 'Ratios',
      says: <><T k="roa" /> {pc(roa[n - 1])} × leverage {xx(rc('leverage')[n - 1])} ≈ <T k="roe_l" /> {pc(roe[n - 1])}.</>,
      chart: <Plot years={years} kind="lines" lines={[{ v: roe, name: 'RoE' }, { v: roa, cls: 'alt', name: 'RoA' }]} show={pc} label="RoE and RoA by year" /> },
    { id: 'cost', title: 'Cost-to-income and credit cost', big: pc(ci[n - 1]), to: st('ratios', 'cost_income'), table: 'Ratios', lit: lit('credit_cost'),
      says: <><T k="cost_income" /> {pc(ci[n - 1])}; <T k="credit_cost" /> {pc(cc[n - 1])}{cc.some(x => x == null) ? ' (export years hold provisions inside opex)' : ''}.</>,
      chart: <Plot years={years} kind="lines" lines={[{ v: ci, name: 'Cost-to-income' }, { v: cc, cls: 'alt', name: 'Credit cost' }]} show={pc} label="Cost-to-income and credit cost by year" /> },
    { id: 'aq', title: 'Asset quality', big: gnpa[n - 1] != null ? pc(gnpa[n - 1]) : 'not filed', to: st('ratios', 'gnpa_pct'), table: 'Ratios', lit: lit('gnpa') ?? lit('pcr'),
      says: gnpa.some(fin) ? <><T k="gnpa" /> and <T k="nnpa" /> % of advances; <T k="pcr" /> {pc(pcr[n - 1])}.</>
        : <>No GNPA in the XBRL results for this lender (NBFCs don’t file it there); the annual report has it.</>,
      chart: <Plot years={years} kind="lines" lines={[{ v: gnpa, name: 'GNPA' }, { v: nnpa, cls: 'alt', name: 'NNPA' }]} show={pc} label="GNPA and NNPA % by year" /> },
    { id: 'capital', title: 'Capital (CET1 / CRAR as filed) and net worth', big: cet1[n - 1] != null ? pc(cet1[n - 1]) : `Rs ${money(eq[n - 1])} cr`, to: st('balance-sheet', 'equity'), table: 'Balance sheet', lit: lit('capital'),
      says: cet1.some(fin) ? <><T k="cet1" /> as filed; net worth Rs {money(eq[n - 1])} cr.</> : <>No CET1 in the XBRL results; net worth Rs {money(eq[n - 1])} cr ({pc(rc('equity_assets')[n - 1])} of assets).</>,
      chart: cet1.some(fin) ? <Plot years={years} kind="lines" lines={[{ v: cet1 }]} show={pc} label="CET1 / CRAR as filed, by year" />
        : <Plot years={years} kind="bars" lines={[{ v: eq }]} show={money} label="Net worth by year, Rs cr" /> },
  ]
  const growthRows: [ReactNode, (number | null)[]][] = [['Advances', adv], ['Deposits', dep], [<T k="nii" key="n" />, nii], [<T k="pat" key="p" />, pat], ['Net worth', eq]]
  const story = <>{g3 != null ? <>Loan <T k="cagr" /> {pc(g3)} over {Math.min(3, n - 1)} years; </> : null}{last} <T k="roa" /> {pc(roa[n - 1])},{' '}
    <T k="roe_l" /> {pc(roe[n - 1])}, <T k="nim" /> {pc(nim[n - 1])}{gnpa[n - 1] != null ? <>, <T k="gnpa" /> {pc(gnpa[n - 1])}</> : null}.</>
  return (
    <>
      <PageHead label="Data · Financials" title="Financials"
        purpose={<>{n}-year reported fundamentals for {short} ({first}–{last.slice(-2)}), lender template: growth, the RoA tree and asset quality.
          Each chart links to its statement line.</>} answer={story} />
      <section className="blk first" id="growth" aria-labelledby="growth-h">
        <h2 id="growth-h">CAGR</h2>
        <div className="tw-m" tabIndex={0} role="region" aria-labelledby="growth-h">
          <table className="growth">
            <thead><tr><th scope="col">Rs cr</th>{spans.map(k => <th scope="col" key={k}>{k}Y</th>)}</tr></thead>
            <tbody>{growthRows.map(([name, v], i) => <tr key={i}><th scope="row">{name}</th>{spans.map(k => <td key={k} className="num">{pc(cagrOf(v, k))}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </section>
      <section className="blk" id="charts" aria-labelledby="charts-h">
        <h2 id="charts-h">{n}-year trends</h2>
        <div className="fgrid">{cards.map(c => (
          <article key={c.id} id={`f-${c.id}`} tabIndex={-1} className={`fcard${c.lit ? ` lit s-${c.lit.severity}` : ''}`} aria-labelledby={`fh-${c.id}`}>
            <header><h3 id={`fh-${c.id}`}>{c.title}</h3><span className="big">{c.big}</span></header>
            <p className="says">{c.says}</p>
            {c.chart}
            <footer><span>{c.lit ? c.lit.fact : `${first}–${last.slice(-2)}`}</span><a className="go" href={c.to}>{c.table} table</a></footer>
          </article>))}</div>
      </section>
      <RoaTree parsed={parsed} />
      <Next lead="Full reported P&L, balance sheet and ratios."><a className="primary" href={href('statements')}>Statements</a></Next>
    </>
  )
}

/** The RoA tree, every reported year: each line as % of average total assets, adding up to RoA, times leverage = RoE. */
function RoaTree({ parsed }: { parsed: Parsed }) {
  const r = parsed.ratios, hist = parsed.hist ?? parsed.company.hist
  const from = Math.max(1, r.length - 6)
  const cols = r.slice(from).map((x, i) => ({ y: fy(parsed.years[from + i]), x, h: hist[from + i], e: false }))
  const lines: [ReactNode, (x: Row, h: Row) => number | null | undefined, string?][] = [
    [<T k="nim" />, x => x.nim],
    ['Fee & other income', x => x.oi_pct],
    ['Operating expenses', x => x.opex_assets, '−'],
    ['Provisions', x => x.prov_assets, '−'],
    ['Tax', x => x.tax_assets, '−'],
    [<b><T k="roa" /></b>, x => x.roa],
    ['× leverage (avg assets ÷ avg net worth)', x => x.leverage, 'x'],
    [<b><T k="roe_l" /></b>, x => x.roe],
  ]
  return (
    <section className="blk" id="roa-tree" aria-labelledby="tree-h">
      <h2 id="tree-h">RoA tree <span className="cnt">% of average total assets</span></h2>
      <div className="tw" tabIndex={0} role="region" aria-labelledby="tree-h">
        <table className="rt">
          <thead><tr><td />{cols.map(c => <th scope="col" key={c.y}>{c.y}</th>)}</tr></thead>
          <tbody>{lines.map(([label, f, kind], i) => <tr key={i}><th scope="row">{kind === '−' ? <>− {label}</> : label}</th>
            {cols.map(c => { const v = f(c.x, c.h); return <td key={c.y}>{v == null ? '–' : kind === 'x' ? xx(v) : pc(v)}</td> })}</tr>)}</tbody>
        </table>
      </div>
      <p className="small muted">NIM + fee income − opex − provisions − tax = RoA (export years hold provisions inside opex). RoA × leverage = RoE.</p>
    </section>
  )
}

/** Summary's key financials for a lender: the last reported year and the first two base-case years. */
export function LenderKeyFinancials({ parsed, projection }: { parsed: Parsed; projection: Projection | null }) {
  const v = lenderOf(projection), p = projection?.scenarios.base
  if (!v || !p?.length) return null
  const hist = parsed.hist ?? parsed.company.hist, n = hist.length, r = parsed.ratios[n - 1]
  const sh = v.shares
  const cols = [{ y: `${fy(parsed.years[n - 1])}A`, row: { ...hist[n - 1], roa: r.roa, roe: r.roe } as Row, prev: n > 1 ? hist[n - 2] : null, e: false },
    ...p.slice(0, 2).map((row, i) => ({ y: fy(projection!.years[i]).replace(/E?$/, 'E'), row, prev: i ? p[i - 1] : hist[n - 1], e: true }))]
  const per = (x: number | null | undefined) => (x != null && sh ? x / sh : null)
  const lines: [ReactNode, (c: typeof cols[number]) => string][] = [
    [<T k="nii" />, c => money(c.row.nii)],
    [<>NII <T k="yoy" /></>, c => fmt(c.prev?.nii ? (c.row.nii ?? 0) / c.prev.nii - 1 : null, 'pct')],
    [<T k="ppop" />, c => money(c.row.ppop)],
    ['Provisions', c => money(c.row.provisions)],
    [<T k="pat" />, c => money(c.row.pat)],
    [<><T k="eps" /> (Rs)</>, c => { const e = per(c.row.pat); return e == null ? '–' : e.toFixed(2) }],
    [<><T k="bvps" /> (Rs)</>, c => { const b = per(c.row.equity); return b == null ? '–' : b.toFixed(2) }],
    [<T k="pe" />, c => { const e = per(c.row.pat); return fmt(v.price != null && e != null && e > 0 ? v.price / e : null, 'x') }],
    [<T k="pb" />, c => { const b = per(c.row.equity); return fmt(v.price != null && b != null && b > 0 ? v.price / b : null, 'x') }],
    [<T k="roa" />, c => pc(c.row.roa)],
    [<T k="roe_l" />, c => pc(c.row.roe)],
    [<T k="gnpa" />, c => (c.e ? '–' : pc(c.row.gnpa_pct))],
  ]
  const cap = v.price != null && sh ? v.price * sh : null
  return (
    <section className="keyfin" aria-labelledby="kf-h">
      <h2 id="kf-h">Key financials <span className="cnt">Rs cr · base case · multiples at CMP</span></h2>
      <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="kf-h">
        <table className="kf-table">
          <thead><tr><th scope="col"><span className="sr">Metric</span></th>{cols.map(c => <th scope="col" key={c.y} className={c.e ? 'proj' : undefined}>{c.y}</th>)}</tr></thead>
          <tbody>{lines.map(([label, f], k) => <tr key={k}><th scope="row">{label}</th>
            {cols.map(c => <td key={c.y} className={c.e ? 'proj' : undefined}>{f(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {cap != null && <p className="small muted">CMP Rs {rs(v.price!)} · <T k="mcap" /> Rs {money(cap)} cr · <T k="pabv" /> {xx(v.pabv)}</p>}
    </section>
  )
}

/** Summary's second card for a lender: implied RoE against ours. */
export function ImpliedCard({ parsed, projection }: { parsed: Parsed; projection: Projection | null }) {
  const href = useHref()
  const v = lenderOf(projection), sv = v?.scenarios.base
  const last = parsed.ratios[parsed.ratios.length - 1]?.roe ?? null
  return (
    <article className="acard" aria-labelledby="q2">
      <h2 id="q2">Implied RoE</h2>
      {!v || sv?.per_share == null || v.price == null || v.implied_roe == null ? <p className="serif">No fair value or no CMP, so nothing to solve for.</p> : <>
        <p className="serif">CMP at {xx(v.pb)} P/B implies a <T k="roe_ss">steady-state RoE</T> of {pc(v.implied_roe)} (Ke {pc(v.ke)}, g {pc(v.g)}).</p>
        <Bars rows={[['Implied', v.implied_roe, 'mkt'], ['Base case (steady state)', sv.roe_t ?? 0, 'ink'], ...(last != null ? [['Last reported (avg book)', last, 'ink'] as const] : [])]} />
      </>}
      <a className="go" href={href('reverse-dcf')}>Implied expectations</a>
    </article>
  )
}

/** Forecast output for a lender: advances, PAT and the RoE path, and the equity raised to hold the floor. */
export function LenderReadout({ parsed, projection, active, n }: { parsed: Parsed; projection: Projection | null; active: Scenario; n: number }) {
  const proj = projection?.scenarios[active].length === n ? projection.scenarios[active] : null
  if (!proj) return null
  const hist = parsed.hist ?? parsed.company.hist, last = hist[hist.length - 1], end = proj[proj.length - 1]
  const r = parsed.ratios[parsed.ratios.length - 1]
  const cagr = (a: number | null | undefined, b: number | null | undefined) => (a && b && a > 0 && b > 0 ? (b / a) ** (1 / n) - 1 : null)
  const raised = proj.reduce((s, x) => s + (x.raised ?? 0), 0)
  const Y = fy(projection!.years[n - 1])
  const O = ({ children }: { children: ReactNode }) => <span className="num ours">{children}</span>
  const all = projection!.scenarios
  return <>
    <p className="readout">Advances Rs {money(last.advances)} cr ({fy(parsed.years[parsed.years.length - 1])}) to <O>Rs {money(end.advances)} cr</O> ({Y}),{' '}
      <O>{pc(cagr(last.advances, end.advances))}</O> CAGR. PAT <O>{pc(cagr(last.pat, end.pat))}</O> CAGR to <O>Rs {money(end.pat)} cr</O>.{' '}
      <T k="roa" /> {pc(r?.roa)} → <O>{pc(end.roa)}</O>; <T k="roe_l" /> {pc(r?.roe)} → <O>{pc(end.roe)}</O>; <T k="cet1" /> <O>{pc(end.cet1)}</O> in {Y}.</p>
    {raised >= 0.5 && <p className="guard">Capital: <b>Rs {money(raised)} cr</b> of equity is raised over {n} years to hold the CET1 floor of{' '}
      {pc(proj[0].cet1_min)}. It counts as a negative dividend in the valuation. Lower loan growth or payout, or the floor, to avoid it.</p>}
    <p className="compare">{Y} PAT (Rs cr): {ORDER.map((s, i) => <span key={s}>{i > 0 && ' · '}{NAMES[s]} {s === active
      ? <b className="num ours">{money(all[s][n - 1].pat)}</b> : <span className="num">{money(all[s][n - 1].pat)}</span>}</span>)}. RoE:{' '}
      {ORDER.map((s, i) => <span key={s}>{i > 0 && ' · '}{NAMES[s]} {pc(all[s][n - 1].roe)}</span>)}.</p>
  </>
}

/** The note page for a lender: the rules' answer line and why the written note waits. */
export function LenderNote({ parsed, projection }: { parsed: Parsed; projection: Projection | null }) {
  const href = useHref()
  return <>
    <PageHead label="Model · Research note" title="Research note" purpose={<>The AI-drafted note for {subjectOf(parsed.company)}.</>}
      answer={lenderWords(parsed, projection).answer} />
    <p className="empty-state">The written note isn’t available for banks and NBFCs yet: its writer reads the non-financial model’s lines.
      Everything on the other pages is computed by rules.</p>
    <More title="What the rules say instead">
      <p className="small">Valuation, implied RoE, the RoA tree and the lender forensic checks are complete; the note will be drafted from them
        when the writer learns the lender template.</p>
    </More>
    <Next lead="The red flags a note would discuss."><a className="primary" href={href('risks')}>Risks & forensics</a></Next>
  </>
}
