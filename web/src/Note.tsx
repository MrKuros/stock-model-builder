import { useRef, useState, type ReactNode } from 'react'
import Ruler from './Ruler'
import { SEV, bySeverity } from './Evidence'
import { AiOffNote, FlagNoteView, useAi } from './Sources'
import { FundStrip } from './Fundamentals'
import { PeerLine } from './Peers'
import { useHref } from './route'
import {
  api, fmt, type ArNote, money, postJson, rs, when, type Cagr, type Impact, type ModelDoc, type NoteRef, type OneOffNote, type Parsed,
  type Path, type Projection, type RuleCheck, type Row, type ThesisNote, type ValInputs, type Valuation,
} from './lib'

/** Average of a straight-line path over the projection: what "ours" means for a faded driver. */
export const avg = (p: Path | undefined) => (p ? (p.start + (p.end ?? p.start)) / 2 : 0)
export const shortName = (n: string) => n.replace(/\s+(ltd\.?|limited)$/i, '').trim()
/** The name as a sentence subject: long legal names read as "the company" (the export carries no ticker). */
const COMPANY = 'The company'
const subject = (n: string) => (shortName(n).length <= 18 ? shortName(n) : COMPANY)
/** Possessive: "Tata Motors’", "TCS’s" (plural-form names take the apostrophe alone). */
const poss = (n: string) => (/[a-z]s$/.test(n) ? `${n}’` : `${n}’s`)
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen']
const pc = (v: number) => fmt(v, 'pct')
const DAYS = new Set(['dso', 'dio', 'dpo'])
const unit = (key: string, v: number) => (DAYS.has(key) ? `${Math.round(v)} days` : pc(v))
const stepText = (key: string, s: number) => (DAYS.has(key) ? `${s} days` : `${+(s * 100).toFixed(1)} pp`)
const SEVERITY: Record<RuleCheck['status'], string> = { red: 'Red flag', amber: 'Amber flag', clear: 'Clear', filing: 'Needs a filing' }
const LOW = (c: RuleCheck) => (c.severity === 'low' ? ' (low)' : '')
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
  changed?: ReactNode // right under the verdict: new results against your forecast (5.3)
  provenance?: ReactNode // right under the verdict: where the numbers come from, for a company added by ticker
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

/** Overview: the verdict first, then the business in five numbers, price against value, the checks, the thesis and
 * risks next to the key numbers, and where to go deeper. The how-it-is-valued detail lives on Valuation. */
