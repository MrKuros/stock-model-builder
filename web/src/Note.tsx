import { useEffect, useRef, useState, type ReactNode } from 'react'
import Ruler from './Ruler'
import { bySeverity } from './Risks'
import { FlagNoteView, useAi } from './Sources'
import { cagrOf } from './Fundamentals'
import { Next, PageHead, Sev } from './Shell'
import { useHref } from './route'
import { T, type TermKey } from './Term'
import {
  api, clock, fmt, fy, gap, money, postJson, properName, rs, verdict, when, type Cagr, type ModelDoc, type NoteRef, type OneOffNote, type Parsed,
  type Path, type Projection, type RuleCheck, type Row, type ScenarioValue, type ThesisNote, type Valuation,
} from './lib'

/** Average of a straight-line path over the projection: what "ours" means for a faded driver. */
export const avg = (p: Path | undefined) => (p ? (p.start + (p.end ?? p.start)) / 2 : 0)
export const shortName = (n: string) => properName(n).replace(/\s+(ltd\.?|limited)$/i, '').trim()
const pc = (v: number) => fmt(v, 'pct')

/** A cited number: a button with a dotted underline; it opens its source beside the claim (under the paragraph on a
 * phone) without moving the page. Esc or a click elsewhere closes it and focus goes back to the number. */
function Cite({ n, src, to, children, uid }: { n: number; src: string; to?: string; children: ReactNode; uid: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const id = `cite-${n}-${uid}`
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus() } }
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', down)
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', down) }
  }, [open])
  return (
    <span className="cite" ref={box}>
      <button ref={btn} type="button" className="cite-b num" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(o => !o)}>{children}<sup aria-hidden="true">{n}</sup><span className="sr"> (source {n})</span></button>
      {open && <span className="cite-pop" id={id} role="note"><b className="num">{children}</b>: {src}
        {to && <> <a href={to}>Open it</a></>}</span>}
    </span>
  )
}

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null
}

const refKey = (r: NoteRef) => (typeof r === 'string' ? r : JSON.stringify(r))
/** What a ref stands for, as the note was written: the fact's text, or the file, page and quote. */
function refSource(tn: ThesisNote, r: NoteRef) {
  if (typeof r !== 'string') return { file: true, text: `${r.file}, p.${r.page}`, quote: r.quote, page: r.page }
  if (tn.facts[r] != null) return { file: false, text: tn.facts[r], quote: undefined, page: 0 }
  const c = tn.cites[r]
  return c ? { file: true, text: `${c.file}, p.${c.page}. ${c.what}`, quote: c.quote, page: c.page } : null
}

