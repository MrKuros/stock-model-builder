import type { ReactNode } from 'react'
import Sources, { AiOffNote, Explain, FlagExplain, useAi } from './Sources'
import type { Upgrade } from './Model'
import { PageHead, Toc } from './Shell'
import {
  DOC_KINDS, fmt, isAnnual, money, rs, when, type Forensic, type ModelDoc, type OneOff, type OneOffNote, type Parsed, type Projection, type Proposal,
  type Severity,
} from './lib'

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null
  upgrades: Upgrade[]; onApply: () => void; onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
  toggleYear: (year: string) => void; pendingYear: string | null; defaultsNote: string
}
const STATUS = { red: 'Red flag', amber: 'Amber flag', clear: 'Clear ✓', filing: 'Waiting: needs a report' } as const
const pc = (v: number) => fmt(v, 'pct')
export const SEV: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low', ok: 'Clear', not_checked: 'Not checked' }
const ORDER: Severity[] = ['high', 'medium', 'low', 'ok', 'not_checked']
/** The radar in reading order: worst first, then clear, then what couldn't run. */
export const bySeverity = (fs: Forensic[]) => [...fs].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))

/** One claim on the note: what it says, its source, and the check (a module-level component, so a focused row survives re-renders). */
const Row = ({ id, claim, kind, src, st, cls }: { id?: string; claim: ReactNode; kind: 'rule' | 'file' | 'ai'; src: ReactNode; st: ReactNode; cls?: string }) => (
  <div className="lg" id={id ? `a-${id}` : undefined} tabIndex={id ? -1 : undefined}>
    <div className="c">{claim}</div>
    <div className="s"><span className={`kind ${kind}`}>{kind === 'rule' ? 'Rule' : kind === 'file' ? 'File' : 'AI'}</span>{src}</div>
    <div className={`st ${cls ?? 'ok'}`}>{st}</div>
  </div>
)


/** What each forensic rule looks at, in plain words, shown right under its name. */
const PLAIN: Record<string, string> = {
  cash: 'How much of the reported profit arrived as cash.', cash5: 'How much of the reported profit arrived as cash.',
  dso: 'How long customers take to pay.', dio: 'How long stock sits before it is sold.',
  cwip: 'Money spent on projects that aren’t running yet.', other_income: 'How much profit comes from outside the main business.',
  tax: 'Whether the tax rate jumps around from year to year.', debt: 'Borrowings against a year of operating profit.',
  cover: 'How many times operating profit pays the interest.', nwc: 'Money tied up in running the business day to day.',
  mscore: 'Beneish M-score: a formula from eight ratios that spots signs of inflated earnings.',
  contingent: 'Possible bills not on the balance sheet, against net worth.', related: 'Dealings with group companies and insiders.',
  pledge: 'Shares the promoters have pledged against loans.', auditor: 'What the auditor said, and whether the auditor changed.',
}