export default function Note({ parsed, doc, setDoc, projection, provenance, changed }: Props) {
  const href = useHref()
  const { company, years } = parsed
  const hist = parsed.hist ?? company.hist
  const name = subject(company.name)
  // where the reported numbers came from: NSE's filings (added by ticker), an Excel export, or both
  const filed = Object.values(company.source?.years ?? {})
  const builtFrom = !company.source?.symbol ? 'an Excel export'
    : filed.every(w => w === 'NSE filing') ? 'NSE results filings' : 'NSE results filings and an Excel export'
  const nameIn = name === COMPANY ? 'the company' : name
  const v = projection?.valuation ?? null
  const sv = v?.scenarios.base
  const value = sv?.per_share ?? null
  const price = v?.price ?? null
  const base = doc.scenarios.base
  const ours = avg(base.growth)
  const isDefault = base.growth.end == null && Math.abs(base.growth.start - parsed.defaults.growth) < 1e-9
  const c3 = parsed.cagrs?.['3'] ?? [], c5 = parsed.cagrs?.['5'] ?? []
  const best = (cs: Cagr[]) => (cs.length ? cs.reduce((a, b) => (b.value > a.value ? b : a)) : null)
  const best3 = best(c3), best5 = best(c5)
  // the price needs a flat rate for n years: compare it with runs of the same length (or the longest the data has)
  const hz = Math.min(doc.n, hist.length - 1)
  const runs: Cagr[] = hist.flatMap((h, i) => {
    const a = i >= hz ? hist[i - hz].revenue : null, b = h.revenue
    return a != null && b != null && a > 0 && b > 0 ? [{ from: years[i - hz], to: years[i], value: (b / a) ** (1 / hz) - 1 }] : []
  })
  const bestN = best(runs)
  const implied = sv?.implied_growth ?? null
  const bear = v?.scenarios.bear.per_share ?? null, bull = v?.scenarios.bull.per_share ?? null
  const nb = v?.note ?? null
  const checks = parsed.rule_checks ?? []
  const last = years[years.length - 1]

  // footnotes, numbered in reading order
  const notes: { kind: string; text: ReactNode; quote?: string; to?: string }[] = []
  const cite = (kind: string, text: ReactNode, quote?: string, to?: string) => { notes.push({ kind, text, quote, to }); return notes.length }
  const nImplied = implied == null ? 0 : cite('Computed', <>Reverse DCF: the flat revenue growth, every projected year, at which base value equals the price; searched from −30% to +80%, other inputs as set.</>, undefined, href('checks', 'verdict'))
  const nValue = cite('Computed', <>DCF of free cash flow to firm, base, bear and bull cases; WACC {v ? pc(v.wacc) : '–'}, terminal growth {v ? pc(v.g) : '–'}, valued at the {last} year end.</>, undefined, href('valuation'))
  // the written note's refs, in reading order: facts (computed) and quotes (files), each a footnote linking to its evidence
  const tn = doc.note
  const refN = new Map<string, number>()
  const factTo = (k: string) => (k.startsWith('flag_') ? href('checks', k.slice(5)) : k.startsWith('in_') ? href('forecast', k.slice(3))
    : k.startsWith('oneoff_') ? href('checks', 'unusual') : href('valuation'))
  const showCagr = value != null && price != null && implied != null && bestN != null
  const nCagr = showCagr ? cite('Reported', <>Reported revenue ({builtFrom}): {runs.length} rolling {WORDS[hz] ?? hz}-year window{runs.length > 1 ? 's' : ''} from {years[0]}; fastest {bestN!.from}–{bestN!.to}.</>) : 0
  const stale = !!tn && projection?.inputs_hash != null && projection.inputs_hash !== tn.inputs_hash
  // the written note's facts that the verdict already cites share its footnote (while the words match the inputs)
  if (tn && !stale) { if (nImplied) refN.set('implied_growth', nImplied); if (nCagr) refN.set(`best${hz}`, nCagr) }

  if (tn) for (const r of [...tn.thesis.flatMap(p => p.refs), ...tn.risks.flatMap(p => p.refs)]) {
    const k = refKey(r), s = refSource(tn, r)
    if (refN.has(k) || !s) continue
    refN.set(k, cite(s.file ? `File p.${s.page}` : 'Computed', s.text, s.quote,
      s.file ? href('checks', 'src-ar-head') : factTo(k)))
  }
  const P = (text: string, refs: NoteRef[], uid: string) => (tn ? <Prose text={text} refs={refs} tn={tn} refN={refN} uid={uid} /> : null)

  // --- verdict ---
  let h1: ReactNode, stand: ReactNode = null
  // a dead end names its fix and links to it (App's anchor falls back to the element id, so focus lands on the input)
  const fix = (to: string, label: string) => <> <a href={to === 'capex_pct' ? href('forecast', to) : href('valuation', to === 'valuation' ? '' : to)}>{label}</a></>
  if (value == null) {
    const why = !v ? 'the model is still calculating, or the inputs gave an error (see the line at the top).'
      : v.error ?? (sv?.error && sv.error[0].toLowerCase() + sv.error.slice(1)) ?? (v.shares == null ? 'there is no share count. Type one on the Valuation page.' : 'see the Valuation page.')
    const to = !v ? null : !v.error && v.shares == null ? 'v-shares' : !v.error && sv?.error?.startsWith('Final-year free cash flow') ? 'capex_pct' : 'valuation'
    h1 = <>No value yet.</>
    stand = <>Our base case has no value per share: {why}{to && fix(to, to === 'v-shares' ? 'Type the share count' : to === 'capex_pct' ? 'Open capex' : 'Open Valuation')} The
      rule checks and key numbers below still apply.</>
  } else if (value <= 0) { // debt worth more than the business at these inputs (Milky Mist with capex cut to a value)
    h1 = <>Our base case leaves nothing for shareholders: <span className="ours">Rs {rs(value)}</span> a share.</>
    stand = <>At these inputs the business is worth less than its net debt, so the shares carry no value. A higher margin,
      lower capex or a lower discount rate (WACC {v ? pc(v.wacc) : '–'}) lifts it.{fix('capex_pct', 'Open capex')}</>
  } else if (price == null) {
    h1 = <>Our base value is <span className="ours">Rs {rs(value)}</span> a share.</>
    stand = <>There’s no share price in this file, so nothing to compare it with.{fix('v-price', 'Type a price')}</>
  } else if (implied != null) {
    h1 = <>The price needs <Cite n={nImplied} src="Reverse DCF on our base case, computed by rules" plain><span className="mkt">{pc(implied)}</span></Cite> growth a year. {isDefault
      ? <>{name} is doing <span className="ours">{pc(ours)}</span>.</>
      : <>We assume <span className="ours">{pc(ours)}</span>.</>}</>
  } else {
    h1 = <>The price is <span className="mkt">{pc(Math.abs(price / value - 1))}</span> {price > value ? 'above' : 'below'} our base value.</>
  }
  if (value != null && value > 0 && price != null) {
    const where = bull != null && price > bull ? <>the price sits {pc(price / bull - 1)} above even our bull case</>
      : bear != null && price < bear ? <>the price sits {pc(1 - price / bear)} below even our bear case</>
      : <>the price sits inside our range</>
    stand = <>Our value range is <Cite n={nValue} src="DCF, bear to bull, computed by rules">Rs {bear != null ? rs(bear) : '–'} – {bull != null ? rs(bull) : '–'}</Cite> a
      share, bear to bull. At <span className="num mkt">Rs {rs(price)}</span> {where}.{' '}
      {implied == null
        ? <>No flat revenue growth between −30% and +80% a year gets our base case to the price.</>
        : bestN && <>{poss(name)} fastest {WORDS[hz] ?? hz} years since {years[0]}, <Cite n={nCagr} src={`Revenue CAGR ${bestN.from}–${bestN.to}, from reported revenue`}>{pc(bestN.value)}</Cite> a
          year in {bestN.from}–{bestN.to.slice(-2)}, {bestN.value >= implied ? 'would get there' : 'would not get there'}{hz < doc.n
            ? <> (the longest run in the data; the price needs {WORDS[doc.n] ?? doc.n} years)</> : null}.</>}</>
  }

  // how sure: the 50 sensitivity cells against the price
  const cells: { v: number; what: string }[] = []
  if (sv && v?.steps && price != null) {
    sv.grid.forEach((r, i) => r.forEach((x, j) => x != null && cells.push({ v: x, what: `discount rate ${pc(v.wacc + v.steps!.wacc[i])} with ${pc(v.g + v.steps!.g[j])} terminal growth` })))
    sv.grid_gm?.forEach((r, i) => r.forEach((x, j) => x != null && cells.push({ v: x, what: `growth ${sgn(v.steps!.growth[i])} and margin ${sgn(v.steps!.margin[j])}` })))
  }
  const over = cells.filter(c => c.v > price!)
  const top = nb?.impact[0]
  const be = nb?.breakevens ?? {}
  const oursOf = (k: string) => (k === 'wacc' ? v?.wacc ?? 0 : k === 'g' ? v?.g ?? 0 : avg(base[k]))

  return (
    <>
      <section className="verdict" aria-labelledby="page-h">
        <div>
          <p className="label">Overview · <b>base case</b> · what the price assumes against what the business does</p>
          <h1 id="page-h" tabIndex={-1}>{h1}</h1>
          {doc.active !== 'base' && <p className="small-note">This summary is about the base case. Your {doc.active} case
            {v?.scenarios[doc.active].per_share != null ? <> is <span className="num ours">Rs {rs(v.scenarios[doc.active].per_share!)}</span> a share</> : ' has no value yet'}:{' '}
            <a href={href('valuation', 'worth')}>see every case in Valuation</a>.</p>}
          {stand && <p className="lede">{stand}</p>}
        </div>
        {(sv?.upside != null || cells.length > 0 || top) && <aside className="sure" aria-label="How sure">
          {sv?.upside != null && <div className="row">
            <span className="label">{sv.upside < 0 ? 'Downside' : 'Upside'} to our base value</span>
            <span className="big num">{sv.upside < 0 ? '−' : '+'}{pc(Math.abs(sv.upside))}</span>
            <p>Base value <span className="num ours">Rs {rs(value!)}</span> against price <span className="num mkt">Rs {rs(price!)}</span>.</p>
          </div>}
          {cells.length > 0 && <div className="row">
            <span className="label">How sure</span>
            <p><strong>{over.length * 2 > cells.length ? over.length : cells.length - over.length} of {cells.length}</strong> sensitivity
              cases value {nameIn} {over.length * 2 > cells.length ? 'above' : 'below'} the price.</p>
            <div className="dots" role="img" aria-label={`${cells.length} squares: ${cells.length - over.length} below the price, ${over.length} above`}>
              {[...cells].sort((a, b) => a.v - b.v).map((c, i) => <i key={i} className={c.v > price! ? 'over' : undefined} />)}
            </div>
            {(over.length > 0 && over.length <= 3) && <p>Above it: {over.map(c => c.what).join('; ')}.</p>}
            {(cells.length - over.length > 0 && cells.length - over.length <= 3) && <p>Below it: {cells.filter(c => c.v <= price!).map(c => c.what).join('; ')}.</p>}
          </div>}
          {top && <div className="row">
            <span className="label">Hinges on</span>
            <p>{be[top.key as keyof typeof be]?.value != null
              ? <>{top.label}. At <span className="num">{unit(top.key, be[top.key as keyof typeof be]!.value!)}</span> instead of our <span className="num">{unit(top.key, oursOf(top.key))}</span>, the price is fair.</>
              : <>{top.label}: {stepText(top.key, top.step)} either way moves our value between <span className="num ours">Rs {rs(Math.min(top.down ?? top.up!, top.up ?? top.down!))}</span> and <span className="num ours">Rs {rs(Math.max(top.down ?? top.up!, top.up ?? top.down!))}</span>.</>}{' '}
              <a className="go" href={href('valuation', 'hinges')}>What moves value</a></p>
          </div>}
        </aside>}
      </section>
      {changed}
      {provenance}

      <FundStrip parsed={parsed} />
      <PeerLine doc={doc} t={projection?.peers} short={shortName(company.name)} />

      {value != null && (
        <section className="instrument" aria-labelledby="ruler-h">
          <header>
            <h2 id="ruler-h" className="label">Price against value · <b>Rs a share</b>, and the growth each value needs</h2>
            <a className="go" href={href('valuation')}>How we value it</a>
            <div className="legend" aria-hidden="true">
              <span><i className="lg-band" />Our range, bear to bull</span>
              <span><i className="lg-mkt" />Market price</span>
              <span><i className="lg-hatch" />Not explained by our model</span>
            </div>
          </header>
          <Ruler price={price} bear={bear} base={value} bull={bull} scale={nb?.growth_scale ?? null} ours={ours} implied={implied}
            best3={best3} best5={best5} since={years[0]} />
          <p className="read">
            <span>Lower scale: five-year revenue growth each value needs, other inputs at base (margin {pc(avg(base.ebitda_margin))},
              WACC {pc(v!.wacc)}, terminal {pc(v!.g)}). Red hatching: growth faster than the best five years on record.</span>
            <a href={href('checks', 'verdict')}>How this is computed</a>
          </p>
        </section>
      )}

      <Strip checks={checks} />

      <div className="ov-cols">
        <div className="col">
          <Thesis doc={doc} setDoc={setDoc} tn={tn} stale={stale} P={P} refN={refN} />
          <Risks parsed={parsed} doc={doc} tn={tn} P={P} />
        </div>
        <div className="col">
          <KeyNumbers parsed={parsed} proj={projection?.scenarios.base[0] ?? null} next={projection?.years[0]} checks={checks} v={v} />
          <OperatingNumbers notes={doc.notes} />
        </div>
      </div>

      <section className="sec deeper" aria-labelledby="next-h">
        <h2 id="next-h" className="label sec-label"><span>Go deeper</span></h2>
        <div className="onward">
          <a href={href('forecast')}><b>Change the forecast</b><span>Growth {pc(avg(base.growth))}, margin {pc(avg(base.ebitda_margin))}: every input, where it came from, and a line to drag.</span></a>
          <a href={href('valuation', 'gap')}><b>What would close the gap</b><span>{gapText(nb?.impact ?? [], value, price, oursOf)}</span></a>
          <a href={href('checks', 'documents')}><b>Add documents</b><span>{(parsed.forensic ?? []).some(f => f.severity === 'not_checked' && f.needs)
            ? `An annual report unlocks ${(parsed.forensic ?? []).filter(f => f.severity === 'not_checked' && f.needs).length} more checks and cited explanations.`
            : 'Annual reports and call transcripts let the app draft inputs and explain flags, with quotes.'}</span></a>
        </div>
      </section>

      <details className="notes audit">
        <summary>Sources for the numbers on this page ({notes.length})</summary>
        <ol>
          {notes.map((n, i) => (
            <li key={i} id={`fn-${i + 1}`} tabIndex={-1}>
              <span className={`kind ${n.kind === 'Computed' ? 'rule' : 'file'}`}>{n.kind}</span>{n.text}
              {n.quote && <q className="quote">{n.quote}</q>}
              {n.to && <> <a href={n.to}>Open</a></>}
            </li>
          ))}
        </ol>
      </details>

      <footer className="foot">
        <p>Analysis, not a recommendation. Built from {builtFrom} and the rules in this app; no management access
          or channel checks.</p>
        <div className="key3" aria-label="How to read this note">
          <span className="s1">{value != null ? <>{rs(value)} computed by rules</> : <>Numbers in mono: computed by rules</>}</span>
          <span className="s2">Written words, AI, cited</span>
          <span className="mkt">Market price</span>
          <span className="ours">Our model</span>
        </div>
      </footer>
    </>
  )
}

