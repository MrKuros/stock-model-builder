import { useState, type ReactNode } from 'react'
import Sources, { AttachReport, TOPICS, useAi } from './Sources'
import type { Upgrade } from './Model'
import { Confirm, More, Next, PageHead } from './Shell'
import { ago, streamFetch, useMinute } from './Fetch'
import { useHref } from './route'
import {
  DOC_KINDS, api, fmt, fy, isAnnual, money, postJson, properName, rs, sourceLabel, when, type Company, type ModelDoc, type ModelSummary, type OneOffNote,
  type Parsed, type Projection, type Proposal,
} from './lib'
import { T } from './Term'

const pc = (v: number) => fmt(v, 'pct')
/** "FY2019 to FY2022, FY2024" from year labels. */
export function spans(ys: string[]) {
  const out: [string, string][] = []
  for (const y of ys) {
    const p = out.at(-1)
    if (p && +y.slice(2) === +p[1].slice(2) + 1) p[1] = y
    else out.push([y, y])
  }
  return out.map(([a, b]) => (a === b ? fy(a) : `${fy(a)}–${b.slice(-2)}`)).join(', ')
}
const LOCAL = 'local 10-yr history'
/** Where each reported year came from, in the allowed words only: [["NSE filings", "FY2023–26"], ["an Excel export", "FY2015–22"]]. */
export function yearSources(company: Company, years: string[]): [string, string][] {
  const by = new Map<string, string[]>()
  // added by ticker with no upload: the older years came from the local data source, not from a file you gave it
  // (source.from names the source at run time; it never reaches the screen)
  const local = !!company.source?.symbol && !/excel/i.test(company.source?.from ?? '')
  for (const y of years) {
    const w = company.source?.years[y], l0 = w === 'Excel export (restated)' ? 'an Excel export (restated)' : sourceLabel(w)
    const l = local && l0.startsWith('an Excel') ? LOCAL : l0
    by.set(l, [...(by.get(l) ?? []), y])
  }
  return [...by].map(([l, ys]) => [l, spans(ys)])
}

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null
  versions: ModelSummary[]; upgrades: Upgrade[]; onApply: () => void; onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
  onCompany: (p: Parsed, c: Company) => void; onDelete: () => Promise<void>
}

/** Documents: what the app has read, where every number comes from, the plumbing (filings line by line,
 * annual-report reading, the audit trail) in folds, the AI setting, and this model's file. */