/** Checks: warning signs found by rules, unusual years, the documents (attach here), and the audit trail. */
export default function Evidence({ parsed, doc, setDoc, projection, upgrades, onApply, onProposals, toggleYear, pendingYear, defaultsNote }: Props) {
  const { company, years } = parsed
  const ai = useAi()
  const v = projection?.valuation
  const sv = v?.scenarios.base
  const checks = parsed.rule_checks ?? []
  const restated = parsed.restated?.changes.length ? parsed.restated : null
  const oneoffYears = Object.entries(parsed.oneoffs.reduce<Record<string, OneOff[]>>(
    (g, o) => ({ ...g, [o.year]: [...(g[o.year] ?? []), o] }), {}))
  const decided = doc.proposals.filter(p => p.status !== 'proposed' && p.kind !== 'assumption') // assumptions: Forecast
  const annual = doc.reports.filter(isAnnual), talk = doc.reports.filter(r => !isAnnual(r))
  const onReports = (f: (rs: ModelDoc['reports']) => ModelDoc['reports']) => setDoc(d => ({ ...d, reports: f(d.reports) }))
  const nCells = sv ? [...sv.grid.flat(), ...(sv.grid_gm ?? []).flat()].filter(x => x != null).length : 0
  const below = sv && v?.price != null ? [...sv.grid.flat(), ...(sv.grid_gm ?? []).flat()].filter(x => x != null && x <= v.price!).length : 0

  return (
    <>
      <PageHead label={<>Checks · <b>rules first</b> · AI only where cited</>} title="Checks on the numbers"
        purpose={<>Fixed rules look for warning signs in the reported years. Attach an annual report or a call transcript
          below to run the rest, draft inputs and explain a flag with a quote from the filing.</>}
        next={<a className="btn" href="#documents">Add documents</a>} />
      <Toc page="checks" />
      <AiOffNote ai={ai} />
      {restated && (
        <section className="blk restated" aria-labelledby="restated-h">
          <h2 id="restated-h" className="label sec-label"><span>Restated since your model of {restated.saved_at ? when(restated.saved_at) : 'earlier'}</span></h2>
          <ul className="check-list">
            {restated.changes.map(c => <li key={`${c.year}-${c.line}`}>{c.year} {c.line.toLowerCase()}: Rs {money(c.old)} cr → Rs {money(c.new)} cr ({fmt(c.new / c.old - 1, 'pct')})</li>)}
          </ul>
          <p className="small-note">This file’s reported years differ by more than 0.5% from the model you saved; the company may
            have restated them. This model uses the new figures and keeps your filings, proposals and notes.</p>
        </section>
      )}


      {parsed.forensic && <Radar flags={parsed.forensic} doc={doc} parsed={parsed} ai={ai} onProposals={onProposals} />}

      <section className="blk" id="unusual" tabIndex={-1} aria-labelledby="oneoffs-h">
        <h2 id="oneoffs-h">Unusual years · {oneoffYears.length}</h2>
        <p className="why">Years far from this company’s own history (more than 2σ from its median). Leave one out of the defaults, or explain it from that year’s annual report.</p>
        {oneoffYears.length
          ? <OneOffs years={oneoffYears} histYears={years} excluded={doc.excluded_years} pending={pendingYear}
              note={defaultsNote} onToggle={toggleYear} explain={year => (
                <Explain year={year} company={company} filings={doc.filings} notes={doc.notes} ai={ai} proposals={doc.proposals}
                  report={annual.find(r => r.year === year)} note={doc.notes[`oneoff:${year}`] as OneOffNote | undefined}
                  onProposals={onProposals} onReports={onReports} />
              )} />
          : <p className="small-note">No year sits more than 2σ from this company’s own median on other income, tax rate, capex or EBITDA margin.</p>}
      </section>

      <section className="blk" id="documents" tabIndex={-1} aria-labelledby="docs-h">
        <h2 id="docs-h">Documents</h2>
        <p className="why">What the app has read, and what each missing document would add. Attach them in the panel below: pick the document type first.</p>
        <div className="docs">
          <div className="doc"><h3>{company.source?.symbol ? `NSE: ${company.source.symbol}` : 'Export export'}</h3><p>{company.name}, {years[0]}–{years[years.length - 1]}, read by rules
            {company.source?.symbol ? ` (${Object.values(company.source.years).filter(w => w === 'NSE filing').length} years from NSE filings; where each came from is on the Overview)` : ''}.
            {doc.saved_at ? ` Saved ${when(doc.saved_at)}.` : ''}</p></div>
          <div className={`doc${doc.filings.length ? '' : ' missing'}`}><h3>Exchange results filings <span className="term">XBRL: the machine-readable results file on NSE or BSE</span></h3>
            <p>{doc.filings.length ? `${doc.filings.length} attached; annual ones that tie to Export add payables, leases and cash-flow capex.`
              : 'Would add trade payables, lease liabilities and cash-flow capex from an annual filing.'}</p></div>
          <div className={`doc${annual.length ? '' : ' missing'}`}><h3>Annual reports</h3>
            <p>{annual.length ? annual.map(r => `${r.year} (${r.pages} pages)`).join(', ') + '.'
              : 'Would unlock the contingent-liability, related-party, promoter-pledge and auditor checks, and cited explanations.'}</p></div>
          <div className={`doc${talk.length ? '' : ' missing'}`}><h3>Call transcripts and presentations</h3>
            <p>{talk.length ? talk.map(r => `${DOC_KINDS[r.kind ?? 'annual']}, ${r.year} (${r.pages} pages)`).join('; ') + '.'
              : 'Management’s guidance on growth, margins, capex and payout: lets the app draft assumptions with quotes.'}</p></div>
        </div>
        <div className="m-sec">
          <Sources company={company} filings={doc.filings} proposals={doc.proposals} sources={parsed.sources}
            upgrades={upgrades} onApply={onApply} reports={doc.reports} years={years} notes={doc.notes}
            onReports={onReports} onFilings={f => setDoc(d => ({ ...d, filings: f(d.filings) }))} onProposals={onProposals} />
        </div>
      </section>

      <details className="blk audit" id="audit">
        <summary>Audit trail: every claim on the Overview, its source and the rule that checked it</summary>
        <div className="ledger">
          <div className="lg head" aria-hidden="true"><div>Claim</div><div>Source and calculation</div><div>Check</div></div>
          {sv?.per_share != null && v && <Row id="verdict" kind="rule"
            claim={<>Value range <span className="num">Rs {rs(v.scenarios.bear.per_share ?? NaN)} – {rs(v.scenarios.bull.per_share ?? NaN)}</span>, base <span className="num ours">Rs {rs(sv.per_share)}</span></>}
            src={<>DCF of free cash flow to firm over {projection!.years.length} years, WACC <span className="num">{pc(v.wacc)}</span> (cost of equity {pc(v.ke)}, debt {pc(v.kd_after_tax)} after tax, {pc(v.we)} equity weight), Gordon terminal value at <span className="num">{pc(v.g)}</span>; equity = EV − debt + cash + investments, over {v.shares != null ? `${money(v.shares)} cr` : 'no'} shares.</>}
            st="Deterministic ✓" />}
          {sv?.per_share == null && <Row id="verdict" kind="rule" claim="No value yet" cls="wait"
            src={v?.error ?? sv?.error ?? 'No share count, or the model is still calculating.'} st="Why: see Valuation" />}
          {sv?.implied_growth != null && <Row kind="rule" claim={<>Priced for <span className="num mkt">{pc(sv.implied_growth)}</span> revenue growth a year</>}
            src={<>Reverse DCF: flat revenue growth in every projected year, other inputs as set; scanned from −30% to +80% in 5 pp steps, then bisected to 1e-10 until base value equals the price <span className="num mkt">Rs {rs(v!.price!)}</span>.</>}
            st="Deterministic ✓" />}
          {nCells > 0 && v?.price != null && <Row kind="rule" claim={<>{below} of {nCells} sensitivity cases below the price</>}
            src="Two 5 × 5 grids of value per share: WACC ± 1/2 pp × terminal growth ± 0.5/1 pp, and revenue growth ± 2/4 pp × EBITDA margin ± 1/2 pp (each a full re-projection)."
            st="Deterministic ✓" />}
          {v?.note?.impact.length ? <Row kind="rule" claim="What moves value, break-evens and the growth scale"
            src="Each input moved one step down and up with the rest at base (same steps as the sensitivity grids); break-evens solve for the flat level where base value equals the price; the ruler's lower scale is base value at flat growth from −10% to +40%."
            st="Deterministic ✓" /> : null}
          {checks.filter(c => c.id.startsWith('oneoff-') || c.id === 'data').map(c => <Row key={c.id} id={c.id} kind="rule" claim={<>{c.name}: {c.fact}</>}
            src={c.rule} st={STATUS[c.status]} cls={c.status === 'clear' ? 'ok' : c.status === 'filing' ? 'wait' : c.status} />)}
          {doc.note && (() => {
            const tn = doc.note, stale = projection?.inputs_hash != null && projection.inputs_hash !== tn.inputs_hash
            const nq = Object.keys(tn.cites).length
            return <Row id="thesis" kind="ai" claim="Thesis, risks, triggers and what to watch"
              src={<>Written {when(tn.written_at)} by the AI command from {Object.keys(tn.facts).length} computed facts{nq ? ` and ${nq} approved quote${nq > 1 ? 's' : ''}` : ''}, nothing else{tn.rounds > 1 ? '; passed on the retry' : ''}.
                Rules: {tn.checks.map(c => c.name.toLowerCase()).join(', ')}.</>}
              st={stale ? 'Written for earlier inputs: rewrite' : 'Numbers tie ✓ · quotes on page ✓'} cls={stale ? 'wait' : 'ok'} />
          })()}
          {Object.entries(doc.notes).filter(([k]) => k.startsWith('oneoff:')).map(([k, x]) => {
            const n = x as OneOffNote
            return <Row key={k} kind="ai" claim={<>Why {k.slice(7)} was unusual</>}
              src={<><span className="serif">{n.summary}</span>{n.quote && <> <q className="quote">{n.quote}</q> {n.file}, p.{n.page}</>}</>}
              st={n.from_numbers ? 'From the numbers only' : 'Quote on page ✓ · approved'} />
          })}
          {decided.filter(p => p.status === 'rejected').map(p => {
            const fail = p.checks.find(c => c.pass === false)
            return <Row key={p.id} kind="ai" claim={<>{p.kind === 'mapping' ? `Mapping ${p.source.tag}` : `${p.field} ${p.period ?? ''}`}</>}
              src={p.reasoning || '–'} st={<>Rejected{fail ? `: ${fail.detail}` : ''}</>} cls="red" />
          })}
        </div>
      {parsed.checks.length > 0 && (
        <section className="sec" id="a-data" tabIndex={-1} aria-labelledby="data-h">
          <h2 id="data-h" className="label sec-label"><span>Data checks on the export</span><span>{parsed.checks.length} issue{parsed.checks.length > 1 ? 's' : ''}</span></h2>
          <ul className="check-list">{parsed.checks.map(c => <li key={c}>{c}</li>)}</ul>
        </section>
      )}

      </details>
    </>
  )
}