const nums = (t: string) => (t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(x => x.replace(/,/g, ''))

/** AI prose with every number in mono; a number its refs back gets a footnote and its source on hover or focus.
 * ponytail: a number is tied to the first ref whose text has the same number as written; a rounded one gets no
 * footnote. The rules already checked every number against the facts and quotes; this only picks the footnote */
export function Prose({ text, refs, tn, refN, uid, refTo }: { text: string; refs: NoteRef[]; tn: ThesisNote; refN: Map<string, number>; uid: string; refTo?: Map<string, string> }) {
  const parts = text.split(/((?<![\w.])\d[\d,]*(?:\.\d+)?(?:%|x\b)?)/)
  return <>{parts.map((p, i) => {
    if (i % 2 === 0 || /^(19|20)\d\d$/.test(p)) return p
    const digits = p.replace(/[,%x]/g, '')
    if (/^\d+$/.test(digits) && +digits <= 12) return <span key={i} className="num">{p}</span> // a count ("5 years", "1 pp")
    const r = refs.find(r => { const s = refSource(tn, r); return s && nums(`${s.text} ${s.quote ?? ''}`).includes(digits) })
    const n = r && refN.get(refKey(r))
    const s = r && refSource(tn, r)
    return n && s ? <Cite key={i} n={n} uid={`${uid}-${i}`} to={refTo?.get(refKey(r!))} src={s.quote ? `from ${s.text}: “${s.quote}”` : `computed by rules. ${s.text}`}>{p}</Cite>
      : <span key={i} className="num">{p}</span>
  })}</>
}

/** The company in a sentence: its short name when that's short, else its NSE symbol ("TCS", "Coal India"). */
export const subjectOf = (c: { name: string; source?: { symbol?: string | null } | null }) =>
  shortName(c.name).length <= 22 ? shortName(c.name) : c.source?.symbol ?? 'the company'
/** Growth in words, never a signed rate: "grow 13.5%", "shrink 5.6%". */
export const grow = (x: number) => (x < 0 ? `shrink ${pc(-x)}` : `grow ${pc(x)}`)
export const grew = (x: number) => (x < 0 ? `shrank ${pc(-x)}` : `grew ${pc(x)}`)
/** Revenue growth a year over the last three reported years (null when either end isn't positive). */
export const last3Of = (parsed: Parsed) => cagrOf((parsed.hist ?? parsed.company.hist).map(h => h.revenue ?? null), 3)

/** The last-year capex or EBITDA margin that stops a cash burn ("capex ≤ 10.0% of sales"). */
export const burnFix = (f: NonNullable<ScenarioValue['fix']>) => [f.capex_pct != null ? `capex ≤ ${pc(f.capex_pct)} of sales` : '',
  f.ebitda_margin != null ? `EBITDA margin ≥ ${pc(f.ebitda_margin)}` : ''].filter(Boolean).join(' or ')

/** Base-case revenue CAGR over the forecast, from the projected rows (last reported year to the last forecast year). */
export function baseCagr(parsed: Parsed, projection: Projection | null): number | null {
  const rows = projection?.scenarios.base, hist = parsed.hist ?? parsed.company.hist
  const a = hist[hist.length - 1]?.revenue, b = rows?.[rows.length - 1]?.revenue
  return rows?.length && a && b && a > 0 && b > 0 ? (b / a) ** (1 / rows.length) - 1 : null
}

export interface Fix { page: 'forecast' | 'valuation'; anchor: string; label: string }
/** The base case's answer line, by rules: CMP against bear/base/bull fair value, then the reverse DCF's implied
 * revenue CAGR against the base case and the last three years. Summary and the research note both open with it. */
export function verdictWords(parsed: Parsed, projection: Projection | null): { answer: ReactNode; fix: Fix | null } {
  const v = projection?.valuation ?? null
  if (!v) return { answer: <>Running the DCF…</>, fix: null }
  const sv = v.scenarios.base, value = sv.per_share, price = v.price
  const bear = v.scenarios.bear.per_share, bull = v.scenarios.bull.per_share
  const yrs = projection!.years.map(fy), end = yrs[yrs.length - 1]
  if (sv.fix) return {
    answer: <>No fair value: {end} FCFF is negative, so the terminal value is undefined.{burnFix(sv.fix) ? <> {end} {burnFix(sv.fix)} turns it positive.</> : null}</>,
    fix: { page: 'forecast', anchor: 'capex_pct', label: 'Fix the forecast' } }
  if (value == null || value <= 0) {
    if (!v.error && v.shares == null) return { answer: <>No fair value: share count missing.</>,
      fix: { page: 'valuation', anchor: 'v-shares', label: 'Enter shares outstanding' } }
    return { answer: <>No fair value: {(v.error ?? sv.error ?? 'the inputs gave an error.').replace(/^./, c => c.toLowerCase())}</>,
      fix: v.error ? { page: 'valuation', anchor: 'how', label: 'Open DCF inputs' } : { page: 'forecast', anchor: 'capex_pct', label: 'Fix the forecast' } }
  }
  const V = (x: number) => <span className="num ours">Rs {rs(x)}</span>
  if (price == null) return { answer: <>Base-case fair value {V(value)}/share; no CMP in this file.</>,
    fix: { page: 'valuation', anchor: 'v-price', label: 'Enter CMP' } }
  const P = <span className="num mkt">Rs {rs(price)}</span>
  const pe = sv.multiples?.price_next.pe
  const at = <><T k="cmp" /> {P}{pe != null ? <> ({pe.toFixed(1)}x {yrs[0]} <T k="pe" />)</> : null}</>
  const k = verdict(price, { bear, base: value, bull }).kind
  const g = gap(price, value)
  const first = k === 'dear' ? <>{at} is above bull-case fair value of {V(bull!)}; {g} to base-case {V(value)}.</>
    : k === 'cheap' ? <>{at} is below bear-case fair value of {V(bear!)}; {g} to base-case {V(value)}.</>
    : k === 'fix' ? <>{at}: {g} to base-case fair value of {V(value)}; {bear == null || bear <= 0 ? 'bear' : 'bull'}-case FV is n/a, so no full range.</>
    : <>{at} is within the bear–bull fair-value range ({V(bear!)}–{V(bull!)}); {g} to base-case {V(value)}.</>
  const implied = sv.implied_growth ?? null, l3 = last3Of(parsed), ours = baseCagr(parsed, projection)
  const vs = [ours != null ? <>{pc(ours)} in our base case</> : null, l3 != null ? <>{pc(l3)} over the last 3 years</> : null].filter(Boolean)
  const second = implied == null ? <>No flat revenue growth between −30% and +80% reconciles base-case FV to CMP.</>
    : <>Market-implied revenue CAGR {pc(implied)}{vs.length ? <> vs {vs[0]}{vs[1] ? <> and {vs[1]}</> : null}</> : null}.</>
  return { answer: <>{first} {second}</>, fix: null }
}

/** The ruler: CMP against the fair-value range, and the revenue growth each value implies. */
export function RulerSection({ parsed, doc, projection }: { parsed: Parsed; doc: ModelDoc; projection: Projection | null }) {
  const href = useHref()
  const v = projection?.valuation, sv = v?.scenarios.base, value = sv?.per_share
  if (!v || value == null) return null
  const base = doc.scenarios.base
  const best = (cs: Cagr[] = []) => (cs.length ? cs.reduce((a, b) => (b.value > a.value ? b : a)) : null)
  return (
    <section className="instrument" aria-labelledby="ruler-h">
      <header>
        <h2 id="ruler-h" className="label">CMP vs fair value · <b>Rs/share</b>, and the implied revenue growth</h2>
        <a className="go" href={href('valuation')}>Valuation</a>
      </header>
      <p className="small-note">Top: fair value per share. Bottom: the flat revenue growth that gives each value. Hatched: above the best
        5-year CAGR on record.</p>
      <Ruler price={v.price} bear={v.scenarios.bear.per_share} base={value} bull={v.scenarios.bull.per_share} scale={v.note?.growth_scale ?? null}
        ours={avg(base.growth)} implied={sv!.implied_growth ?? null} best5={best(parsed.cagrs?.['5'])} since={parsed.years[0]} />
      <details className="fold"><summary>Method</summary>
        <p className="small">Lower scale: base-case fair value at a flat revenue growth from −10% to +40%, other inputs at base
          (EBITDA margin {pc(avg(base.ebitda_margin))}, <T k="wacc" /> {pc(v.wacc)}, terminal growth {pc(v.g)}). Implied growth is
          solved between −30% and +80% until base-case fair value equals CMP.</p></details>
    </section>
  )
}

/** Writing the note: the LLM only when you press the button, from the computed facts and approved quotes; rules
 * check every number, reference, quote and word before it is saved. */
export function useWrite(doc: ModelDoc, setDoc: (f: (d: ModelDoc) => ModelDoc) => void) {
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<{ text: string; checks?: ThesisNote['checks'] } | null>(null)
  const [done, setDone] = useState(false)
  const write = async () => {
    setBusy(true); setFail(null); setDone(false)
    try {
      const r = await api<ThesisNote>('/api/note/write', postJson(doc))
      if (r.status === 'written') { setDoc(d => ({ ...d, note: r, reviewed_at: null })); setDone(true) } // new words: back to draft
      else setFail({ text: 'The draft was rejected by the rule checks twice, so nothing was saved.', checks: r.checks.filter(c => c.pass === false) })
    } catch (e) { setFail({ text: (e as Error).message }) } finally { setBusy(false) }
  }
  return { busy, fail, done, write }
}

const refsOf = (tn: ThesisNote) => [...tn.thesis.flatMap(p => p.refs), ...tn.risks.flatMap(p => p.refs)]

/** Research note: the rules' verdict, then the AI's three points, priced in, risks and what to watch, and the key
 * numbers. Every cited number has a footnote; the sources are folded at the foot. */
export default function NotePage({ parsed, doc, setDoc, projection }: Props) {
  const href = useHref()
  const ai = useAi()
  const tn = doc.note
  const stale = !!tn && projection?.inputs_hash != null && projection.inputs_hash !== tn.inputs_hash
  // each fact opens the page that shows its number: forecast lines on the statements, history on Financials,
  // implied growth and break-evens on Reverse DCF; fair value, upside and WACC on Valuation
  const factTo = (k: string) => (k.startsWith('flag_') ? href('risks', k.slice(5)) : k.startsWith('in_') ? href('forecast', k.slice(3))
    : k.startsWith('oneoff_') ? href('risks', 'unusual')
    : /^(implied|be_|price|gap|over_|under_)/.test(k) ? href('reverse-dcf')
    : /_next$/.test(k) ? href('statements', k.replace(/_next$/, ''))
    : k === 'growth' || k === 'margin' ? href('forecast', k === 'margin' ? 'ebitda_margin' : 'growth')
    : /_last$|^kn_|^range_|^cash_jump|^best|^last\d|^shares|^moved_out|^lev_/.test(k) ? href('financials')
    : href('valuation'))
  const notes: { kind: string; text: ReactNode; quote?: string; to?: string }[] = []
  const refN = new Map<string, number>(), refTo = new Map<string, string>()
  if (tn) for (const r of refsOf(tn)) {
    const k = refKey(r), s = refSource(tn, r)
    if (refN.has(k) || !s) continue
    const to = s.file ? href('documents', 'reading') : factTo(k)
    notes.push({ kind: s.file ? `File p.${s.page}` : 'Computed', text: s.text, quote: s.quote, to })
    refN.set(k, notes.length)
    refTo.set(k, to)
  }
  const P = (text: string, refs: NoteRef[], uid: string) => (tn ? <Prose text={text} refs={refs} tn={tn} refN={refN} refTo={refTo} uid={uid} /> : null)
  const { answer } = verdictWords(parsed, projection)
  return (
    <>
      <PageHead label="Model · Research note" title="Research note"
        purpose="Thesis, priced-in view, risks and monitorables, drafted by AI from this model’s outputs. Every number is checked against the model before saving; the note changes no number."
        answer={answer} />
      {ai && !ai.available && <p className="notice-in">AI drafting is off. The valuation line, risks and key metrics below are computed by rules.{' '}
        <a href={href('documents', 'ai')}>How to turn it on</a></p>}
      <div className="ov-cols">
        <div className="col">
          <Thesis doc={doc} setDoc={setDoc} tn={tn} stale={stale} P={P} refN={refN} />
          <Risks parsed={parsed} doc={doc} tn={tn} P={P} />
        </div>
        <div className="col">
          <KeyNumbers parsed={parsed} proj={projection?.scenarios.base[0] ?? null} next={projection?.years[0]} checks={parsed.rule_checks ?? []} v={projection?.valuation ?? null} />
        </div>
      </div>
      {notes.length > 0 && <details className="fold notes">
        <summary>All sources ({notes.length})</summary>
        <ol>{notes.map((n, i) => (
          <li key={i} id={`fn-${i + 1}`} tabIndex={-1}>
            <span className={`kind ${n.kind === 'Computed' ? 'rule' : 'file'}`}>{n.kind}</span>{n.text}
            {n.quote && <q className="quote">{n.quote}</q>}{n.to && <> <a href={n.to}>Open</a></>}
          </li>))}</ol>
      </details>}
      <p className="small-note">Analysis, not a recommendation; no price target.</p>
      <Next lead="Note and risks read? Mark the model reviewed on the Summary."><a className="btn" href={href('summary')}>Mark as reviewed</a></Next>
    </>
  )
}


/** The forensic flags, highest severity first, one sentence each with any approved explanation (AI-written, cited);
 * then the outlier years and data issues. Each line opens its evidence. */
function Risks({ parsed, doc, tn, P }: { parsed: Parsed; doc: ModelDoc; tn: ThesisNote | null; P: Pr }) {
  const href = useHref()
  const recent = parsed.years.slice(-3)
  const oneoffs = parsed.oneoffs.filter(o => recent.includes(o.year))
  const issues = parsed.checks
  const radar = parsed.forensic ?? []
  const lit = bySeverity(radar).filter(f => f.severity === 'high' || f.severity === 'medium' || f.severity === 'low')
  const waiting = radar.filter(f => f.needs && f.severity === 'not_checked')
  return (
    <section className="sec" aria-labelledby="risks-h">
      <h2 id="risks-h" className="label sec-label"><span>Risks · <b>forensic red flags by rules, then the AI’s wording</b></span><span>by severity</span></h2>
      {!lit.length && !oneoffs.length && !issues.length && <p className="small-note">No forensic flags, outlier years or data issues in the last three reported years.</p>}
      <ul className="risks">
        {lit.map(f => {
          const n = doc.flag_notes.find(x => x.key === f.key)
          return (
            <li key={f.key}>
              <p><Sev level={f.severity} /> {fy(f.detail)}</p>
              {n && <FlagNoteView note={n} />}
              <a className="small" href={href('risks', f.key)}
                aria-label={`${f.title}: ${n ? 'see it in Risks & forensics' : 'explain it in Risks & forensics'}`}>{n ? 'See it' : 'Explain it'}</a>
            </li>
          )
        })}
        {oneoffs.map(o => {
          const n = doc.notes[`oneoff:${o.year}`] as OneOffNote | undefined
          return (
            <li key={`${o.year}-${o.metric}`}>
              <p><span className="sev year">Outlier year</span> {fy(o.note)}.</p>
              {n && <div className="ai-note">
                <span className="who">AI-written · {n.from_numbers ? 'from the numbers only' : 'cited'}</span>
                <p className="serif">{n.summary}</p>
                {n.quote && <p className="src-line"><span className="kind file">File</span>{n.file}, p.{n.page}: <q>{n.quote}</q></p>}
              </div>}
              {!n && <a className="small" href={href('risks', 'unusual')}
                aria-label={`Explain ${o.year} from the annual report`}>Explain it from the annual report</a>}
            </li>
          )
        })}
        {issues.length > 0 && <li><p>{issues.length} data issue{issues.length > 1 ? 's' : ''} in the reported financials, e.g. {issues[0]}.</p>
          <a className="small" href={href('documents', 'data')}>See them all</a></li>}
      </ul>
      {tn && <div className="ai-note">
        <span className="who">AI-written · checked against the model</span>
        <ul className="ai-risks">{tn.risks.map((r, i) => <li key={i} className="serif">{P(r.text, r.refs, `r${i}`)}</li>)}</ul>
      </div>}
      {waiting.length > 0 && <p className="small-note">Not tested: {waiting.map(f => f.title).join(', ')}.{' '}
        <a href={href('risks', 'waiting')}>Inputs needed</a></p>}
    </section>
  )
}

/** Last reported year against the 3-year median (rules), then the first forecast year in blue. */
function KeyNumbers({ parsed, proj, next, checks, v }: {
  parsed: Parsed; proj: Row | null; next?: string; checks: RuleCheck[]; v: Valuation | null
}) {
  const href = useHref()
  const keys = parsed.key_numbers ?? []
  if (!keys.length) return null
  const hist = parsed.hist ?? parsed.company.hist, lastH = hist[hist.length - 1]
  const p = proj
  const nextOf: Record<string, number | null> = p ? {
    growth: lastH.revenue ? (p.revenue ?? 0) / lastH.revenue - 1 : null,
    ebitda_margin: p.revenue ? (p.ebitda ?? 0) / p.revenue : null,
    pat_growth: lastH.pat && lastH.pat > 0 ? (p.pat ?? 0) / lastH.pat - 1 : null,
    roce: p.roce ?? null,
    cash_conversion: p.pat && p.pat > 0 ? (p.cfo ?? 0) / p.pat : null,
    dso: p.revenue ? (p.receivables ?? 0) * 365 / p.revenue : null,
  } : {}
  const year = keys[0].year
  const flagged = (k: string) => {
    const id = k === 'dso' ? 'dso' : k === 'cash_conversion' ? 'cash' : k === 'ebitda_margin' ? `oneoff-ebitda_margin-${year}` : ''
    const c = checks.find(c => c.id === id)
    return c && (c.status === 'red' || c.status === 'amber') ? c : null
  }
  const show = (x: number | null, kind: string) => (x == null ? '–' : kind === 'x' ? `${x.toFixed(2)}x` : kind === 'days' ? `${Math.round(x)}` : fmt(x, 'pct'))
  // each measure opens where it is set (an input) or where it is reported (a statement row)
  const TO: Record<string, string> = { growth: href('forecast', 'growth'), ebitda_margin: href('forecast', 'ebitda_margin'), dso: href('forecast', 'dso'),
    pat_growth: href('statements', 'pat'), roce: href('statements', 'roce', 'ratios'), cash_conversion: href('statements', 'cfo', 'cash-flow') }
  const pe = v?.scenarios.base.multiples
  return (
    <section className="sec" aria-labelledby="keys-h">
      <h2 id="keys-h" className="label sec-label"><span>Key metrics</span></h2>
      <table className="keys">
        <thead><tr><th scope="col"><span className="sr">Metric</span></th><th scope="col">{fy(year)}</th><th scope="col">3-yr median</th>
          {p && next && <th scope="col" className="ours">{fy(next)}</th>}</tr></thead>
        <tbody>
          {keys.map(k => {
            const f = flagged(k.key)
            return (
              <tr key={k.key}>
                <th scope="row">{KT[k.key]
                  // the definition on its own term (hover, focus, tap) and the line behind it as a separate link: never one inside the other
                  ? <><T k={KT[k.key]}>{k.label}</T> <a className="quiet go-line" href={TO[k.key] ?? href('statements')} aria-label={`${k.label}: open the line`}>→</a></>
                  : <a className="quiet" href={TO[k.key] ?? href('statements')}>{k.label}</a>}</th>
                <td className="num">{f ? <span className="pen">{show(k.last, k.kind)}<svg aria-hidden="true" viewBox="0 0 100 40" preserveAspectRatio="none"><ellipse cx="50" cy="20" rx="47" ry="16" /></svg><span className="sr"> (flagged: {f.fact})</span></span> : show(k.last, k.kind)}</td>
                <td className="num dim">{show(k.typical, k.kind)}</td>
                {p && <td className="num ours">{show(nextOf[k.key] ?? null, k.kind)}</td>}
              </tr>
            )
          })}
          {pe && pe.price_last.pe != null && <tr><th scope="row"><a className="quiet" href={href('valuation', 'yardsticks')}>P/E at CMP</a></th>
            <td className="num">{fmt(pe.price_last.pe, 'x')}</td><td className="num dim">{fmt(v?.multiples?.median.pe, 'x')}</td>
            {p && <td className="num ours">{fmt(pe.price_next.pe, 'x')}</td>}</tr>}
        </tbody>
      </table>
      <p className="small-note">Black: reported. Grey: median of the prior three years{v?.multiples?.median.pe != null ? ' (P/E: all years)' : ''}. Blue: base-case forecast. Circled: a rule check flagged it.</p>
    </section>
  )
}

/** Key metrics whose label is a glossary term (definition on hover, focus and tap), with the link to its line beside it. */
const KT: Record<string, TermKey> = { roce: 'roce', cash_conversion: 'cfo_pat', ebitda_margin: 'ebitda_margin', dso: 'dso', growth: 'growth' }

type Pr = (text: string, refs: NoteRef[], uid: string) => ReactNode

/** The note's words: written by the LLM only when you press the button, from the facts on this page and the approved
 * quotes; rules check every number, reference, quote and word before it is saved. Never written on load. */
function Thesis({ doc, setDoc, tn, stale, P, refN }: {
  doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; tn: ThesisNote | null; stale: boolean; P: Pr; refN: Map<string, number>
}) {
  const ai = useAi()
  const href = useHref()
  const { busy, fail, done, write } = useWrite(doc, setDoc)
  const head = useRef<HTMLHeadingElement>(null)
  // the "Write the note" button unmounts: put focus on the heading, unless you moved on during the wait
  useEffect(() => {
    if (!done) return
    const a = document.activeElement
    if (!a || a === document.body || head.current?.closest('section')?.contains(a)) head.current?.focus()
  }, [done])
  const off = !ai?.available
  const button = (label: string) => (
    <div className="write">
      <button type="button" className="btn" onClick={write} disabled={busy || off} aria-describedby="thesis-why">{busy ? 'Writing the note…' : `${label} (about a minute)`}</button>
      <span id="thesis-why" className="small-note">{off ? (ai ? 'AI off' : 'Checking whether AI is on…')
        : 'About a minute. Sends only computed facts and approved quotes; every number is checked before saving.'}</span>
    </div>
  )
  const nCites = tn ? Object.keys(tn.cites).length : 0
  const rec = doc.track?.[doc.track.length - 1]
  const after = tn && rec && rec.recorded_at > tn.written_at ? rec : null // new results since the note was written (5.3)
  return (
    <section className="sec thesis" aria-labelledby="thesis-h">
      <h2 id="thesis-h" ref={head} tabIndex={-1} className="label sec-label"><span>Investment thesis</span>
        <span className={`ai-tag${stale ? ' stale' : ''}`}>{!tn ? 'Not written yet' : `AI-drafted · numbers rule-checked · ${when(tn.written_at)} ${clock(tn.written_at).slice(-5)}`}</span></h2>
      <div aria-live="polite">
        {busy && <p className="small-note">Writing the note · about a minute · you can leave this page.</p>}
        {done && !busy && <p className="sr">Note written and checked against the model.</p>}
        {fail && <div className="fail" role="alert"><p>{fail.text} Nothing was saved. <button type="button" className="link" onClick={write} disabled={off}>Try again</button></p>
          {fail.checks?.length ? <ul>{fail.checks.map(c => <li key={c.name}><strong>{c.name}:</strong> {c.detail}</li>)}</ul> : null}</div>}
      </div>
      {!tn && <div className="empty">
        <p>No note yet. AI drafts a three-point thesis, risks and monitorables from this model’s outputs; every number is checked
          before saving. Everything else on this page is computed by rules.</p>
        {button('Write the note')}
      </div>}
      {tn && <>
        {stale && <p className="stale-note">{after
          ? <>Written before the {after.new_years.join(', ')} results ({when(tn.written_at)}); some numbers below may be stale.
            Rewrite with the new results.</>
          : <>Written for earlier inputs: the model changed after {when(tn.written_at)}, so some numbers below may be stale.
            Rewrite to update.</>}</p>}
        <p className="headline">{P(tn.headline, [], 'h')}</p>
        {tn.thesis.map((p, i) => {
          const rows = p.refs.map(r => ({ r, s: refSource(tn, r) }))
          const missing = rows.filter(x => !x.s).length
          return (
            <article className="claim" key={i}>
              <h3>{p.head}</h3>
              <p>{P(p.text, p.refs, `t${i}`)}</p>
              <details className="src">
                <summary>{rows.length - missing} source{rows.length - missing === 1 ? '' : 's'}</summary>
                <ol>{rows.map(({ r, s }) => s && (
                  <li key={refKey(r)}><span className={`kind ${s.file ? 'file' : 'rule'}`}>{s.file ? 'File' : 'Rule'}</span>{s.text}
                    {s.quote && <> <q className="quote">{s.quote}</q></>}
                    {refN.has(refKey(r)) && <span className="small-note"> (note {refN.get(refKey(r))})</span>}</li>))}</ol>
              </details>
            </article>
          )
        })}
        <h3 className="label sub">Priced in <a className="go" href={href('reverse-dcf')}>Reverse DCF</a></h3>
        <p className="serif prose">{P(tn.priced_in, [], 'p')}</p>
        <h3 className="label sub">Monitorables</h3>
        <ul className="watch">{tn.what_to_watch.map((w, i) => <li key={i} className="serif">{P(w, [], `w${i}`)}</li>)}</ul>
        <p className="small-note">AI-drafted {when(tn.written_at)} from this page’s facts{nCites ? ` and ${nCites} approved quote${nCites > 1 ? 's' : ''}` : ''};
          every number matches a computed figure or a cited quote{tn.rounds > 1 ? ' (passed on retry)' : ''}. Analysis, not a recommendation.</p>
        {button(after ? 'Rewrite the note with the new results' : 'Rewrite')}
      </>}
    </section>
  )
}

/** Base-case fair value per share, built up: explicit-period FCFF, TV, net cash/(debt), minorities; the gap to CMP. */
export function Bridge({ v, value, price, years }: { v: Valuation; value: number; price: number | null; years: string[] }) {
  const sv = v.scenarios.base
  if (v.shares == null || sv.pv_sum == null) return null
  const b = (x: number) => (Math.abs(value) >= 100 ? money(x) : rs(x))
  return (
    <section className="sec" aria-labelledby="bridge-h" id="a-bridge" tabIndex={-1}>
      <h3 id="bridge-h" className="label sec-label"><span>Base-case FV bridge · <b>Rs/share</b></span></h3>
      <table className="keys">
        <tbody>
          <tr><th scope="row">PV of FCFF {fy(years[0])}–{years[years.length - 1].slice(-3)}</th><td className="num">{b(sv.pv_sum / v.shares)}</td></tr>
          <tr><th scope="row">PV of terminal value</th><td className="num">{b(sv.pv_tv! / v.shares)}</td></tr>
          <tr><th scope="row">{v.cash + v.investments - v.borrowings >= 0 ? 'Add: net cash' : 'Less: net debt'}</th><td className="num">{b((v.cash + v.investments - v.borrowings) / v.shares)}</td></tr>
          {(sv.minority ?? 0) > 0 && <tr><th scope="row">Less: minority interest</th><td className="num">{b(-sv.minority! / v.shares)}</td></tr>}
          <tr className="tot"><th scope="row">Base-case fair value</th><td className="num ours">{b(value)}</td></tr>
          {price != null && <tr><th scope="row">CMP {price >= value ? 'premium' : 'discount'} to FV</th><td className="num mkt">{b(Math.abs(price - value))}</td></tr>}
        </tbody>
      </table>
      {sv.tv_share != null && <p className="small-note">Terminal value is {pc(sv.tv_share)} of EV.</p>}
    </section>
  )
}