export default function Documents({ parsed, doc, setDoc, projection, versions, upgrades, onApply, onProposals, onCompany, onDelete }: Props) {
  useMinute()
  const href = useHref()
  const ai = useAi()
  const { company, years } = parsed
  const s = company.source
  const short = properName(company.name).replace(/\s+(ltd\.?|limited)$/i, '').trim()
  const annual = doc.reports.filter(isAnnual), talk = doc.reports.filter(r => !isAnnual(r))
  const onReports = (f: (rs: ModelDoc['reports']) => ModelDoc['reports']) => setDoc(d => ({ ...d, reports: f(d.reports) }))
  const arRead = (y: string) => Object.keys(doc.notes).filter(k => k.startsWith('ar:') && k.endsWith(`:${y}`)).length
  const waiting = (parsed.forensic ?? []).filter(f => f.severity === 'not_checked' && f.needs).length
  const latestAr = annual.some(r => r.year === years[years.length - 1])
  const from = yearSources(company, years)
  const [gone, setGone] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  const onNse = (s?.documents ?? []).filter(d => !doc.reports.some(r => r.kind === d.kind && d.date?.startsWith(r.year.slice(2)))) // ponytail: listed, not fetched
  const status = (y: string, annualDoc: boolean) => !annualDoc ? 'Read by AI only when drafting forecast drivers'
    : arRead(y) ? `Read by AI · ${arRead(y)} note${arRead(y) > 1 ? 's' : ''} approved` : ai && !ai.available ? 'Not read yet: AI reading is off' : 'Not read yet'
  const row = (name: ReactNode, st: ReactNode, act?: ReactNode, missing?: boolean) =>
    <li className={missing ? 'missing' : undefined}><span className="d-name">{name}</span><span className="d-st">{st}</span>{act && <span className="d-act">{act}</span>}</li>

  return (
    <>
      <PageHead label="Data · Documents" title="Documents"
        purpose={<>Filings and documents read for {short}, data lineage for every number, and what each missing document would unlock.</>}
        answer={<>Built from {from.map(([l, y], i) => <span key={l}>{i > 0 && (i === from.length - 1 ? ' and ' : ', ')}{l} {y}</span>)}.{' '}
          {doc.reports.length ? `${doc.reports.length} document${doc.reports.length > 1 ? 's' : ''} attached.` : 'No documents attached yet.'}</>} />

      <section className="blk first" id="add" tabIndex={-1} aria-labelledby="docs-h">
        <h2 id="docs-h">Documents</h2>
        <ul className="doc-rows">
          {from.filter(([l]) => l.startsWith('an Excel')).map(([, y]) => row(<>Excel export, {y}</>, 'Read by rules'))}
          {from.filter(([l]) => l === LOCAL).map(([, y]) => row(<>Older years, {y}</>, 'NSE filings start FY23; earlier years from the local 10-yr history · read by rules'))}
          {s?.symbol && row(<>NSE annual results filings, {from.find(f => f[0] === 'NSE filings')?.[1] ?? 'none'}</>, 'Read by rules')}
          {doc.filings.length > 0 && row(<>Results filings kept with the model ({doc.filings.length})</>, 'Read by rules',
            <a href="#filings" onClick={() => { const d = document.getElementById('filings') as HTMLDetailsElement | null; if (d) d.open = true }}>Review</a>)}
          {[...annual, ...talk].sort((a, b) => b.year.localeCompare(a.year)).map(r => <li key={r.id}>
            <span className="d-name">{r.year} {DOC_KINDS[r.kind ?? 'annual'].toLowerCase()} <span className="small dim">{r.file} · {r.pages} pages</span></span>
            <span className="d-st">{status(r.year, isAnnual(r))}</span>
            <span className="d-act"><button type="button" className="link" aria-label={`Remove ${r.file}`} onClick={() => {
              if (window.confirm(`Remove ${r.file} from this model? What AI read from it and you approved stays.`)) onReports(rs => rs.filter(x => x.id !== r.id))
            }}>Remove</button></span></li>)}
          {!latestAr && row(<>{years[years.length - 1]} annual report</>, <>Missing: unlocks {waiting ? `${waiting} disclosure checks on Risks & forensics and ` : ''}cited flag explanations</>, undefined, true)}
          {!talk.length && row(<>Call transcripts and presentations</>, 'Missing: lets AI propose forecast drivers from management guidance, with quotes', undefined, true)}
        </ul>
        {onNse.length > 0 && <More title={<>More on NSE: annual reports, call transcripts and presentations</>} n={onNse.length}>
          <p className="small">Open one, save the PDF, then attach it below.</p>
          <ul className="doc-links">{onNse.map((d, i) => <li key={i}>
            <a href={d.url} target="_blank" rel="noreferrer">{d.kind === 'annual' ? d.title : `${d.kind === 'transcript' ? 'Call transcript' : 'Presentation'}, ${d.date ? when(d.date) : ''}`}</a></li>)}</ul>
        </More>}
        <div className="attach">
          <h3 className="h3">Attach a document</h3>
          <AttachReport years={years} ai={ai} onReports={onReports} />
          <AddYears company={company} onCompany={onCompany} />
        </div>
      </section>

      <section className="blk" id="sources" tabIndex={-1} aria-labelledby="from-h">
        <h2 id="from-h">Data lineage</h2>
        <WhereFrom parsed={parsed} doc={doc} onCompany={onCompany} />
      </section>

      <details className="fold blk" id="filings">
        <summary><span><b>Filings, line by line</b> · XBRL tag mapping{doc.filings.length ? ` · ${doc.filings.length} attached` : ''}</span></summary>
        <Sources part="filings" company={company} filings={doc.filings} proposals={doc.proposals} sources={parsed.sources}
          upgrades={upgrades} onApply={onApply} reports={doc.reports} years={years} notes={doc.notes}
          onFilings={f => setDoc(d => ({ ...d, filings: f(d.filings) }))} onProposals={onProposals} />
      </details>

      <details className="fold" id="reading">
        <summary><span><b>Annual-report reading</b> · {annual.length ? `${annual.length} attached` : 'none attached'}
          {doc.proposals.some(p => p.kind === 'ar_note' && p.status === 'proposed') ? ' · waiting for you' : ''}</span></summary>
        <Sources part="reports" company={company} filings={doc.filings} proposals={doc.proposals} sources={parsed.sources}
          upgrades={[]} onApply={onApply} reports={doc.reports} years={years} notes={doc.notes}
          onFilings={f => setDoc(d => ({ ...d, filings: f(d.filings) }))} onProposals={onProposals} />
      </details>

      <details className="fold" id="audit">
        <summary><span><b>Audit trail</b> · each claim, its source and the rule that checked it</span></summary>
        <Audit parsed={parsed} doc={doc} projection={projection} />
      </details>

      <section className="blk" id="ai" tabIndex={-1} aria-labelledby="ai-h">
        <h2 id="ai-h">AI reading and writing</h2>
        <p className="serif para">{!ai ? 'Checking…' : ai.available
          ? <><b>On.</b> AI can read the documents above, explain red flags, propose drivers and draft the research note. Every number it
            returns is a proposal, rule-checked and used only after your approval. The model never depends on it.</>
          : <><b>Off.</b> Set <code>LLM_CMD</code> to a command that reads a prompt and prints a reply (the README shows examples), then
            restart the app, to let AI read documents and draft the note. The model never depends on it.</>}</p>
      </section>

      <section className="blk" id="model" tabIndex={-1} aria-labelledby="model-h">
        <h2 id="model-h">This model</h2>
        <p>{doc.saved_at ? `Saved ${when(doc.saved_at)}` : 'Not saved yet'} · {versions.length} version{versions.length === 1 ? '' : 's'}{' '}
          (<a href={href('versions')}>Versions</a>)</p>
        <p className="d-del"><button type="button" className="btn danger-out" onClick={() => setGone(true)}>Delete {short}…</button></p>
        {delErr && <p className="error" role="alert">{delErr}</p>}
        <Confirm open={gone} onClose={() => setGone(false)} yes="Delete" title={`Delete ${short}?`}
          onYes={() => onDelete().catch(e => setDelErr(`Couldn’t delete ${short}: ${(e as Error).message}`))}
          body={<p>Its assumptions, research note, documents{versions.length > 1 ? ` and ${versions.length} versions` : ''} are deleted too. This can’t be undone.</p>} />
      </section>

      <Next lead={latestAr ? 'Each forensic check names its rule.' : 'The latest annual report unlocks disclosure checks and cited explanations.'}>
        {latestAr ? <a className="primary" href={href('risks')}>Risks & forensics</a>
          : <a className="primary" href="#add">Attach annual report</a>}
      </Next>
    </>
  )
}