/** Flagged years as sentences, each with a switch to leave that year out of the defaults. */
function OneOffs({ years, histYears, excluded, pending, note, onToggle, explain }: {
  years: [string, OneOff[]][]; histYears: string[]; excluded: string[]; pending: string | null
  note: string; onToggle: (year: string) => void; explain: (year: string) => ReactNode
}) {
  const used = histYears.filter(y => !excluded.includes(y)).slice(-3) // mirrors default_assumptions(years=3)
  return (
    <div className="oneoffs">
      <p className="small-note">Defaults use the last three reported years that aren’t left out; revenue growth always uses the last three.</p>
      <ul>
        {years.map(([year, items]) => (
          <li key={year}>
            <span>{items.map(o => o.note).join('. ')}.</span>
            <label className="exclude">
              <input type="checkbox" checked={excluded.includes(year)} aria-disabled={pending != null}
                aria-busy={pending === year} onChange={() => onToggle(year)} />
              Exclude from defaults
            </label>
            {!used.includes(year) && !excluded.includes(year) && (
              <span className="small-note"> Older than the years the defaults use, so excluding it changes nothing.</span>
            )}
            {explain(year)}
          </li>
        ))}
      </ul>
      <p className="oneoff-note" role="status">{note}</p>
    </div>
  )
}

