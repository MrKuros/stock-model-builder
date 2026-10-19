import type { ReactNode } from 'react'
import { last3Of, subjectOf, useWrite, verdictWords } from './Note'
import { riskWords } from './Risks'
import { peerWords } from './Peers'
import { yearSources } from './Documents'
import { ago } from './Fetch'
import { month } from './Statements'
import { latestScored, unreviewed } from './Tracking'
import { useAi } from './Sources'
import { Next, PageHead, Scale, Stepper, Verdict } from './Shell'
import { useHref } from './route'
import { NAMES, SEV_WORD, fmt, rs, sevCounts, when, type Cagr, type ModelDoc, type Parsed, type Projection, type Severity } from './lib'

const pc = (v: number) => fmt(v, 'pct')
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null
  check: ReactNode; checkMsg: ReactNode // Check for new results, and what it last said
  onReview: () => void
}

/** Summary: the answer in two sentences, then five answer cards, each opening the page with its evidence; the note's
 * three points, where the numbers come from, and Mark as reviewed. */
export default function Summary({ parsed, doc, setDoc, projection, check, checkMsg, onReview }: Props) {
  const href = useHref()
  const ai = useAi()
  const { company, years } = parsed
  const name = subjectOf(company)
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
  const vs = (e: number | null | undefined) => (e == null ? '' : `Sales ${pc(Math.abs(e))} ${e >= 0 ? 'above' : 'below'} our forecast.`)
  const since = company.source?.fetched_at ?? doc.saved_at
  const lastQ = company.quarters?.dates.at(-1)
  const c = sevCounts(parsed.forensic)
  const tn = doc.note
  const w = useWrite(doc, setDoc)
  const peers = doc.peers
  const read = peers?.approved_at ? projection?.peers?.peers.filter(r => r.metrics && peers.chosen.includes(r.symbol ?? '')).length ?? 0 : 0
  const fixLink = fix && <a className="primary" href={href(fix.page, fix.anchor)}>{fix.label}</a>

  return (
    <>
      <PageHead label="Summary" title={company.name.replace(/\s+(ltd\.?|limited)$/i, '').trim()}
        purpose="The five questions an analyst asks, answered from this model. Each card opens the page with the evidence."
        answer={answer} />
      {fixLink && <p className="fix-line">{fixLink}</p>}
      {doc.active !== 'base' && <p className="small-note">This page is about the central case. Your {NAMES[doc.active].toLowerCase()} case is
        {v?.scenarios[doc.active].per_share != null ? <> <span className="num ours">Rs {rs(v.scenarios[doc.active].per_share!)}</span> a share</> : ' without a value'}:{' '}
        <a href={href('value')}>see every case on Is it cheap?</a></p>}
      {fresh && <div className="banner new" role="status"><p><b>New results: {s!.year.year}.</b> {vs(rev?.err)}</p>
        <div className="banner-act"><a className="btn" href={href('changes')}>See what changed</a></div></div>}

      <div className="cards">
        <article className="acard" aria-labelledby="q1">
          <h2 id="q1">Is it cheap?</h2>
          {noValue ? <p className="serif">No value yet.</p> : <>
            <p className="serif">{price == null ? 'There’s no share price to compare with.' : <><Verdict price={price} values={values} /> Our central value is{' '}
              <span className="num ours">Rs {rs(values.base!)}</span> against a price of <span className="num mkt">Rs {rs(price)}</span>.</>}</p>
            <Scale price={price} bear={values.bear} base={values.base} bull={values.bull} />
            <p className="small dim">The ochre line is today’s price; the blue band is our cautious to hopeful values.</p>
          </>}
          <a className="go" href={href('value')}>See Is it cheap?</a>
        </article>

        <article className="acard" aria-labelledby="q2">
          <h2 id="q2">What does the price assume?</h2>
          {noValue || price == null ? <p className="serif">No value yet, so nothing to work backwards from.</p>
            : implied == null ? <p className="serif">No steady sales growth between −30% and +80% a year gets our value to the price.</p>
            : <>
              <p className="serif">{implied < 0 ? `Sales shrinking ${pc(-implied)}` : `Sales growth of ${pc(implied)}`} a year for {WORDS[doc.n] ?? doc.n} years.
                {best5 && <> The best five years on record were {pc(best5.value)} ({best5.from}–{best5.to.slice(-2)}).</>}</p>
              <Bars rows={[['Price needs', implied, 'mkt'], ...(best5 ? [['Best 5 years', best5.value, 'ink'] as const] : []), ...(l3 != null ? [['Last 3 years', l3, 'ink'] as const] : [])]} />
            </>}
          <a className="go" href={href('priced-in')}>See What does the price assume?</a>
        </article>

        <article className="acard" aria-labelledby="q3">
          <h2 id="q3">What could go wrong?</h2>
          <p className="serif">{riskWords(parsed.forensic)}</p>
          <Meter c={c} />
          <a className="go" href={href('risks')}>See the warning signs</a>
        </article>

        <article className="acard" aria-labelledby="q4">
          <h2 id="q4">What changed?</h2>
          {fresh ? <p className="serif">New results: {s!.year.year}. {vs(rev?.err)}</p>
            : <p className="serif">No new results since you built this{since ? ` on ${when(since).replace(/ \d{4}$/, '')}` : ''}.
              {' '}The latest filed {lastQ ? `quarter is ${month(lastQ)}` : `year is ${years[years.length - 1]}`}.</p>}
          {!fresh && <div className="acard-act">{check}</div>}
          {checkMsg && <p className="small" role="status">{checkMsg}</p>}
          <a className="go" href={href('changes')}>See What changed?</a>
        </article>

        <article className="acard wide" aria-labelledby="q5">
          <h2 id="q5">How does it compare?</h2>
          <p className="serif">{!peers?.approved_at ? 'No peers picked yet.' : !read || !projection?.peers ? 'Peers picked; their numbers haven’t been read yet.'
            : peerWords(projection.peers, read, name)}</p>
          <a className="go" href={href('peers')}>{peers?.approved_at ? 'See the peer table' : 'Pick peers'}</a>
        </article>
      </div>
      <TryIt doc={doc} setDoc={setDoc} projection={projection} />

      <section className="note-x" aria-labelledby="nx-h">
        <h2 id="nx-h">Research note <span className="ai-tag">AI wrote this · rules checked every number</span></h2>
        {tn ? <>
          <p className="small dim">Written {when(tn.written_at)} from the numbers on these pages.</p>
          <ol className="nx-points">{tn.thesis.map((p, i) => <li key={i} className="serif"><b>{p.head}</b></li>)}</ol>
          <a className="btn" href={href('note')}>Read the full note</a>
        </> : ai && !ai.available ? <>
          <p className="serif">AI writing is off. Everything else here is computed by rules.</p>
          <a href={href('documents', 'ai')}>How to turn it on</a>
        </> : <>
          <p className="serif">Not written yet. AI reads the numbers on these pages and writes three points; rules check every number before it’s saved.</p>
          <p><button type="button" className="btn" onClick={w.write} disabled={w.busy || !ai}>{w.busy ? 'Writing the note · about a minute…' : 'Write the note (about a minute)'}</button></p>
          {w.fail && <p className="error" role="alert">{w.fail.text}{w.fail.checks?.length ? ` ${w.fail.checks.map(x => x.detail).join(' ')}` : ''} Nothing was saved.{' '}
            <button type="button" className="link" onClick={w.write}>Try again</button></p>}
        </>}
      </section>

      <p className="src-line-s small">From {yearSources(company, years).map(([l, y]) => `${l} ${y}`).join(' and ')}
        {company.source?.symbol ? ` · price ${ago(company.source.price_at)}` : ''} · <a href={href('documents', 'sources')}>Details</a></p>

      <Next lead={doc.reviewed_at ? <>Reviewed {when(doc.reviewed_at).replace(/ \d{4}$/, '')}.</>
        : <>Before you rely on this: read What could go wrong? and the note, then mark it as reviewed.</>}>
        <button type="button" className={doc.reviewed_at || fix ? 'btn' : 'primary'} onClick={onReview}>{doc.reviewed_at ? 'Mark as draft' : 'Mark as reviewed'}</button>
      </Next>
    </>
  )
}