const sgn = (d: number) => (d === 0 ? 'as set' : `${d > 0 ? '+' : '−'}${+(Math.abs(d) * 100).toFixed(1)} pp`)

/** Where a strip cell's evidence is on the Checks page. */
const checkAnchor = (id: string) => (id.startsWith('oneoff-') ? 'unusual' : id)

/** The rule checks: each lit one as its own cell, then one cell for the clear ones and one for those waiting on a
 * filing. Every cell is a link to its evidence on Checks. */
function Strip({ checks }: { checks: RuleCheck[] }) {
  const href = useHref()
  if (!checks.length) return null
  const lit = checks.filter(c => c.status === 'red' || c.status === 'amber')
  const clear = checks.filter(c => c.status === 'clear'), filing = checks.filter(c => c.status === 'filing')
  const red = lit.filter(c => c.status === 'red').length, amber = lit.length - red
  return (
    <section className="annun" aria-labelledby="flags-h">
      <div className="strip-head">
        <h2 id="flags-h" className="label">Warning signs · <b>{red} red · {amber} amber · {clear.length} clear{filing.length ? ` · ${filing.length} need the annual report` : ''}</b></h2>
        <a className="go" href={href('checks')}>All warning signs, in Checks</a>
      </div>
      <div className="cells">
        {lit.map((c, i) => (
          <a key={c.id} href={href('checks', checkAnchor(c.id))} className={`cell ${c.status}${c.severity === 'low' ? ' low' : ''}`} style={{ animationDelay: `${i * 30}ms` }}
            aria-label={`${SEVERITY[c.status]}${LOW(c)}: ${c.name}, ${c.fact}. Open its evidence.`}>
            <span className="k">{c.name}</span>
            <span className="v">{c.fact}</span>
          </a>
        ))}
        {clear.length > 0 && <a className="cell clear" href={href('checks', 'clear')}>
          <span className="k">{clear.length} check{clear.length > 1 ? 's' : ''} clear</span>
          <span className="v">{clear.slice(0, 3).map(c => c.name).join('; ')}{clear.length > 3 ? '…' : ''}</span></a>}
        {filing.length > 0 && <a className="cell filing" href={href('checks', 'src-ar-head')}>
          <span className="k">{filing.length} not checked yet</span>
          <span className="v">Attach the annual report →</span></a>}
      </div>
    </section>
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
              <p><span className={`sev ${f.severity}`}>{SEV[f.severity]}</span> {f.detail}</p>
              {n && <FlagNoteView note={n} />}
              <a className="small" href={href('checks', f.key)}
                aria-label={`${f.title}: ${n ? 'see it in Checks' : 'explain it in Checks'}`}>{n ? 'See it in Checks' : 'Explain it in Checks'}</a>
            </li>
          )
        })}
        {oneoffs.map(o => {
          const n = doc.notes[`oneoff:${o.year}`] as OneOffNote | undefined
          return (
            <li key={`${o.year}-${o.metric}`}>
              <p><span className="sev year">Unusual year</span> {o.note}.</p>
              {n && <div className="ai-note">
                <span className="who">AI-written · {n.from_numbers ? 'from the numbers only' : 'cited'}</span>
                <p className="serif">{n.summary}</p>
                {n.quote && <p className="src-line"><span className="kind file">File</span>{n.file}, p.{n.page}: <q>{n.quote}</q></p>}
              </div>}
              {!n && <a className="small" href={href('checks', 'unusual')}
                aria-label={`Explain ${o.year} from the annual report`}>Explain it from the annual report</a>}
            </li>
          )
        })}
        {issues.length > 0 && <li><p>{issues.length} issue{issues.length > 1 ? 's' : ''} in the reported data, e.g. {issues[0]}.</p>
          <a className="small" href={href('checks', 'data')}>See them all</a></li>}
      </ul>
      {tn && <div className="ai-note">
        <span className="who">AI-written · checked against the model</span>
        <ul className="ai-risks">{tn.risks.map((r, i) => <li key={i} className="serif">{P(r.text, r.refs, `r${i}`)}</li>)}</ul>
      </div>}
      {waiting.length > 0 && <p className="small-note">Not checked yet: {waiting.map(f => f.title.toLowerCase()).join(', ')}.{' '}
        <a href={href('checks', 'src-ar-head')}>Attach the annual report</a></p>}
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

