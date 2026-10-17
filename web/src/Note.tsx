import type { ReactNode } from 'react'
import Ruler from './Ruler'
import { SEV, bySeverity } from './Evidence'
import { FlagNoteView } from './Sources'
import type { Go } from './App'
import {
  fmt, money, rs, type Cagr, type Impact, type ModelDoc, type OneOffNote, type Parsed, type Path, type Projection,
  type RuleCheck, type Row, type ValInputs, type Valuation,
} from './lib'

/** Average of a straight-line path over the projection: what "ours" means for a faded driver. */
export const avg = (p: Path | undefined) => (p ? (p.start + (p.end ?? p.start)) / 2 : 0)
export const shortName = (n: string) => n.replace(/\s+(ltd\.?|limited)$/i, '').trim()
/** The name as a sentence subject: long legal names read as "the company" (the export carries no ticker). */
const subject = (n: string) => (shortName(n).length <= 18 ? shortName(n) : 'It')
const pc = (v: number) => fmt(v, 'pct')
const DAYS = new Set(['dso', 'dio', 'dpo'])
const unit = (key: string, v: number) => (DAYS.has(key) ? `${Math.round(v)} days` : pc(v))
const stepText = (key: string, s: number) => (DAYS.has(key) ? `${s} days` : `${+(s * 100).toFixed(1)} pp`)
const SEVERITY: Record<RuleCheck['status'], string> = { red: 'Red flag', amber: 'Amber flag', clear: 'Clear', filing: 'Needs a filing' }
const LOW = (c: RuleCheck) => (c.severity === 'low' ? ' (low)' : '')
const NAMES = { growth: 'Revenue growth', ebitda_margin: 'EBITDA margin', wacc: 'Discount rate (WACC)', g: 'Terminal growth' } as const

/** A cited number: dotted underline, a footnote mark that jumps to the Notes list, the source on hover or focus. */
function Cite({ n, src, children, plain }: { n: number; src: string; children: ReactNode; plain?: boolean }) {
  const id = `cite-${n}`
  return (
    <span className="cite">
      <span className={plain ? undefined : 'num'}>{children}</span>
      <sup><button type="button" className="fnref" aria-describedby={id} title={src}
        onClick={() => { const el = document.getElementById(`fn-${n}`); el?.scrollIntoView({ block: 'center' }); el?.focus() }}>
        {n}<span className="sr"> (note {n})</span></button></sup>
      <span className="tip" role="tooltip" id={id}>{src}</span>
    </span>
  )
}

interface Props { parsed: Parsed; doc: ModelDoc; projection: Projection | null; go: Go }