/** Horizontal bars on one scale, the figure written beside each (a negative one says so in its sign and its words). */
function Bars({ rows }: { rows: readonly (readonly [string, number, 'mkt' | 'ink'])[] }) {
  const max = Math.max(...rows.map(r => Math.abs(r[1])), 1e-9)
  return (
    <dl className="hbars">{rows.map(([k, x, tone]) => <div key={k}>
      <dt>{k}</dt>
      <dd><span className={`hb ${tone}${x < 0 ? ' neg' : ''}`} style={{ width: `${(Math.abs(x) / max) * 100}%` }} /><span className="num">{x < 0 ? `shrinks ${pc(-x)}` : pc(x)}</span></dd>
    </div>)}</dl>
  )
}

/** Five boxes: how many checks at each severity; the colour only repeats the word. */
export function Meter({ c }: { c: Record<Severity, number> }) {
  return (
    <ul className="meter" aria-label="Checks by severity">
      {(['high', 'medium', 'low', 'ok', 'not_checked'] as Severity[]).map(s => (
        <li key={s} className={`m-${s}${c[s] && s !== 'ok' && s !== 'not_checked' ? ' on' : ''}`}><b className="num">{c[s]}</b><span>{SEV_WORD[s].toLowerCase()}</span></li>))}
    </ul>
  )
}

/** Try it: the two inputs that move the value most, as one live sentence on the case you're looking at. The same
 * setter as Our forecast's rows, so both always agree. A gradual path is edited in the forecast instead. */
function TryIt({ doc, setDoc, projection }: { doc: ModelDoc; setDoc: Props['setDoc']; projection: Projection | null }) {
  const href = useHref()
  const a = doc.scenarios[doc.active], src = doc.assumption_sources[doc.active] ?? {}
  const value = projection?.scenarios[doc.active].length === doc.n ? projection.valuation.scenarios[doc.active].per_share : null
  const set = (k: string) => (x: number) => setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [d.active]: { ...d.scenarios[d.active], [k]: { start: x, end: null } } } }))
  const box = (k: 'growth' | 'ebitda_margin', label: string) => a[k]?.end != null
    ? <span className="small">changes year by year · <a href={href('forecast', k)}>edit in the forecast</a></span>
    : <Stepper id={`try-${k}`} label={label} kind="pct" value={a[k]?.start ?? 0} onChange={set(k)} you={!!src[k] && src[k] !== 'history'} />
  return (
    <section className="try" aria-labelledby="try-h">
      <h2 id="try-h">Try it <span className="cnt">{NAMES[doc.active].toLowerCase()} case</span></h2>
      <p className="answer s">If sales grow {box('growth', 'Sales growth a year')} a year and the operating margin stays at {box('ebitda_margin', 'Operating margin')},
        one share is worth <b className="num ours">{value != null ? `Rs ${rs(value)}` : 'nothing yet'}</b>.</p>
      <p className="small muted">These are the same inputs as in <a href={href('forecast')}>Our forecast</a>; changing them here changes them there.</p>
    </section>
  )
}