/** Operating numbers from the latest approved annual-report note (order book, headcount, attrition, volumes...), each in
 * the unit printed, with its quote. Read by AI, checked by rules, approved by you; they never feed a number. */
function OperatingNumbers({ notes }: { notes: Record<string, unknown> }) {
  const href = useHref()
  const n = Object.entries(notes).filter(([k]) => k.startsWith('ar:kpis:')).map(([, x]) => x as ArNote)
    .sort((a, b) => b.year.localeCompare(a.year))[0]
  return (
    <section className="sec kpis" aria-labelledby="kpis-h">
      <h2 id="kpis-h" className="label sec-label"><span>Operating numbers · <b>{n ? `${n.year}, from the annual report` : 'none read yet'}</b></span></h2>
      {n ? <>
        <ul className="kpi-list">{n.rows.map((r, i) => (
          <li key={i}><span>{r.label}</span> <b className="num">{r.amount == null ? '–' : r.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}{r.unit === '%' ? '%' : ` ${r.unit ?? ''}`}</b>
            <span className="small dim"> p.{r.page}<span className="sr">: “{r.quote}”</span></span></li>))}</ul>
        <p className="small-note">As printed in {n.file ?? 'the annual report'}, read by AI and approved by you; they don’t change any
          number in the model. <a href={href('checks', 'documents')}>Quotes</a></p>
      </> : <p className="small-note">Order book, headcount, attrition or volumes, as the annual report prints them: attach the
        report on <a href={href('checks', 'documents')}>Checks → Documents</a> and read “Operating numbers”.</p>}
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
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState<{ text: string; checks?: ThesisNote['checks'] } | null>(null)
  const [done, setDone] = useState(false)
  const head = useRef<HTMLHeadingElement>(null)
  const write = async () => {
    setBusy(true)
    setFail(null)
    setDone(false)
    try {
      const r = await api<ThesisNote>('/api/note/write', postJson(doc))
      if (r.status === 'written') {
        setDoc(d => ({ ...d, note: r, reviewed_at: null })) // new words: back to draft
        setDone(true)
        // the "Write the note" button unmounts: put focus on the heading, unless you moved on during the wait
        window.setTimeout(() => {
          const a = document.activeElement
          if (!a || a === document.body || head.current?.closest('section')?.contains(a)) head.current?.focus()
        })
      }
      else setFail({ text: 'The note failed the rule checks twice, so it wasn’t saved.', checks: r.checks.filter(c => c.pass === false) })
    } catch (e) { setFail({ text: (e as Error).message }) } finally { setBusy(false) }
  }
  const off = !ai?.available
  const button = (label: string) => (
    <div className="write">
      <button type="button" className="btn" onClick={write} disabled={busy || off} aria-describedby="thesis-why">{busy ? 'Writing…' : label}</button>
      <span id="thesis-why" className="small-note">{off ? (ai ? 'AI is off (see just below).' : 'Checking whether an AI command is set…')
        : 'Sends only the computed facts and approved quotes on this page; rules check every number before it is saved.'}</span>
      <AiOffNote ai={ai} />
    </div>
  )
  const nCites = tn ? Object.keys(tn.cites).length : 0
  const rec = doc.track?.[doc.track.length - 1]
  const after = tn && rec && rec.recorded_at > tn.written_at ? rec : null // new results since the note was written (5.3)
  return (
    <section className="sec thesis" aria-labelledby="thesis-h">
      <h2 id="thesis-h" ref={head} tabIndex={-1} className="label sec-label"><span>Thesis · <b>3 points</b></span>
        <span className={`who${stale ? ' stale' : ''}`}>{!tn ? 'Not written yet' : stale ? 'Written for earlier inputs' : 'AI-written · cited'}</span></h2>
      <div aria-live="polite">
        {busy && <p className="small-note">Writing the note from the numbers on this page. This takes a minute or two.</p>}
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
        {button(after ? 'Rewrite the note with the new results' : 'Rewrite thesis')}
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

/** The two one-step moves that bring our value closest to the price, for the Overview's "close the gap" card. */
function gapText(impact: Impact[], base: number | null, price: number | null, oursOf: (k: string) => number) {
  if (base == null || price == null || !impact.length) return 'Each input moved one step: which ones bring our value toward the price.'
  const moves = impact.flatMap(d => ([[d.down, -1], [d.up, 1]] as const).filter(m => m[0] != null).map(([val, s]) => ({
    val: val as number, text: `${d.label} ${s > 0 ? 'up' : 'down'} ${stepText(d.key, d.step)} to ${unit(d.key, oursOf(d.key) + s * d.step)}`,
  }))).filter(m => Math.abs(price - m.val) < Math.abs(price - base)).sort((a, b) => Math.abs(price - a.val) - Math.abs(price - b.val)).slice(0, 2)
  return moves.length ? moves.map(m => `${m.text}: Rs ${rs(m.val)}`).join('. ') + '.' : 'No single step moves our value toward the price.'
}
