import type { ReactNode } from 'react'
import { last3Of, subjectOf, useWrite, verdictWords } from './Note'
import { riskWords } from './Risks'
import { peerWords } from './Peers'
import { yearSources } from './Documents'
import { ago } from './Fetch'
import { qfy } from './lib'
import { growth } from './Statements'
import { latestScored, quarterWords, unreviewed } from './Tracking'
import { useAi } from './Sources'
import { Next, PageHead, Scale, Stepper, Verdict } from './Shell'
import { useHref } from './route'
import { T } from './Term'
import { NAMES, SEV_WORD, capOf, fmt, fy, money, properName, rs, sevCounts, when, type Cagr, type ModelDoc, type Parsed, type Projection, type Severity } from './lib'

const pc = (v: number) => fmt(v, 'pct')

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null
  check: ReactNode; checkMsg: ReactNode // Check for new results, and what it last said
  onReview: () => void
}

/** Summary: the answer line, then five cards, each opening the page with its evidence; the note's thesis points,
 * data sources, and Mark as reviewed. */
export default function Summary({ parsed, doc, setDoc, projection, check, checkMsg, onReview }: Props) {
  const href = useHref()
  const ai = useAi()
  const { company, years } = parsed
  const name = subjectOf(company)
  const restatedOpen = [...new Set((company.source?.restated ?? []).filter(r => !r.used).map(r => r.year))]
  const v = projection?.valuation ?? null
  const sv = v?.scenarios.base
  const price = v?.price ?? null
  const values = { bear: v?.scenarios.bear.per_share ?? null, base: sv?.per_share ?? null, bull: v?.scenarios.bull.per_share ?? null }
  const { answer, fix } = verdictWords(parsed, projection)
  const noValue = !!v && (values.base == null || values.base <= 0)
  const implied = sv?.implied_growth ?? null
  const l3 = last3Of(parsed)
  const best = (cs: Cagr[] = []) => (cs.length ? cs.reduce((a, b) => (b.value > a.value ? b : a)) : null)
  const best5 = best(parsed.cagrs?.['5'])
  const t = projection?.tracking
  const s = latestScored(t)
  const fresh = !!s && unreviewed(doc, t)
  const rev = s?.year.lines.find(l => l.key === 'revenue')
  const vs = (e: number | null | undefined) => (e == null ? '' : `Revenue ${pc(Math.abs(e))} ${e >= 0 ? 'ahead of' : 'behind'} forecast.`)
  const since = company.source?.fetched_at ?? doc.saved_at
  const lastQ = company.quarters?.dates.at(-1)
  const qt = projection?.quarter
  const qline = qt && quarterWords({ ...qt, rev: qt.lines.find(l => l.key === 'revenue')?.gap ?? null, pat: qt.lines.find(l => l.key === 'pat')?.gap ?? null })
  const c = sevCounts(parsed.forensic)
  const tn = doc.note
  const w = useWrite(doc, setDoc)
  const peers = doc.peers
  const read = peers?.approved_at ? projection?.peers?.peers.filter(r => r.metrics && peers.chosen.includes(r.symbol ?? '')).length ?? 0 : 0
  const fixLink = fix && <a className="primary" href={href(fix.page, fix.anchor)}>{fix.label}</a>

  return (
    <>
      <PageHead label="Summary" title={properName(company.name).replace(/\s+(ltd\.?|limited)$/i, '').trim()}
        purpose="Valuation, implied expectations, forensics, latest results and peers."
        answer={answer} />
      {fixLink && <p className="fix-line">{fixLink}</p>}
      {doc.active !== 'base' && <p className="small-note">This page shows the base case. {NAMES[doc.active]}-case fair value:
        {v && (v.scenarios[doc.active].per_share ?? 0) > 0 ? <> <span className="num ours">Rs {rs(v.scenarios[doc.active].per_share!)}</span>/share</> : ' n/a'}.{' '}
        <a href={href('valuation')}>All scenarios on Valuation</a></p>}
      {fresh && <div className="banner new" role="status"><p><b>New results: {fy(s!.year.year)}.</b> {vs(rev?.err)}</p>
        <div className="banner-act"><a className="btn" href={href('tracking')}>Results tracking</a></div></div>}

      <KeyFinancials parsed={parsed} projection={projection} />
      <div className="cards">
        <article className="acard" aria-labelledby="q1">
          <h2 id="q1">Valuation</h2>
          {noValue ? <p className="serif">No fair value yet.</p> : <>
            <p className="serif">{price == null ? 'No CMP to compare with.' : <><Verdict price={price} values={values} /> Base-case fair value{' '}
              <span className="num ours">Rs {rs(values.base!)}</span> vs <T k="cmp" /> <span className="num mkt">Rs {rs(price)}</span>.</>}</p>
            <Scale price={price} bear={values.bear} base={values.base} bull={values.bull} />
            <p className="small dim">Ochre: CMP. Blue band: bear–bull fair-value range; blue line: base.</p>
          </>}
          <a className="go" href={href('valuation')}>DCF and sensitivity</a>
        </article>

        <article className="acard" aria-labelledby="q2">
          <h2 id="q2">Reverse DCF</h2>
          {noValue || price == null ? <p className="serif">No fair value or no CMP, so nothing to solve for.</p>
            : implied == null ? <p className="serif">No flat revenue growth between −30% and +80% reconciles base-case FV to CMP.</p>
            : <>
              <p className="serif">CMP implies {pc(implied)} revenue <T k="cagr" /> for {doc.n} years.
                {best5 && <> Best 5-year CAGR on record: {pc(best5.value)} ({fy(best5.from)}–{best5.to.slice(-2)}).</>}</p>
              <Bars rows={[['Implied', implied, 'mkt'], ...(best5 ? [['Best 5-yr', best5.value, 'ink'] as const] : []), ...(l3 != null ? [['Last 3-yr', l3, 'ink'] as const] : [])]} />
            </>}
          <a className="go" href={href('reverse-dcf')}>Implied expectations</a>
        </article>

        <article className="acard" aria-labelledby="q3">
          <h2 id="q3">Risks & forensics</h2>
          <p className="serif">{riskWords(parsed.forensic)}</p>
          <Meter c={c} />
          <a className="go" href={href('risks')}>Red flags</a>
        </article>

        <article className="acard" aria-labelledby="q4">
          <h2 id="q4">Results tracking</h2>
          {fresh ? <p className="serif">New results: {fy(s!.year.year)}. {vs(rev?.err)}</p>
            : <p className="serif">No new results since the model was built{since ? ` (${when(since).replace(/ \d{4}$/, '')})` : ''}.
              {' '}Latest filed: {lastQ ? qfy(lastQ) : fy(years[years.length - 1])}.</p>}
          {qline && <p className="small"><a href={href('tracking', 'quarter')}>{qline}</a>.</p>}
          {!fresh && <div className="acard-act">{check}</div>}
          {checkMsg && <p className="small" role="status">{checkMsg}</p>}
          <a className="go" href={href('tracking')}>Results vs forecast</a>
        </article>

        <article className="acard wide" aria-labelledby="q5">
          <h2 id="q5">Peers</h2>
          <p className="serif">{!peers?.approved_at ? 'No peer set yet.' : !read || !projection?.peers ? 'Peer set chosen; financials not read yet.'
            : peerWords(projection.peers, read, name)}</p>
          <a className="go" href={href('peers')}>{peers?.approved_at ? 'Relative valuation' : 'Choose peers'}</a>
        </article>
      </div>
      <TryIt doc={doc} setDoc={setDoc} projection={projection} />

      <section className="note-x" aria-labelledby="nx-h">
        <h2 id="nx-h">Research note <span className="ai-tag">AI-drafted · numbers rule-checked</span></h2>
        {tn ? <>
          <p className="small dim">Written {when(tn.written_at)} from this model’s outputs.</p>
          <ol className="nx-points">{tn.thesis.map((p, i) => <li key={i} className="serif"><b>{p.head}</b></li>)}</ol>
          <a className="btn" href={href('note')}>Read the full note</a>
        </> : ai && !ai.available ? <>
          <p className="serif">AI drafting is off. Everything else here is computed by rules.</p>
          <a href={href('documents', 'ai')}>How to turn it on</a>
        </> : <>
          <p className="serif">Not written yet. AI drafts a three-point thesis from this model’s outputs; every number is checked before saving.</p>
          <p><button type="button" className="btn" onClick={w.write} disabled={w.busy || !ai}>{w.busy ? 'Writing the note · about a minute…' : 'Write the note (about a minute)'}</button></p>
          {w.fail && <p className="error" role="alert">{w.fail.text}{w.fail.checks?.length ? ` ${w.fail.checks.map(x => x.detail).join(' ')}` : ''} Nothing was saved.{' '}
            <button type="button" className="link" onClick={w.write}>Try again</button></p>}
        </>}
      </section>

      <p className="src-line-s small">Source: {yearSources(company, years).map(([l, y]) => `${l} ${y}`).join(' and ')}
        {company.source?.symbol ? ` · CMP ${ago(company.source.price_at)}` : ''} · <a href={href('documents', 'sources')}>Details</a>
        {restatedOpen.length > 0 && <> · {restatedOpen.join(', ')} restated later, not like-for-like:{' '}
          <a href={href('documents', 'restated')}>choose filed or restated</a></>}</p>

      <Next lead={doc.reviewed_at ? <>Reviewed {when(doc.reviewed_at).replace(/ \d{4}$/, '')}.</>
        : <>Before relying on this: read Risks & forensics and the note, then mark it reviewed.</>}>
        <button type="button" className={doc.reviewed_at || fix ? 'btn' : 'primary'} onClick={onReview}>{doc.reviewed_at ? 'Mark as draft' : 'Mark as reviewed'}</button>
      </Next>
    </>
  )
}