/** Add years from an Excel export: to a ticker company, the export fills years the filings lack (filings still win);
 * to an export company, a newer export's years. */
function AddYears({ company, onCompany }: { company: Company; onCompany: (p: Parsed, c: Company) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const s = company.source
  const upload = async (f: File | undefined) => {
    if (!f) return
    setError(null)
    try {
      setBusy('Reading the Excel export…')
      const body = new FormData()
      body.append('file', f)
      const p = await api<Parsed>('/api/parse', { method: 'POST', body })
      if (!s?.symbol) { onCompany(p, { ...p.company, name: company.name }); return }
      setBusy('Adding the export’s years…')
      let got: Parsed | null = null
      await streamFetch({ symbol: s.symbol, company: p.company, documents: false }, new AbortController().signal, e => {
        if (e.company) got = e.company
        if (e.error) throw new Error(e.error)
      })
      const g = got as Parsed | null
      if (!g) throw new Error('The server stopped before the history was ready. Try again.')
      const c = { ...g.company, name: company.name, source: g.company.source && { ...g.company.source, from: 'your Excel export', documents: s.documents } }
      onCompany({ ...g, company: c }, c)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <p className="small add-years">
      <label className="btn file-l">{busy ?? 'Add years from an Excel export'}<input type="file" accept=".xlsx" className="sr" disabled={!!busy}
        onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} /></label>{' '}
      <span className="muted">A 10-year financials Excel export with a “Data Sheet” tab.{s?.symbol ? ' NSE filings still win where both have a year.' : ' Its years replace this file’s.'}</span>
      {error && <span className="error" role="alert"> {error}</span>}
    </p>
  )
}

/** Each year's source, what's missing, where filings and the export disagree, restatements and lease notes, data notes. */
function WhereFrom({ parsed, doc, onCompany }: { parsed: Parsed; doc: ModelDoc; onCompany: (p: Parsed, c: Company) => void }) {
  const { company, years } = parsed
  const s = company.source
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const restated = s?.restated ?? []
  const notes = (s?.notes ?? []).filter(n => !restated.some(r => n.startsWith(`${r.year} looks restated later`)))
  const fresh = parsed.restated?.changes.length ? parsed.restated : null
  const useRestated = async (year: string, use: boolean) => {
    setError(null)
    setBusy(use ? `Switching ${year} to the restated numbers…` : `Switching ${year} back…`)
    try {
      const p = await api<Parsed>('/api/restated', postJson({ company, year, use, filings: doc.filings, notes: doc.notes, excluded_years: doc.excluded_years }))
      onCompany(p, p.company)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <>
      <ul className="from-list">
        {yearSources(company, years).map(([l, y]) => <li key={l}><b>{y}</b>: {l}{l === 'NSE filings' ? ` (annual results, ${s?.basis ?? 'consolidated'}), read by rules` : ', read by rules'}.</li>)}
        {s?.missing.map(m => <li key={m} className="miss">Not available: {m}.</li>)}
        <li>CMP and share count: {doc.valuation.price != null ? 'entered by you' : s?.symbol ? `NSE, checked ${ago(s.price_at)}` : 'from the Excel export'}.</li>
      </ul>
      {(s?.mismatches.length ?? 0) > 0 && <More title="Differences between the filings and the export over 1% (the filings’ numbers are used)" n={s!.mismatches.length}>
        <div className="scroll" tabIndex={0} role="region" aria-label="Differences between filings and the export"><table className="mini-t">
          <thead><tr><th scope="col">Year</th><th scope="col">Line</th><th scope="col" className="r">Filing (Rs cr)</th><th scope="col" className="r">Export</th></tr></thead>
          <tbody>{s!.mismatches.map((m, i) => <tr key={i}><td>{m.year}</td><td>{m.line}</td>
            <td className="r num">{money(m.filing)}</td><td className="r num">{money(m.export)}</td></tr>)}</tbody>
        </table></div>
        <p className="small-note">Net profit is compared before the minority’s share on both sides. Where the export’s borrowings are higher, the
          difference is lease liabilities a filing keeps in other liabilities; they’re moved into borrowings.</p>
      </More>}
      {/* open while the model uses numbers that aren't like for like: a choice that changes the numbers isn't folded away */}
      {(restated.length > 0 || fresh) && <More id="restated" open={restated.some(r => !r.used) || !!fresh} title="Years restated later" n={restated.length + (fresh?.changes.length ?? 0)}>
        <ul className="fetch-notes restated-l">{restated.map(r => (
          <li key={r.year}><b>{r.year} {r.line}</b>: first filed <span className="num">Rs {money(r.filed)} cr</span>, restated by a later filing to{' '}
            <span className="num">Rs {money(r.restated)} cr</span>.{' '}
            {r.used ? <>The model uses the restated year, so growth into the next year is like for like.{' '}
              <button type="button" className="link" disabled={!!busy} onClick={() => useRestated(r.year, false)}>Use the first-filed numbers</button></>
              : <>The model uses the first-filed numbers, so growth and margins into the next year aren’t like for like.{' '}
                <button type="button" className="btn" disabled={!!busy} onClick={() => useRestated(r.year, true)}>Use the restated {r.year}</button></>}
          </li>))}
          {fresh?.changes.map(c => <li key={`${c.year}-${c.line}`}>{c.year} {c.line.toLowerCase()}: Rs {money(c.old)} cr in your model of{' '}
            {fresh.saved_at ? when(fresh.saved_at) : 'earlier'} → Rs {money(c.new)} cr in this file ({pc(c.new / c.old - 1)}).</li>)}
        </ul>
        {busy && <p className="small" role="status">{busy}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </More>}
      {notes.length > 0 && <More title="Notes on leases and borrowings" n={notes.length}>
        <ul className="fetch-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul></More>}
      {parsed.checks.length > 0 && <div id="data"><More open={!!parsed.share_gap} title="Data notes on the reported years" n={parsed.checks.length}>
        <ul className="check-list" id="a-data" tabIndex={-1}>{parsed.checks.map(c => <li key={c}>{c}</li>)}</ul></More></div>}
    </>
  )
}

/** One claim: what it says, its source, and the check. */
const Claim = ({ id, claim, kind, src, st, cls }: { id?: string; claim: ReactNode; kind: 'rule' | 'file' | 'ai'; src: ReactNode; st: ReactNode; cls?: string }) => (
  <div className="lg" id={id ? `a-${id}` : undefined} tabIndex={id ? -1 : undefined}>
    <div className="c">{claim}</div>
    <div className="s"><span className={`kind ${kind}`}>{kind === 'rule' ? 'Rule' : kind === 'file' ? 'File' : 'AI'}</span>{src}</div>
    <div className={`st ${cls ?? 'ok'}`}>{st}</div>
  </div>
)

/** The audit trail: each claim on the answer pages and the note, its source and the rule that checked it. */
function Audit({ parsed, doc, projection }: { parsed: Parsed; doc: ModelDoc; projection: Projection | null }) {
  const v = projection?.valuation, sv = v?.scenarios.base
  const cells = sv ? [...sv.grid.flat(), ...(sv.grid_gm ?? []).flat()].filter((x): x is number => x != null) : []
  const below = v?.price != null ? cells.filter(x => x <= v.price!).length : 0
  const rejected = doc.proposals.filter(p => p.status === 'rejected' && p.kind !== 'assumption')
  return (
    <div className="ledger">
      <div className="lg head" aria-hidden="true"><div>Claim</div><div>Source and calculation</div><div>Check</div></div>
      {sv && sv.per_share != null && sv.per_share > 0 && v && <Claim id="verdict" kind="rule"
        claim={<>Fair value: bear <span className="num">Rs {rs(v.scenarios.bear.per_share ?? NaN)}</span>, base <span className="num ours">Rs {rs(sv.per_share)}</span>,
          bull <span className="num">Rs {rs(v.scenarios.bull.per_share ?? NaN)}</span></>}
        src={<><T k="fcff" /> over {projection!.years.length} years discounted at <T k="wacc" /> <span className="num">{pc(v.wacc)}</span> (<T k="ke" /> {pc(v.ke)}, post-tax
          <T k="kd" /> {pc(v.kd_after_tax)}, {pc(v.we)} equity weight), terminal growth <span className="num">{pc(v.g)}</span>;
          equity value = EV − debt + cash + investments, over {v.shares != null ? `${money(v.shares)} cr` : 'no'} shares.</>} st="Rules ✓" />}
      {!((sv?.per_share ?? 0) > 0) && <Claim id="verdict" kind="rule" claim="No fair value" cls="wait"
        src={v?.error ?? sv?.error ?? 'No share count, or the model is still calculating.'} st="See Valuation" />}
      {sv?.implied_growth != null && <Claim kind="rule" claim={<>Reverse DCF: implied revenue growth <span className="num mkt">{pc(sv.implied_growth)}</span></>}
        src={<>Flat revenue growth in every forecast year, other drivers at base; searched from −30% to +80% in 5 pp steps, then bisected until
          base-case fair value equals CMP <span className="num mkt">Rs {rs(v!.price!)}</span>.</>} st="Rules ✓" />}
      {cells.length > 0 && v?.price != null && <Claim kind="rule" claim={<>{below} of {cells.length} sensitivity cells ≤ CMP</>}
        src="Two 5 × 5 grids of fair value per share: WACC ±1/2 pp × terminal growth, and revenue growth ±2/4 pp × EBITDA margin ±1/2 pp (each a full re-projection)." st="Rules ✓" />}
      {v?.note?.impact.length ? <Claim kind="rule" claim="Driver sensitivity and break-even levels"
        src="Each driver flexed one step down and up, others at base; break-evens solve for the flat level at which base-case fair value equals CMP." st="Rules ✓" /> : null}
      {(parsed.forensic ?? []).map(f => <Claim key={f.key} id={`audit-${f.key}`} kind="rule" claim={<>{f.title}: {f.fact}</>} src={f.rule}
        st={f.severity === 'ok' ? 'Clear' : f.severity === 'not_checked' ? 'Not tested' : 'Red flag'} cls={f.severity === 'ok' ? 'ok' : f.severity === 'not_checked' ? 'wait' : 'red'} />)}
      {doc.note && (() => {
        const tn = doc.note, stale = projection?.inputs_hash != null && projection.inputs_hash !== tn.inputs_hash
        const nq = Object.keys(tn.cites).length
        return <Claim id="thesis" kind="ai" claim="Research note: thesis, risks and monitorables"
          src={<>Written {when(tn.written_at)} by AI from {Object.keys(tn.facts).length} computed facts{nq ? ` and ${nq} approved quote${nq > 1 ? 's' : ''}` : ''}, nothing else{tn.rounds > 1 ? '; passed on the retry' : ''}.
            Rules: {tn.checks.map(c => c.name.toLowerCase()).join(', ')}.</>}
          st={stale ? 'Written for earlier inputs: rewrite' : 'Numbers tie ✓ · quotes on page ✓'} cls={stale ? 'wait' : 'ok'} />
      })()}
      {Object.entries(doc.notes).filter(([k]) => k.startsWith('oneoff:')).map(([k, x]) => {
        const n = x as OneOffNote
        return <Claim key={k} kind="ai" claim={<>Why {k.slice(7)} is an outlier</>}
          src={<><span className="serif">{n.summary}</span>{n.quote && <> <q className="quote">{n.quote}</q> {n.file}, p.{n.page}</>}</>}
          st={n.from_numbers ? 'From the numbers only' : 'Quote on page ✓ · approved'} />
      })}
      {Object.entries(doc.notes).filter(([k]) => k.startsWith('ar:')).map(([k, x]) => {
        const n = x as { topic: string; year: string; file: string | null }
        return <Claim key={k} kind="file" claim={<>{TOPICS[n.topic] ?? n.topic}, {n.year}</>} src={<>{n.file ?? 'the annual report'}, read by AI, quotes checked by rules</>} st="Approved by you" />
      })}
      {rejected.map(p => {
        const fail = p.checks.find(c => c.pass === false)
        return <Claim key={p.id} kind="ai" claim={<>{p.kind === 'mapping' ? `Mapping ${p.source.tag}` : `${p.field} ${p.period ?? ''}`}</>}
          src={p.reasoning || '–'} st={<>Rejected{fail ? `: ${fail.detail}` : ''}</>} cls="red" />
      })}
    </div>
  )
}