const M_PARTS: [string, string][] = [['DSRI', 'Receivable days index'], ['GMI', 'Gross margin index'], ['AQI', 'Asset quality index'],
  ['SGI', 'Sales growth index'], ['DEPI', 'Depreciation index'], ['SGAI', 'SG&A index'], ['LVGI', 'Leverage index'],
  ['TATA', 'Accruals / total assets']]

/** Every forensic rule: the lit ones first with their explanation; the clear ones folded away; the ones waiting on an
 * annual report together, with one attach link. */
function Radar({ flags, doc, parsed, ai, onProposals }: {
  flags: Forensic[]; doc: ModelDoc; parsed: Parsed; ai: ReturnType<typeof useAi>
  onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
}) {
  const sorted = bySeverity(flags)
  const lit = sorted.filter(f => f.severity === 'high' || f.severity === 'medium' || f.severity === 'low')
  const clear = sorted.filter(f => f.severity === 'ok')
  const waiting = sorted.filter(f => f.severity === 'not_checked')
  const n = (s: Severity) => flags.filter(f => f.severity === s).length
  const row = (f: Forensic) => {
    const on = f.severity === 'high' || f.severity === 'medium' || f.severity === 'low'
    const rule = <p className="rd-rule"><span className="kind rule">Rule</span>{f.rule}.{f.years.length > 0 && <span className="dim"> Years: {f.years.join(', ')}.</span>}</p>
    return (
      <li key={f.key} id={`a-${f.key}`} tabIndex={-1} className={`rd s-${f.severity}`} aria-labelledby={`rd-${f.key}`}>
        <div className="rd-head">
          <span className={`sev ${f.severity}`}>{SEV[f.severity]}</span>
          <h3 id={`rd-${f.key}`}>{f.title}</h3>
          <span className="num rd-fact">{f.fact}</span>
        </div>
        {PLAIN[f.key] && <p className="term">{PLAIN[f.key]}</p>}
        <p className="rd-detail">{f.detail}</p>
        {on ? rule : <details className="rd-parts"><summary>The rule</summary>{rule}</details>}
        {f.parts && <details className="rd-parts"><summary>The eight ratios, and what is approximated</summary>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="M-score ratios"><table className="keys">
            <tbody>{M_PARTS.map(([k, label]) => <tr key={k}><th scope="row">{label} <span className="dim">{k}</span></th>
              <td className="num">{f.parts![k] != null ? f.parts![k].toFixed(2) : '–'}</td></tr>)}</tbody>
          </table></div>
          {f.approx && <ul className="small-note">{f.approx.map(a => <li key={a}>{a[0].toUpperCase() + a.slice(1)}.</li>)}</ul>}</details>}
        {on && <FlagExplain flag={f} company={parsed.company} filings={doc.filings} notes={doc.notes} reports={doc.reports.filter(isAnnual)}
          proposals={doc.proposals} note={doc.flag_notes.find(x => x.key === f.key)} ai={ai} onProposals={onProposals} />}
      </li>
    )
  }
  return (
    <section className="blk" id="flags" tabIndex={-1} aria-labelledby="radar-h">
      <h2 id="radar-h">Warning signs · {n('high')} high, {n('medium')} medium, {n('low')} low</h2>
      <p className="why">Fixed thresholds for every company, from the reported years and the annual-report notes you approved.
        An explanation is words only: it never changes a number, and the rules reject one whose quote isn’t on its page or
        whose numbers the app didn’t compute.</p>
      {lit.length ? <ol className="radar">{lit.map(row)}</ol>
        : <p className="val-empty">No rule is lit: nothing in the reported years crosses a threshold.</p>}
      {clear.length > 0 && <details className="fold" id="clear">
        <summary><span><b>{clear.length} checks clear ✓</b> · {clear.map(f => f.title).join(', ')}</span></summary>
        <ol className="radar">{clear.map(row)}</ol>
      </details>}
      {waiting.length > 0 && <div className="waiting">
        <p><b>{waiting.length} not checked yet.</b>{' '}
          {waiting.some(f => f.needs) ? <>They need {waiting.some(f => f.needs === 'annual report') ? 'the annual report' : 'a filing'}.{' '}
            <a className="btn" href="#src-ar-head">Attach the annual report</a></> : 'The export lacks the years they need.'}</p>
        <ol className="radar">{waiting.map(row)}</ol>
      </div>}
    </section>
  )
}
