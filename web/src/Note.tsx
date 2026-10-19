import { useEffect, useRef, useState, type ReactNode } from 'react'
import Ruler from './Ruler'
import { bySeverity } from './Risks'
import { FlagNoteView, useAi } from './Sources'
import { cagrOf } from './Fundamentals'
import { Next, PageHead, Sev } from './Shell'
import { useHref } from './route'
import {
  api, fmt, money, postJson, rs, verdict, when, type Cagr, type Impact, type ModelDoc, type NoteRef, type OneOffNote, type Parsed,
  type Path, type Projection, type RuleCheck, type Row, type ThesisNote, type ValInputs, type Valuation,
} from './lib'

/** Average of a straight-line path over the projection: what "ours" means for a faded driver. */
export const avg = (p: Path | undefined) => (p ? (p.start + (p.end ?? p.start)) / 2 : 0)
export const shortName = (n: string) => n.replace(/\s+(ltd\.?|limited)$/i, '').trim()
const pc = (v: number) => fmt(v, 'pct')
const DAYS = new Set(['dso', 'dio', 'dpo'])
const unit = (key: string, v: number) => (DAYS.has(key) ? `${Math.round(v)} days` : pc(v))
const stepText = (key: string, s: number) => (DAYS.has(key) ? `${s} days` : `${+(s * 100).toFixed(1)} pp`)
const NAMES = { growth: 'Revenue growth', ebitda_margin: 'EBITDA margin', wacc: 'Discount rate (WACC)', g: 'Terminal growth' } as const