export default function Note({ parsed, doc, projection, go }: Props) {
  const { company, years } = parsed
  const hist = parsed.hist ?? company.hist
  const name = subject(company.name)
  const nameIn = name === 'It' ? 'it' : name
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
  const implied = sv?.implied_growth ?? null
  const bear = v?.scenarios.bear.per_share ?? null, bull = v?.scenarios.bull.per_share ?? null
  const nb = v?.note ?? null
  const checks = parsed.rule_checks ?? []
  const last = years[years.length - 1]

  // footnotes, numbered in reading order
  const notes: { kind: string; text: ReactNode; quote?: string; to?: () => void }[] = []
  const cite = (kind: string, text: ReactNode, quote?: string, to?: () => void) => { notes.push({ kind, text, quote, to }); return notes.length }
  const nImplied = implied == null ? 0 : cite('Computed', <>Reverse DCF: the flat revenue growth, every projected year, at which base value equals the price; searched from −30% to +80%, other inputs as set.</>, undefined, () => go('evidence', 'verdict'))
  const nValue = cite('Computed', <>DCF of free cash flow to firm, base, bear and bull cases; WACC {v ? pc(v.wacc) : '–'}, terminal growth {v ? pc(v.g) : '–'}, valued at the {last} year end.</>, undefined, () => go('model', 'valuation'))
  const nCagr = best3 ? cite('Reported', <>Revenue (Export export, Sales row): {c3.length} rolling three-year window{c3.length > 1 ? 's' : ''} from {years[0]}; fastest {best3.from}–{best3.to}.</>) : 0

  // --- verdict ---
  let h1: ReactNode, stand: ReactNode = null
  if (value == null) {
    const why = !v ? 'the model is still calculating, or the inputs gave an error (see Model).'
      : v.error ?? sv?.error ?? (v.shares == null ? 'there is no share count. Type one under Model, Valuation.' : 'see Model, Valuation.')
    h1 = <>No value yet.</>
    stand = <>Our base case has no value per share: {why} The rule checks and key numbers below still apply.</>
  } else if (price == null) {
    h1 = <>Our base value is <span className="ours">Rs {rs(value)}</span> a share.</>
    stand = <>There’s no share price in this file, so nothing to compare it with. Type one under Model, Valuation.</>
  } else if (implied != null) {
    h1 = <>The price needs <Cite n={nImplied} src="Reverse DCF on our base case, computed by rules" plain><span className="mkt">{pc(implied)}</span></Cite> growth a year. {isDefault
      ? <>{name} is doing <span className="ours">{pc(ours)}</span>.</>
      : <>We assume <span className="ours">{pc(ours)}</span>.</>}</>
  } else {
    h1 = <>The price is <span className="mkt">{pc(Math.abs(price / value - 1))}</span> {price > value ? 'above' : 'below'} our base value.</>
  }
  if (value != null && price != null) {
    const where = bull != null && price > bull ? <>the price sits {pc(price / bull - 1)} above even our bull case</>
      : bear != null && price < bear ? <>the price sits {pc(1 - price / bear)} below even our bear case</>
      : <>the price sits inside our range</>
    stand = <>Our value range is <Cite n={nValue} src="DCF, bear to bull, computed by rules">Rs {bear != null ? rs(bear) : '–'} – {bull != null ? rs(bull) : '–'}</Cite> a
      share, bear to bull. At <span className="num mkt">Rs {rs(price)}</span> {where}.{' '}
      {implied == null
        ? <>No flat revenue growth between −30% and +80% a year gets our base case to the price.</>
        : best3 && <>{name === 'It' ? 'Its' : `${name}’s`} fastest three years since {years[0]}, <Cite n={nCagr} src={`Revenue CAGR ${best3.from}–${best3.to}, from the Export export`}>{pc(best3.value)}</Cite> a
          year in {best3.from}–{best3.to.slice(-2)}, {best3.value >= implied ? 'would get there' : 'would not get there'}.</>}</>
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
      <section className="verdict" aria-labelledby="verdict-h">
        <div>
          <p className="label">Verdict · <b>base case</b> · computed by rules</p>
          <h1 id="verdict-h">{h1}</h1>
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
              : <>{top.label}: {stepText(top.key, top.step)} either way moves our value between <span className="num ours">Rs {rs(Math.min(top.down ?? top.up!, top.up ?? top.down!))}</span> and <span className="num ours">Rs {rs(Math.max(top.down ?? top.up!, top.up ?? top.down!))}</span>.</>}</p>
          </div>}
        </aside>}
      </section>

      {value != null && (
        <section className="instrument" aria-labelledby="ruler-h">
          <header>
            <h2 id="ruler-h" className="label">Price against value · <b>Rs a share</b>, and the growth each value needs</h2>
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
            <button type="button" className="link" onClick={() => go('evidence', 'verdict')}>How this is computed</button>
          </p>
        </section>
      )}

      <Strip checks={checks} go={go} />

      <div className="cols">
        <div className="col">
          <section className="sec" aria-labelledby="thesis-h">
            <h2 id="thesis-h" className="label sec-label"><span>Thesis</span><span className="who">Not written yet</span></h2>
            <div className="empty">
              <p>No thesis yet. When the thesis writer runs, its three points appear here in serif, marked AI-written, each
                number tied to a source in the Notes. Everything else on this page is computed by rules.</p>
            </div>
          </section>
          <Risks parsed={parsed} doc={doc} go={go} />
        </div>

        <div className="col">
          {nb && nb.impact.length > 0 && value != null && <Tornado impact={nb.impact.slice(0, 5)} base={value} price={price} oursOf={oursOf} />}
          {price != null && nb && <BreakEvens be={be} price={price} oursOf={oursOf} c3={c3} hist={hist} v={v!} vi={doc.valuation} />}
        </div>

        <div className="col side">
          <KeyNumbers parsed={parsed} proj={projection?.scenarios.base[0] ?? null} next={projection?.years[0]} checks={checks} v={v} go={go} />
          {value != null && v?.shares != null && sv?.pv_sum != null && (() => { const b = (x: number) => (Math.abs(value) >= 100 ? money(x) : rs(x)); return <section className="sec" aria-labelledby="bridge-h">
            <h2 id="bridge-h" className="label sec-label"><span>Our value, built up · <b>Rs a share</b></span></h2>
            <table className="keys">
              <tbody>
                <tr><th scope="row">Cash flows {projection!.years[0]}–{projection!.years[projection!.years.length - 1].slice(-3)}</th><td className="num">{b(sv.pv_sum / v.shares)}</td></tr>
                <tr><th scope="row">Terminal value</th><td className="num">{b(sv.pv_tv! / v.shares)}</td></tr>
                <tr><th scope="row">{v.cash + v.investments - v.borrowings >= 0 ? 'Net cash' : 'Net debt'}</th><td className="num">{b((v.cash + v.investments - v.borrowings) / v.shares)}</td></tr>
                {(sv.minority ?? 0) > 0 && <tr><th scope="row">Minority interest</th><td className="num">{b(-sv.minority! / v.shares)}</td></tr>}
                <tr className="tot"><th scope="row">Base value</th><td className="num ours">{b(value)}</td></tr>
                {price != null && <tr><th scope="row">Price {price >= value ? 'adds' : 'is short by'}</th><td className="num mkt">{b(Math.abs(price - value))}</td></tr>}
              </tbody>
            </table>
            <p className="small-note">{sv.tv_share != null && <>{pc(sv.tv_share)} of value is terminal. </>}
              <button type="button" className="link" onClick={() => go('model', 'valuation')}>Open the bridge</button></p>
          </section> })()}
        </div>
      </div>

      {nb && value != null && price != null && <Change impact={nb.impact} base={value} price={price} oursOf={oursOf} v={v!} be={be} />}

      <section className="notes" aria-labelledby="notes-h">
        <h2 id="notes-h" className="label sec-label"><span>Notes · <b>sources for the numbers above</b></span></h2>
        <ol>
          {notes.map((n, i) => (
            <li key={i} id={`fn-${i + 1}`} tabIndex={-1}>
              <span className={`kind ${n.kind === 'Computed' ? 'rule' : 'file'}`}>{n.kind}</span>{n.text}
              {n.quote && <q className="quote">{n.quote}</q>}
              {n.to && <> <button type="button" className="link" onClick={n.to}>Evidence</button></>}
            </li>
          ))}
        </ol>
      </section>

      <footer className="foot">
        <p>Analysis, not a recommendation. Built from a Export.in export and the rules in this app; no management access
          or channel checks.</p>
        <div className="key3" aria-label="How to read this note">
          <span className="s1">{value != null ? rs(value) : 'Mono'} computed by rules</span>
          <span className="s2">Written words, AI, cited</span>
          <span className="mkt">Market price</span>
          <span className="ours">Our model</span>
        </div>
      </footer>
    </>
  )
}