/** Page 1 of a broker note: the last reported year and the first two base-case forecast years, with Mcap and EV at CMP. */
function KeyFinancials({ parsed, projection }: { parsed: Parsed; projection: Projection | null }) {
  const v = projection?.valuation
  const p = projection?.scenarios.base
  if (!v || !p?.length) return null
  const hist = parsed.hist ?? parsed.company.hist, n = hist.length
  const now = v.shares ?? null, lastShares = parsed.company.market?.shares_hist?.[n - 1] ?? now
  const cols = [
    { y: `${fy(parsed.years[n - 1])}A`, r: hist[n - 1], prev: n > 1 ? hist[n - 2] : null, sh: lastShares, e: false },
    ...p.slice(0, 2).map((r, i) => ({ y: fy(projection!.years[i]).replace(/E?$/, 'E'), r, prev: i ? p[i - 1] : hist[n - 1], sh: now, e: true })),
  ]
  const cap = capOf(v)
  const div = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b > 0 ? a / b : null)
  const eps = (c: typeof cols[number]) => div(c.r.pat, c.sh)
  const epsPrev = (i: number) => (i ? eps(cols[i - 1]) : div(cols[0].prev?.pat, cols[0].sh))
  const lines: [ReactNode, (c: typeof cols[number], i: number) => string][] = [
    ['Revenue', c => money(c.r.revenue)],
    [<>Revenue <T k="yoy" /></>, c => fmt(growth(c.r.revenue, c.prev?.revenue), 'pct')],
    [<T k="ebitda" />, c => money(c.r.ebitda)],
    [<T k="ebitda_margin" />, c => fmt(div(c.r.ebitda, c.r.revenue), 'pct')],
    [<T k="pat" />, c => money(c.r.pat)],
    [<><T k="eps" /> (Rs)</>, c => { const e = eps(c); return e == null ? '–' : e.toFixed(2) }],
    [<>EPS <T k="yoy" /></>, (c, i) => { const a = eps(c), b = epsPrev(i); return fmt(a != null && b != null && b > 0 ? a / b - 1 : null, 'pct') }],
    [<T k="pe" />, c => { const e = eps(c); return fmt(v.price != null && e != null && e > 0 ? v.price / e : null, 'x') }],
    [<T k="ev_ebitda" />, c => fmt(cap && (c.r.ebitda ?? 0) > 0 ? cap.ev / c.r.ebitda! : null, 'x')],
    [<T k="roe" />, c => fmt(c.r.roe, 'pct')],
    [<T k="roce" />, c => fmt(c.r.roce, 'pct')],
  ]
  return (
    <section className="keyfin" aria-labelledby="kf-h">
      <h2 id="kf-h">Key financials <span className="cnt">Rs cr · base case · multiples at CMP</span></h2>
      <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="kf-h">
        <table className="kf-table">
          <thead><tr><th scope="col"><span className="sr">Metric</span></th>{cols.map(c => <th scope="col" key={c.y} className={c.e ? 'proj' : undefined}>{c.y}</th>)}</tr></thead>
          <tbody>{lines.map(([label, f], k) => <tr key={k}><th scope="row">{label}</th>
            {cols.map((c, i) => <td key={c.y} className={c.e ? 'proj' : undefined}>{f(c, i)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {cap && <p className="small muted">CMP Rs {rs(v.price!)} · <T k="mcap" /> Rs {money(cap.mcap)} cr · <T k="ev" /> Rs {money(cap.ev)} cr ·{' '}
        <T k="net_debt" /> Rs {money(cap.ev - cap.mcap)} cr</p>}
    </section>
  )
}

/** Horizontal bars on one scale, the figure written beside each (a negative one says so in its sign and its words). */
function Bars({ rows }: { rows: readonly (readonly [string, number, 'mkt' | 'ink'])[] }) {
  const max = Math.max(...rows.map(r => Math.abs(r[1])), 1e-9)
  return (
    <dl className="hbars">{rows.map(([k, x, tone]) => <div key={k}>
      <dt>{k}</dt>
      <dd><span className={`hb ${tone}${x < 0 ? ' neg' : ''}`} style={{ width: `${(Math.abs(x) / max) * 100}%` }} /><span className="num">{pc(x)}</span></dd>
    </div>)}</dl>
  )
}

/** Five boxes: how many checks at each severity; the colour only repeats the word. */
export function Meter({ c }: { c: Record<Severity, number> }) {
  return (
    <ul className="meter" aria-label="Forensic checks by severity">
      {(['high', 'medium', 'low', 'ok', 'not_checked'] as Severity[]).map(s => (
        <li key={s} className={`m-${s}${c[s] && s !== 'ok' && s !== 'not_checked' ? ' on' : ''}`}><b className="num">{c[s]}</b><span>{SEV_WORD[s].toLowerCase()}</span></li>))}
    </ul>
  )
}

/** Quick sensitivity: the two drivers that move fair value most, as one live line on the active scenario. The same
 * setter as the Forecast rows, so both always agree. A faded path is edited in the forecast instead. */
function TryIt({ doc, setDoc, projection }: { doc: ModelDoc; setDoc: Props['setDoc']; projection: Projection | null }) {
  const href = useHref()
  const a = doc.scenarios[doc.active], src = doc.assumption_sources[doc.active] ?? {}
  const value = projection?.scenarios[doc.active].length === doc.n ? projection.valuation.scenarios[doc.active].per_share : null
  const set = (k: string) => (x: number) => setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [d.active]: { ...d.scenarios[d.active], [k]: { start: x, end: null } } } }))
  const box = (k: 'growth' | 'ebitda_margin', label: string) =>
    <Stepper id={`try-${k}`} label={label} kind="pct" value={a[k]?.start ?? 0} onChange={set(k)} you={!!src[k] && src[k] !== 'history'} />
  const fv = <b className="num ours">{value != null && value > 0 ? `Rs ${rs(value)}/share` : 'n/a'}</b>
  // a year-by-year input can't sit in one sentence: say what it does and send it to the forecast
  const moving = (['growth', 'ebitda_margin'] as const).filter(k => a[k]?.end != null)
  return (
    <section className="try" aria-labelledby="try-h">
      <h2 id="try-h">Quick sensitivity <span className="cnt">{NAMES[doc.active]} case</span></h2>
      {moving.length
        ? <p className="answer s">{moving.map(k => `${k === 'growth' ? 'Revenue growth' : 'EBITDA margin'} fades ${pc(a[k].start)} → ${pc(a[k].end!)}`).join('; ')};
            edit in <a href={href('forecast', moving[0])}>Forecast</a>. Fair value {fv}.</p>
        : <p className="answer s">Revenue growth {box('growth', 'Revenue growth')} a year, EBITDA margin {box('ebitda_margin', 'EBITDA margin')}:
            fair value {fv}.</p>}
      <p className="small muted">Same drivers as in <a href={href('forecast')}>Forecast</a>; a change here changes them there.</p>
    </section>
  )
}