/** A cited number: dotted underline, a footnote mark that jumps to the Notes list, the source on hover or focus. */
function Cite({ n, src, children, plain, uid }: { n: number; src: string; children: ReactNode; plain?: boolean; uid?: string }) {
  const id = `cite-${n}${uid ? `-${uid}` : ''}`
  return (
    <span className="cite">
      <span className={plain ? undefined : 'num'}>{children}</span>
      <sup><button type="button" className="fnref" aria-describedby={id} title={src}
        onClick={() => {
          const el = document.getElementById(`fn-${n}`)
          const d = el?.closest('details')
          if (d) d.open = true // the sources sit in a disclosure at the foot of the page
          el?.scrollIntoView({ block: 'center' }); el?.focus()
        }}>
        {n}<span className="sr"> (note {n})</span></button></sup>
      <span className="tip" role="tooltip" id={id}>{src}</span>
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
export function Prose({ text, refs, tn, refN, uid }: { text: string; refs: NoteRef[]; tn: ThesisNote; refN: Map<string, number>; uid: string }) {
  const parts = text.split(/((?<![\w.])\d[\d,]*(?:\.\d+)?(?:%|x\b)?)/)
  return <>{parts.map((p, i) => {
    if (i % 2 === 0 || /^(19|20)\d\d$/.test(p)) return p
    const digits = p.replace(/[,%x]/g, '')
    if (/^\d+$/.test(digits) && +digits <= 12) return <span key={i} className="num">{p}</span> // a count ("5 years", "1 pp")
    const r = refs.find(r => { const s = refSource(tn, r); return s && nums(`${s.text} ${s.quote ?? ''}`).includes(digits) })
    const n = r && refN.get(refKey(r))
    const s = r && refSource(tn, r)
    return n && s ? <Cite key={i} n={n} uid={`${uid}-${i}`} src={s.quote ? `${s.text}: “${s.quote}”` : `Computed by rules: ${s.text}`}>{p}</Cite>
      : <span key={i} className="num">{p}</span>
  })}</>
}

/** The company in a sentence: its short name when that's short, else its NSE symbol ("TCS", "Coal India"). */
export const subjectOf = (c: { name: string; source?: { symbol?: string | null } | null }) =>
  shortName(c.name).length <= 22 ? shortName(c.name) : c.source?.symbol ?? 'the company'
/** Growth in words, never a signed rate: "grow 13.5%", "shrink 5.6%". */
export const grow = (x: number) => (x < 0 ? `shrink ${pc(-x)}` : `grow ${pc(x)}`)
const grew = (x: number) => (x < 0 ? `shrank ${pc(-x)}` : `grew ${pc(x)}`)
/** Revenue growth a year over the last three reported years (null when either end isn't positive). */
export const last3Of = (parsed: Parsed) => cagrOf((parsed.hist ?? parsed.company.hist).map(h => h.revenue ?? null), 3)

export interface Fix { page: 'forecast' | 'value'; anchor: string; label: string }
/** The central case's answer in one or two sentences, by rules: where the price sits against our three values and
 * what sales growth the price assumes against the last three years. Summary and the research note both open with it. */
export function verdictWords(parsed: Parsed, projection: Projection | null): { answer: ReactNode; fix: Fix | null } {
  const name = subjectOf(parsed.company)
  const v = projection?.valuation ?? null
  if (!v) return { answer: <>Working out the value…</>, fix: null }
  const sv = v.scenarios.base, value = sv.per_share, price = v.price
  const bear = v.scenarios.bear.per_share, bull = v.scenarios.bull.per_share
  const yrs = projection!.years, end = yrs[yrs.length - 1].replace(/E$/, '')
  if (value == null) {
    if (sv.error?.startsWith('Final-year free cash flow')) return {
      answer: <>We can’t put a value on {name} yet: in {end} it still spends more cash than it makes, so there’s nothing to value.</>,
      fix: { page: 'forecast', anchor: 'capex_pct', label: 'Fix the forecast: capex' } }
    if (!v.error && v.shares == null) return { answer: <>We can’t put a value on {name} yet: there’s no share count.</>,
      fix: { page: 'value', anchor: 'v-shares', label: 'Type the share count' } }
    return { answer: <>We can’t put a value on {name} yet: {(v.error ?? sv.error ?? 'the inputs gave an error.').replace(/^./, c => c.toLowerCase())}</>,
      fix: { page: 'value', anchor: '', label: 'Open How we value it' } }
  }
  if (value <= 0) return {
    answer: <>At these inputs our central value leaves nothing for shareholders (<span className="num ours">Rs {rs(value)}</span> a share):
      the business is worth less than its net debt.</>,
    fix: { page: 'forecast', anchor: 'capex_pct', label: 'Fix the forecast: capex' } }
  if (price == null) return { answer: <>Our central value is <span className="num ours">Rs {rs(value)}</span> a share. There’s no share
    price in this file to compare it with.</>, fix: { page: 'value', anchor: 'v-price', label: 'Type a price' } }
  const P = <span className="num mkt">Rs {rs(price)}</span>
  const k = verdict(price, v.scenarios.bear.per_share != null ? { bear, base: value, bull } : { base: value }).kind
  const first = k === 'dear' ? <>At {P} the market pays more than even our hopeful value.</>
    : k === 'cheap' ? <>At {P} the price is below even our cautious value.</>
    : <>At {P} the price sits inside our range{bear != null && bull != null ? <>, between our cautious <span className="num ours">Rs {rs(bear)}</span> and
      hopeful <span className="num ours">Rs {rs(bull)}</span></> : null}.</>
  const implied = sv.implied_growth ?? null, l3 = last3Of(parsed)
  const second = implied == null ? <>No steady sales growth between −30% and +80% a year gets our central value to the price.</>
    : l3 == null ? <>The price assumes sales {grow(implied)} a year.</>
    : implied > l3 ? <>For the price to be fair, sales would need to {grow(implied)} a year; {name} {l3 < 0 ? 'has shrunk' : 'has managed'} {pc(Math.abs(l3))} a
      year over the last three.</>
    : <>The price assumes sales {grow(implied)} a year; {name} {grew(l3)} a year over the last three.</>
  return { answer: <>{first} {second}</>, fix: null }
}

/** The ruler: price against our range on a value scale, and the yearly sales growth each value needs. */
export function RulerSection({ parsed, doc, projection }: { parsed: Parsed; doc: ModelDoc; projection: Projection | null }) {
  const href = useHref()
  const v = projection?.valuation, sv = v?.scenarios.base, value = sv?.per_share
  if (!v || value == null) return null
  const base = doc.scenarios.base
  const best = (cs: Cagr[] = []) => (cs.length ? cs.reduce((a, b) => (b.value > a.value ? b : a)) : null)
  return (
    <section className="instrument" aria-labelledby="ruler-h">
      <header>
        <h2 id="ruler-h" className="label">Price against value · <b>Rs a share</b>, and the growth each value needs</h2>
        <a className="go" href={href('value')}>How we value it</a>
      </header>
      <p className="small-note">Top: value per share. Bottom: the yearly sales growth each value needs. Hatching: faster than any five
        years on record.</p>
      <Ruler price={v.price} bear={v.scenarios.bear.per_share} base={value} bull={v.scenarios.bull.per_share} scale={v.note?.growth_scale ?? null}
        ours={avg(base.growth)} implied={sv!.implied_growth ?? null} best3={best(parsed.cagrs?.['3'])} best5={best(parsed.cagrs?.['5'])} since={parsed.years[0]} />
      <details className="fold"><summary>How this is computed</summary>
        <p className="small">The lower scale is our central value at a steady sales growth from −10% to +40% a year, other inputs as set
          (operating margin {pc(avg(base.ebitda_margin))}, discount rate {pc(v.wacc)}, long-run growth {pc(v.g)}). The price’s growth is
          searched from −30% to +80% a year until our central value equals the price.</p></details>
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
  const factTo = (k: string) => (k.startsWith('flag_') ? href('risks', k.slice(5)) : k.startsWith('in_') ? href('forecast', k.slice(3))
    : k.startsWith('oneoff_') ? href('risks', 'unusual') : href('value'))
  const notes: { kind: string; text: ReactNode; quote?: string; to?: string }[] = []
  const refN = new Map<string, number>()
  if (tn) for (const r of refsOf(tn)) {
    const k = refKey(r), s = refSource(tn, r)
    if (refN.has(k) || !s) continue
    notes.push({ kind: s.file ? `File p.${s.page}` : 'Computed', text: s.text, quote: s.quote, to: s.file ? href('documents', 'reading') : factTo(k) })
    refN.set(k, notes.length)
  }
  const P = (text: string, refs: NoteRef[], uid: string) => (tn ? <Prose text={text} refs={refs} tn={tn} refN={refN} uid={uid} /> : null)
  const { answer } = verdictWords(parsed, projection)
  return (
    <>
      <PageHead title="Research note"
        purpose="A short analyst note written by AI from the numbers in this model. Rules check every number against the model before it’s saved; nothing here changes a number."
        answer={answer} />
      {ai && !ai.available && <p className="notice-in">AI writing is off. The verdict, risks and key numbers below are computed by rules.{' '}
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
      <p className="small-note">Analysis, not a recommendation.</p>
      <Next lead="Read it and the risks? Mark the model as reviewed on the Summary."><a className="btn" href={href('summary')}>Mark as reviewed</a></Next>
    </>
  )
}


/** The forensic flags, worst first, one plain sentence each with any approved explanation (AI-written, cited); then
 * the unusual years and data issues. Each line opens its evidence. */
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
      <h2 id="risks-h" className="label sec-label"><span>Risks · <b>warning signs found by rules</b></span><span>worst first</span></h2>
      {!lit.length && !oneoffs.length && !issues.length && <p className="small-note">No forensic rule lit, no unusual years and no data issues in the last three reported years.</p>}
      <ul className="risks">
        {lit.map(f => {
          const n = doc.flag_notes.find(x => x.key === f.key)
          return (
            <li key={f.key}>
              <p><Sev level={f.severity} /> {f.detail}</p>
              {n && <FlagNoteView note={n} />}
              <a className="small" href={href('risks', f.key)}
                aria-label={`${f.title}: ${n ? 'see it in What could go wrong?' : 'explain it in What could go wrong?'}`}>{n ? 'See it' : 'Explain it'}</a>
            </li>
          )
        })}
        {oneoffs.map(o => {
          const n = doc.notes[`oneoff:${o.year}`] as OneOffNote | undefined
          return (
            <li key={`${o.year}-${o.metric}`}>
              <p><span className="sev year">Year that stands out</span> {o.note}.</p>
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
        {issues.length > 0 && <li><p>{issues.length} issue{issues.length > 1 ? 's' : ''} in the reported data, e.g. {issues[0]}.</p>
          <a className="small" href={href('documents', 'data')}>See them all</a></li>}
      </ul>
      {tn && <div className="ai-note">
        <span className="who">AI-written · checked against the model</span>
        <ul className="ai-risks">{tn.risks.map((r, i) => <li key={i} className="serif">{P(r.text, r.refs, `r${i}`)}</li>)}</ul>
      </div>}
      {waiting.length > 0 && <p className="small-note">Not checked yet: {waiting.map(f => f.title.toLowerCase()).join(', ')}.{' '}
        <a href={href('risks', 'waiting')}>What they wait for</a></p>}
    </section>
  )
}

/** One input at a time, one step each way: grey bar = value falls, blue = value rises, from the base line. */
export function Tornado({ impact, base, price, oursOf }: { impact: Impact[]; base: number; price: number | null; oursOf: (k: string) => number }) {
  const vals = impact.flatMap(d => [d.down, d.up]).filter((x): x is number => x != null)
  const lo0 = Math.min(base, ...vals), hi0 = Math.max(base, ...vals)
  const pad = (hi0 - lo0 || 1) * 0.22 // room for the end labels, so they never clip
  const lo = lo0 - pad, hi = hi0 + pad
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100
  const reach = price == null ? [] : impact.filter(d => [d.down, d.up].some(v => v != null && (price > base ? v >= price : v <= price)))
  return (
    <section className="sec" aria-labelledby="tor-h">
      <h2 id="tor-h" className="label sec-label"><span>What moves value · <b>Rs a share</b></span><span>one input at a time</span></h2>
      <div className="tor" aria-hidden="true">
        <div className="tor-base" style={{ left: `calc(var(--tor-name) + (100% - var(--tor-name)) * ${x(base) / 100})` }} />
        {impact.map(d => {
          const ends = [d.down, d.up].filter((v): v is number => v != null)
          const l = Math.min(...ends), r = Math.max(...ends)
          return (
            <div className="tor-row" key={d.key}>
              <div className="name">{d.label}<small>{unit(d.key, oursOf(d.key))} ± {stepText(d.key, d.step)}</small></div>
              <div className="track">
                {l < base && <i className="bar lo" style={{ left: `${x(l)}%`, width: `${x(base) - x(l)}%` }} />}
                {r > base && <i className="bar hi" style={{ left: `${x(base)}%`, width: `${x(r) - x(base)}%` }} />}
                <span className="v l" style={{ left: `${x(l)}%` }}>{rs(l)}</span>
                <span className="v r" style={{ left: `${x(r)}%` }}>{rs(r)}</span>
              </div>
            </div>
          )
        })}
        <div className="tor-axis"><span style={{ left: `${x(base)}%` }}>{rs(base)}</span></div>
      </div>
      <div className="sr"><table>
        <caption>Value per share with one input moved one step down and up, others at base (Rs {rs(base)})</caption>
        <thead><tr><th scope="col">Input</th><th scope="col">Step</th><th scope="col">Down</th><th scope="col">Up</th></tr></thead>
        <tbody>{impact.map(d => <tr key={d.key}><th scope="row">{d.label}</th><td>{stepText(d.key, d.step)}</td>
          <td>{d.down == null ? 'no value' : rs(d.down)}</td><td>{d.up == null ? 'no value' : rs(d.up)}</td></tr>)}</tbody>
      </table></div>
      {price != null && <p className="small-note">{reach.length
        ? <>{reach.map(d => d.label).join(' and ')} alone {reach.length > 1 ? 'reach' : 'reaches'} the price (<span className="num mkt">{rs(price)}</span>) within one step.</>
        : <>No single input reaches the price (<span className="num mkt">{rs(price)}</span>) within one step.</>}{' '}
        Payout, other income and interest don’t move a cash-flow-to-firm value.</p>}
    </section>
  )
}

export function BreakEvens({ be, price, oursOf, c3, hist, v, vi, beta0 }: {
  be: NonNullable<Valuation['note']>['breakevens']; price: number; oursOf: (k: string) => number; c3: Cagr[]; hist: Row[]; v: Valuation; vi: ValInputs; beta0: number
}) {
  const margins = hist.map(h => (h.revenue ? (h.ebitda ?? 0) / h.revenue : null)).filter((x): x is number => x != null)
  const band: Record<string, [number, number, string] | null> = {
    growth: c3.length ? [Math.min(...c3.map(c => c.value)), Math.max(...c3.map(c => c.value)), 'three-year history'] : null,
    ebitda_margin: margins.length ? [Math.min(...margins), Math.max(...margins), `${margins.length}-yr range`] : null,
    wacc: null, g: null,
  }
  const rows = (['growth', 'ebitda_margin', 'wacc', 'g'] as const).filter(k => be[k])
  if (!rows.length) return null
  return (
    <section className="sec" aria-labelledby="be-h">
      <h2 id="be-h" className="label sec-label"><span>Break-evens · <b>to justify Rs {rs(price)}</b></span><span>one at a time</span></h2>
      <div className="be">
        {rows.map(k => {
          const b = be[k]!, need = b.value, ours = oursOf(k), h = band[k]
          const pts = [ours, ...(need != null ? [need] : []), ...(h ? h.slice(0, 2) as number[] : [])]
          const lo0 = Math.min(...pts), hi0 = Math.max(...pts), pad = (hi0 - lo0 || 0.02) * 0.15
          const lo = lo0 - pad, hi = hi0 + pad
          const x = (n: number) => `${((n - lo) / (hi - lo)) * 100}%`
          const cap = k === 'wacc'
            ? <>Ours {pc(ours)}{vi.wacc_override != null ? ' (typed)' : <>: cost of equity {pc(v.ke)} = {pc(vi.rf)} risk-free + {vi.beta} beta × {pc(vi.erp)} premium, blended with debt{vi.beta === beta0 ? ' (beta is the app default, not estimated for this company)' : ''}</>}</>
            : k === 'g' ? <>Ours {pc(ours)}</>
            : <>Ours {pc(ours)}{h && <> · {h[2]} <span className="num">{pc(h[0])}–{pc(h[1])}</span></>}</>
          const label = `${NAMES[k]}: needed ${need == null ? 'none in range' : pc(need)}; ours ${pc(ours)}${h ? `; ${h[2]} ${pc(h[0])} to ${pc(h[1])}` : ''}.`
          return (
            <div className="be-row" key={k}>
              <div className="top-line"><span>{NAMES[k]}</span>
                <span className="num">{need != null ? pc(need) : `none ${b.range ? `in ${pc(b.range[0])} to ${pc(b.range[1])}` : 'in range'}`}</span></div>
              {need != null && <div className="gauge" role="img" aria-label={label}>
                {h && <i className="hist" style={{ left: x(h[0]), width: `calc(${x(h[1])} - ${x(h[0])})` }} />}
                <i className="o" style={{ left: x(ours) }} />
                <i className="need" style={{ left: x(need) }} />
              </div>}
              <p>{need == null ? <>No {NAMES[k].toLowerCase()} {b.range ? `up to ${pc(b.range[1])}` : 'in range'} reaches the price. </> : null}{cap}</p>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Last reported year against the 3 years before (rules), then our first projected year in blue. */
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
  const show = (x: number | null, kind: string) => (x == null ? '–' : kind === 'x' ? `${x.toFixed(2)}×` : kind === 'days' ? `${Math.round(x)}` : fmt(x, 'pct'))
  // each measure opens where it is set (an input) or where it is reported (a statement row)
  const TO: Record<string, string> = { growth: href('forecast', 'growth'), ebitda_margin: href('forecast', 'ebitda_margin'), dso: href('forecast', 'dso'),
    pat_growth: href('statements', 'pat'), roce: href('statements', 'roce', 'ratios'), cash_conversion: href('statements', 'cfo', 'cash-flow') }
  const pe = v?.scenarios.base.multiples
  return (
    <section className="sec" aria-labelledby="keys-h">
      <h2 id="keys-h" className="label sec-label"><span>Key numbers · <b>what they say</b></span></h2>
      <table className="keys">
        <thead><tr><th scope="col"><span className="sr">Measure</span></th><th scope="col">{year}</th><th scope="col">3-yr median</th>
          {p && <th scope="col" className="ours">{next}</th>}</tr></thead>
        <tbody>
          {keys.map(k => {
            const f = flagged(k.key)
            return (
              <tr key={k.key}>
                <th scope="row"><a className="quiet" href={TO[k.key] ?? href('statements')}>{k.label}</a></th>
                <td className="num">{f ? <span className="pen">{show(k.last, k.kind)}<svg aria-hidden="true" viewBox="0 0 100 40" preserveAspectRatio="none"><ellipse cx="50" cy="20" rx="47" ry="16" /></svg><span className="sr"> (flagged: {f.fact})</span></span> : show(k.last, k.kind)}</td>
                <td className="num dim">{show(k.typical, k.kind)}</td>
                {p && <td className="num ours">{show(nextOf[k.key] ?? null, k.kind)}</td>}
              </tr>
            )
          })}
          {pe && pe.price_last.pe != null && <tr><th scope="row"><a className="quiet" href={href('valuation', 'multiples')}>P/E at price</a></th>
            <td className="num">{pe.price_last.pe.toFixed(1)}×</td><td className="num dim">{v?.multiples?.median.pe != null ? `${v.multiples.median.pe.toFixed(1)}×` : '–'}</td>
            {p && <td className="num ours">{pe.price_next.pe != null ? `${pe.price_next.pe.toFixed(1)}×` : '–'}</td>}</tr>}
        </tbody>
      </table>
      <p className="small-note">Black = reported. Grey = median of the three years before ({pe ? 'P/E: all years' : 'rules'}). Blue = our base projection. Circled = a rule check lit.</p>
    </section>
  )
}

/** Computed moves toward and away from the price, from the one-step runs and the break-evens. */
export function Change({ impact, base, price, oursOf, v, be, tn, P }: {
  impact: Impact[]; base: number; price: number; oursOf: (k: string) => number; v: Valuation; be: NonNullable<Valuation['note']>['breakevens']
  tn: ThesisNote | null; P: Pr
}) {
  const moves = impact.flatMap(d => ([['down', d.down, -1], ['up', d.up, 1]] as const).filter(m => m[1] != null).map(([, val, s]) => ({
    d, val: val as number, text: `${d.label} ${s > 0 ? 'up' : 'down'} ${stepText(d.key, d.step)} to ${unit(d.key, oursOf(d.key) + s * d.step)}`,
  })))
  const toward = moves.filter(m => Math.abs(price - m.val) < Math.abs(price - base)).sort((a, b) => Math.abs(price - a.val) - Math.abs(price - b.val)).slice(0, 3)
  const away = moves.filter(m => Math.abs(price - m.val) > Math.abs(price - base)).sort((a, b) => Math.abs(price - b.val) - Math.abs(price - a.val)).slice(0, 3)
  const bear = v.scenarios.bear.per_share, bull = v.scenarios.bull.per_share
  const fair = (['wacc', 'growth', 'ebitda_margin'] as const).find(k => be[k]?.value != null)
  const far = (x: number) => (Math.abs(price - x) < Math.abs(price - base) ? 'closer to the price' : 'further from it')
  return (
    <section className="change" aria-label="What would change the view">
      <div>
        <h2>What would close the gap</h2>
        <ul>
          {toward.map(m => <li key={m.text}><span>{m.text}: <span className="num ours">Rs {rs(m.val)}</span>{(price > base ? m.val >= price : m.val <= price) ? ', past the price' : ''}.</span></li>)}
          {fair && <li><span>{NAMES[fair]} at <span className="num">{unit(fair, be[fair]!.value!)}</span> instead of {unit(fair, oursOf(fair))}: the price is fair.</span></li>}
          {price > base && bull != null && <li><span>Bull case: <span className="num ours">Rs {rs(bull)}</span>, {far(bull)}.</span></li>}
          {!toward.length && !fair && <li><span>Nothing one step away moves our value toward the price.</span></li>}
          {tn && <li className="ai"><span><span className="kind ai">AI</span><span className="serif">{P(tn.bull_trigger, [], 'bt')}</span></span></li>}
        </ul>
      </div>
      <div className="down">
        <h2>What would widen it</h2>
        <ul>
          {away.map(m => <li key={m.text}><span>{m.text}: <span className="num ours">Rs {rs(m.val)}</span>.</span></li>)}
          {price > base && bear != null && <li><span>Bear case: <span className="num ours">Rs {rs(bear)}</span>.</span></li>}
          {price < base && bull != null && <li><span>Bull case: <span className="num ours">Rs {rs(bull)}</span>.</span></li>}
          {tn && <li className="ai"><span><span className="kind ai">AI</span><span className="serif">{P(tn.bear_trigger, [], 'bt2')}</span></span></li>}
        </ul>
      </div>
    </section>
  )
}


type Pr = (text: string, refs: NoteRef[], uid: string) => ReactNode

/** The note's words: written by the LLM only when you press the button, from the facts on this page and the approved
 * quotes; rules check every number, reference, quote and word before it is saved. Never written on load. */
function Thesis({ doc, setDoc, tn, stale, P, refN }: {
  doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; tn: ThesisNote | null; stale: boolean; P: Pr; refN: Map<string, number>
}) {
  const ai = useAi()
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
      <button type="button" className="btn" onClick={write} disabled={busy || off} aria-describedby="thesis-why">{busy ? 'Writing the note…' : label}</button>
      <span id="thesis-why" className="small-note">{off ? (ai ? 'AI off' : 'Checking whether AI is on…')
        : 'About a minute. Sends only the computed facts and approved quotes; rules check every number before it’s saved.'}</span>
    </div>
  )
  const nCites = tn ? Object.keys(tn.cites).length : 0
  const rec = doc.track?.[doc.track.length - 1]
  const after = tn && rec && rec.recorded_at > tn.written_at ? rec : null // new results since the note was written (5.3)
  return (
    <section className="sec thesis" aria-labelledby="thesis-h">
      <h2 id="thesis-h" ref={head} tabIndex={-1} className="label sec-label"><span>Three points</span>
        <span className={`who${stale ? ' stale' : ''}`}>{!tn ? 'Not written yet' : stale ? 'Written for earlier inputs' : 'AI-written · cited'}</span></h2>
      <div aria-live="polite">
        {busy && <p className="small-note">Writing the note · about a minute · you can leave this page.</p>}
        {done && !busy && <p className="sr">Note written and checked against the model.</p>}
        {fail && <div className="fail" role="alert"><p>{fail.text}</p>
          {fail.checks?.length ? <ul>{fail.checks.map(c => <li key={c.name}><strong>{c.name}:</strong> {c.detail}</li>)}</ul> : null}</div>}
      </div>
      {!tn && <div className="empty">
        <p>Not written yet. The writer reads the verdict, what moves value, the break-evens, key numbers, lit rule checks
          and the quotes you approved, and writes three points, the risks and what to watch. Everything else on this page
          is computed by rules.</p>
        {button('Write the note')}
      </div>}
      {tn && <>
        {stale && <p className="stale-note">{after
          ? <>Written before the {after.new_years.join(', ')} results came in ({when(tn.written_at)}), so some numbers below may
            no longer match. Rewrite it with the new results.</>
          : <>Written for earlier inputs: the model has changed since {when(tn.written_at)}, so some numbers below may no longer
            match. Rewrite to bring the words up to date.</>}</p>}
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
        <h3 className="label sub">Priced in</h3>
        <p className="serif prose">{P(tn.priced_in, [], 'p')}</p>
        <h3 className="label sub">What to watch</h3>
        <ul className="watch">{tn.what_to_watch.map((w, i) => <li key={i} className="serif">{P(w, [], `w${i}`)}</li>)}</ul>
        <p className="small-note">AI-written {when(tn.written_at)} from the facts on this page{nCites ? ` and ${nCites} approved quote${nCites > 1 ? 's' : ''}` : ''},
          checked against the model: every number matches one the app computed or a cited quote{tn.rounds > 1 ? ' (passed on the retry)' : ''}.
          Analysis, not a recommendation.</p>
        {button(after ? 'Rewrite the note with the new results' : 'Rewrite')}
      </>}
    </section>
  )
}

/** Base value per share built up: the explicit years, the terminal value, net cash, minorities; the price's gap. */
export function Bridge({ v, value, price, years }: { v: Valuation; value: number; price: number | null; years: string[] }) {
  const sv = v.scenarios.base
  if (v.shares == null || sv.pv_sum == null) return null
  const b = (x: number) => (Math.abs(value) >= 100 ? money(x) : rs(x))
  return (
    <section className="sec" aria-labelledby="bridge-h" id="a-bridge" tabIndex={-1}>
      <h3 id="bridge-h" className="label sec-label"><span>Base value, built up · <b>Rs a share</b></span></h3>
      <table className="keys">
        <tbody>
          <tr><th scope="row">Cash flows {years[0]}–{years[years.length - 1].slice(-3)}</th><td className="num">{b(sv.pv_sum / v.shares)}</td></tr>
          <tr><th scope="row">After {years[years.length - 1]} (terminal value)</th><td className="num">{b(sv.pv_tv! / v.shares)}</td></tr>
          <tr><th scope="row">{v.cash + v.investments - v.borrowings >= 0 ? 'Net cash' : 'Net debt'}</th><td className="num">{b((v.cash + v.investments - v.borrowings) / v.shares)}</td></tr>
          {(sv.minority ?? 0) > 0 && <tr><th scope="row">Minority interest</th><td className="num">{b(-sv.minority! / v.shares)}</td></tr>}
          <tr className="tot"><th scope="row">Base value</th><td className="num ours">{b(value)}</td></tr>
          {price != null && <tr><th scope="row">Price {price >= value ? 'adds' : 'is short by'}</th><td className="num mkt">{b(Math.abs(price - value))}</td></tr>}
        </tbody>
      </table>
      {sv.tv_share != null && <p className="small-note">{pc(sv.tv_share)} of value comes from after the forecast years (terminal value).</p>}
    </section>
  )
}