const sgn = (d: number) => (d === 0 ? 'as set' : `${d > 0 ? '+' : '−'}${+(Math.abs(d) * 100).toFixed(1)} pp`)

/** Every rule check as a cell: red, amber, clear, then the ones waiting for a filing. Each opens its evidence. */
function Strip({ checks, go }: { checks: RuleCheck[]; go: Go }) {
  if (!checks.length) return null
  const count = (s: RuleCheck['status']) => checks.filter(c => c.status === s).length
  const red = count('red'), amber = count('amber'), clear = count('clear'), filing = count('filing')
  return (
    <section className="annun" aria-labelledby="flags-h">
      <header>
        <h2 id="flags-h" className="label">Rule checks · <b>{red} red · {amber} amber · {clear} clear{filing ? ` · ${filing} need a filing` : ''}</b></h2>
        <p>Each cell opens its evidence. Rules light them; explanations come from the filings you attach.</p>
      </header>
      <div className="cells">
        {checks.map((c, i) => (
          <button key={c.id} type="button" className={`cell ${c.status}${c.severity === 'low' ? ' low' : ''}`} style={{ animationDelay: `${i * 30}ms` }}
            aria-label={`${SEVERITY[c.status]}${LOW(c)}: ${c.name}, ${c.fact}. Open its evidence.`} onClick={() => go('evidence', c.id)}>
            <span className="k">{c.name}</span>
            <span className="v">{c.fact}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** The forensic flags, worst first, one plain sentence each with any approved explanation (AI-written, cited); then
 * the unusual years and data issues. Each line opens its evidence. */
function Risks({ parsed, doc, go }: { parsed: Parsed; doc: ModelDoc; go: Go }) {
  const recent = parsed.years.slice(-3)
  const oneoffs = parsed.oneoffs.filter(o => recent.includes(o.year))
  const issues = parsed.checks
  const radar = parsed.forensic ?? []
  const lit = bySeverity(radar).filter(f => f.severity === 'high' || f.severity === 'medium' || f.severity === 'low')
  const waiting = radar.filter(f => f.needs && f.severity === 'not_checked')
  return (
    <section className="sec" aria-labelledby="risks-h">
      <h2 id="risks-h" className="label sec-label"><span>Risks · <b>found by rules</b></span><span>worst first</span></h2>
      {!lit.length && !oneoffs.length && !issues.length && <p className="small-note">No forensic rule lit, no unusual years and no data issues in the last three reported years.</p>}
      <ul className="risks">
        {lit.map(f => {
          const n = doc.flag_notes.find(x => x.key === f.key)
          return (
            <li key={f.key}>
              <p><span className={`sev ${f.severity}`}>{SEV[f.severity]}</span> {f.detail}</p>
              {n && <FlagNoteView note={n} />}
              <button type="button" className="link small" onClick={() => go('evidence', f.key)}
                aria-label={`${f.title}: ${n ? 'evidence' : 'evidence, and explain it'}`}>{n ? 'Evidence' : 'Evidence · explain it'}</button>
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
              {!n && <button type="button" className="link small" onClick={() => go('evidence', 'oneoffs')}
                aria-label={`Explain ${o.year} from the annual report`}>Explain it from the annual report</button>}
            </li>
          )
        })}
        {issues.length > 0 && <li><p>{issues.length} issue{issues.length > 1 ? 's' : ''} in the reported data, e.g. {issues[0]}.</p>
          <button type="button" className="link small" onClick={() => go('evidence', 'data')}>See them all</button></li>}
      </ul>
      {waiting.length > 0 && <p className="small-note">Not checked yet: {waiting.map(f => f.title.toLowerCase()).join(', ')}.{' '}
        <button type="button" className="link" onClick={() => go('evidence', 'src-ar-head')}>Attach the annual report</button></p>}
    </section>
  )
}

/** One input at a time, one step each way: grey bar = value falls, blue = value rises, from the base line. */
function Tornado({ impact, base, price, oursOf }: { impact: Impact[]; base: number; price: number | null; oursOf: (k: string) => number }) {
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

function BreakEvens({ be, price, oursOf, c3, hist, v, vi }: {
  be: NonNullable<Valuation['note']>['breakevens']; price: number; oursOf: (k: string) => number; c3: Cagr[]; hist: Row[]; v: Valuation; vi: ValInputs
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
            ? <>Ours {pc(ours)}{vi.wacc_override != null ? ' (typed)' : <>: cost of equity {pc(v.ke)} = {pc(vi.rf)} risk-free + {vi.beta} beta × {pc(vi.erp)} premium, blended with debt</>}</>
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
function KeyNumbers({ parsed, proj, next, checks, v, go }: {
  parsed: Parsed; proj: Row | null; next?: string; checks: RuleCheck[]; v: Valuation | null; go: Go
}) {
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
  const DRIVER: Record<string, string> = { growth: 'growth', ebitda_margin: 'ebitda_margin', dso: 'dso' }
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
                <th scope="row"><button type="button" className="link quiet" onClick={() => go('model', DRIVER[k.key] ?? 'statements')}>{k.label}</button></th>
                <td className="num">{f ? <span className="pen">{show(k.last, k.kind)}<svg aria-hidden="true" viewBox="0 0 100 40" preserveAspectRatio="none"><ellipse cx="50" cy="20" rx="47" ry="16" /></svg><span className="sr"> (flagged: {f.fact})</span></span> : show(k.last, k.kind)}</td>
                <td className="num dim">{show(k.typical, k.kind)}</td>
                {p && <td className="num ours">{show(nextOf[k.key] ?? null, k.kind)}</td>}
              </tr>
            )
          })}
          {pe && pe.price_last.pe != null && <tr><th scope="row"><button type="button" className="link quiet" onClick={() => go('model', 'valuation')}>P/E at price</button></th>
            <td className="num">{pe.price_last.pe.toFixed(1)}×</td><td className="num dim">{v?.multiples?.median.pe != null ? `${v.multiples.median.pe.toFixed(1)}×` : '–'}</td>
            {p && <td className="num ours">{pe.price_next.pe != null ? `${pe.price_next.pe.toFixed(1)}×` : '–'}</td>}</tr>}
        </tbody>
      </table>
      <p className="small-note">Black = reported. Grey = median of the three years before ({pe ? 'P/E: all years' : 'rules'}). Blue = our base projection. Circled = a rule check lit.</p>
    </section>
  )
}

/** Computed moves toward and away from the price, from the one-step runs and the break-evens. */
function Change({ impact, base, price, oursOf, v, be }: {
  impact: Impact[]; base: number; price: number; oursOf: (k: string) => number; v: Valuation; be: NonNullable<Valuation['note']>['breakevens']
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
        </ul>
      </div>
      <div className="down">
        <h2>What would widen it</h2>
        <ul>
          {away.map(m => <li key={m.text}><span>{m.text}: <span className="num ours">Rs {rs(m.val)}</span>.</span></li>)}
          {price > base && bear != null && <li><span>Bear case: <span className="num ours">Rs {rs(bear)}</span>.</span></li>}
          {price < base && bull != null && <li><span>Bull case: <span className="num ours">Rs {rs(bull)}</span>.</span></li>}
        </ul>
      </div>
    </section>
  )
}

