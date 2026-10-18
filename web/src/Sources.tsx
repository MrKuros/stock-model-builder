import { useEffect, useRef, useState } from 'react'
import type { Upgrade } from './Model'
import {
  api, dec2, DOC_KINDS, fmt, isAnnual, money, postJson, type ArNote, type DocKind, type ArValue, type Check, type Company, type Decided, type Filing,
  type FlagNote, type Forensic, type NotesPlan, type OneOffNote, type Proposal, type Report, type Sources as Used,
} from './lib'

const KIND: Record<Filing['kind'], string> = { quarter: 'Quarter', half: 'Half year', annual: 'Year', other: 'Period' }
const PER_SHARE = new Set(['eps_basic', 'eps_diluted', 'face_value'])
// ponytail: the common std keys get a proper label; the rest are humanised ("other_fin_assets_current")
const LABELS: Record<string, string> = {
  revenue: 'Revenue from operations', pat: 'Net profit (owners)', pbt: 'Profit before tax', dep: 'Depreciation',
  interest: 'Finance cost', ppe: 'Property, plant and equipment', cwip: 'Capital WIP', cfo: 'Cash from operations',
  cfi: 'Cash from investing', cff: 'Cash from financing', purchase_ppe: 'Purchase of PP&E', proceeds_ppe: 'Sale of PP&E',
  eps_basic: 'EPS, basic', eps_diluted: 'EPS, diluted', nci: 'Non-controlling interest', share_cap: 'Equity share capital',
  receivables: 'Trade receivables', payables: 'Trade payables', inventory: 'Inventories', cash: 'Cash and equivalents',
  minority: 'Minority share of profit', materials: 'Cost of materials', employee: 'Employee cost',
  other_exp: 'Other expenses', total_exp: 'Total expenses', total_income: 'Total income', tax: 'Tax expense',
}
const label = (k: string) => LABELS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ')
/** "2021-12-31" as "31 Dec 2021", read as a local date (no timezone shift). */
const day = (iso: string | null) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '–')
const title = (f: Filing) =>
  `${KIND[f.kind]} to ${day(f.period_end)}${f.consolidated == null ? '' : f.consolidated ? ' · Consolidated' : ' · Standalone'}`
/** A proposal's value: Rs crore as "Rs 4.20 cr", anything else with its unit. */
const show = (p: Proposal) => (typeof p.value !== 'number' ? (p.value == null ? '–' : String(p.value))
  : p.unit === 'Rs crore' ? `Rs ${Math.abs(p.value) >= 100 ? money(p.value) : dec2(p.value)} cr` : `${dec2(p.value)}${p.unit ? ` ${p.unit}` : ''}`)
const amount = (k: string, v: number) => (PER_SHARE.has(k) ? `Rs ${dec2(v)}` : money(v))

/** Shown once at the top of a page with AI buttons when no AI command is set; each button then just says "AI is off". */
export function AiOffNote({ ai }: { ai: AiStatus | null }) {
  if (!ai || ai.available) return null
  return (
    <details className="ai-off" id="ai-off">
      <summary><b>AI writing is off on this computer.</b> The numbers and checks still work. How to turn it on</summary>
      <p>Set <code>LLM_CMD</code> to a command that reads a prompt and prints a reply (the README shows examples), then
        restart the app. The AI buttons on this page then work.</p>
    </details>
  )
}

export interface AiStatus { available: boolean; message: string | null; pdf?: boolean; pdf_message?: string | null }
/** LLM_CMD set on the server (and pdftotext there)? Only the AI buttons need it; everything else works without. */
let aiStatus: Promise<AiStatus | null> | null = null // asked once per page load: it only changes when the server restarts
export function useAi() {
  const [ai, setAi] = useState<AiStatus | null>(null)
  useEffect(() => {
    aiStatus ??= api<AiStatus>('/api/ai').then(x => (x.available ? x : { ...x,
      message: 'AI is off (see the note at the top of this page).' }))
      .catch(() => { aiStatus = null; return null })
    let live = true
    aiStatus.then(x => { if (live) setAi(x) })
    return () => { live = false }
  }, [])
  return ai
}

/** Annual-report note topics (ai.TOPICS), in reading order. */
export const TOPICS: Record<string, string> = {
  segments: 'Segment revenue', maturity: 'Debt maturity', capex: 'Capex', contingent: 'Contingent liabilities',
  related: 'Related-party transactions', pledge: 'Promoter pledge', exceptional: 'Exceptional items', auditor: 'Auditor’s report',
}

/** doc.flag_notes from the approved flag_note proposals: one per flag (decideNote keeps one approved). */
export const withFlagNotes = (ps: Proposal[]): FlagNote[] => ps.filter(p => p.kind === 'flag_note' && p.status === 'approved')
  .map(p => ({ key: p.field, year: p.period ?? '', proposal: p.id, summary: String(p.value), file: p.source.file,
    page: p.source.page ?? null, quote: p.source.quote ?? null, from_numbers: !!p.from_numbers, ai: true }))

/** An annual-report note's headline value: money in Rs crore, a pledge in %, the auditor's opinion in words, exceptional items by their first line. */
export const arHeadline = (topic: string, v: ArValue) => (topic === 'pledge' ? `${fmt(v.total / 100, 'pct')} pledged`
  : topic === 'auditor' ? `${v.opinion ?? '–'} opinion, ${v.auditor ?? '–'}${v.changed ? ', changed' : ''}`
  : topic === 'exceptional' ? `${v.rows[0]?.label ?? '–'} Rs ${v.rows[0]?.amount != null ? money(v.rows[0].amount) : '–'} cr` // a profit and its charges: no sum
  : `Rs ${money(v.total)} cr`)

/** notes with the one-off and annual-report entries rebuilt from the approved proposals (one per year, or per topic
 * and year). The server reads "ar:capex:<year>" for the capex history, so the two must never disagree. */
export function withNotes(notes: Record<string, unknown>, ps: Proposal[]): Record<string, unknown> {
  const out = Object.fromEntries(Object.entries(notes).filter(([k]) => !k.startsWith('oneoff:') && !k.startsWith('ar:')))
  for (const p of ps) {
    if (p.status !== 'approved') continue
    if (p.kind === 'oneoff_note') {
      out[`oneoff:${p.period}`] = {
        proposal: p.id, summary: String(p.value), file: p.source.file, page: p.source.page ?? null,
        quote: p.source.quote ?? null, from_numbers: !!p.from_numbers, ai: true,
      } satisfies OneOffNote
    } else if (p.kind === 'ar_note') {
      out[`ar:${p.field}:${p.period}`] = {
        ...(p.value as ArValue), proposal: p.id, topic: p.field, year: p.period ?? '', file: p.source.file, ai: true,
      } satisfies ArNote
    }
  }
  return out
}

/** A note decided (approving a one-off note just pins it). One approved note per year (and topic): the one it
 * replaces is set to rejected, kept for the record and never asked about again. */
export const decideNote = (ps: Proposal[], p: Proposal, status: Proposal['status']) => ps.map(x => (x.id === p.id
  ? { ...x, status } : status === 'approved' && x.kind === p.kind && x.field === p.field && x.period === p.period
    && x.status === 'approved' ? { ...x, status: 'rejected' as const } : x))

/** A new proposal joins the list; one with the same id already there (decided or not) is kept as it is. */
const addProposal = (ps: Proposal[], p: Proposal) => (ps.some(x => x.id === p.id) ? ps : [...ps, p])

export function Checks({ checks }: { checks: Check[] }) {
  if (!checks.length) return null
  return (
    <ul className="src-checks">
      {checks.map((c, i) => {
        const cls = c.pass == null ? 'is-note' : c.pass ? 'is-pass' : 'is-fail'
        return (
          <li key={i} className={cls}>
            <span aria-hidden="true" className="src-mark">{c.pass == null ? '–' : c.pass ? '✓' : '✗'}</span>
            <span className="visually-hidden">{c.pass == null ? 'Note: ' : c.pass ? 'Passed: ' : 'Failed: '}</span>
            <b>{c.name}.</b> {c.detail}
          </li>
        )
      })}
    </ul>
  )
}

interface Props {
  company: Company
  filings: Filing[]
  proposals: Proposal[]
  onFilings: (f: (fs: Filing[]) => Filing[]) => void
  onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
  sources?: Used // what the filings add to the model (missing on an old server)
  upgrades: Upgrade[] // defaults the last filing change moved
  onApply: () => void // use them in all three scenarios
  reports: Report[] // annual reports (attached here, or from the unusual-years panel)
  onReports: (f: (rs: Report[]) => Report[]) => void
  years: string[] // reported years, for the report's year
  notes: Record<string, unknown> // approved notes ("ar:segments:FY2021"...)
}

/** Exchange filings attached to the model, read by fixed rules, and AI proposals waiting for a decision. */
export default function Sources({
  company, filings, proposals, onFilings, onProposals, sources, upgrades, onApply, reports, onReports, years, notes,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [over, setOver] = useState(false)
  const [asking, setAsking] = useState<string | null>(null) // the filing whose tags are with the model
  const head = useRef<HTMLHeadingElement>(null)
  const ai = useAi()

  const attach = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(`Reading ${file.name}…`)
    setError(null)
    setNote('')
    const body = new FormData()
    body.append('file', file)
    body.append('company', JSON.stringify(company))
    try {
      const f = await api<Filing>('/api/xbrl', { method: 'POST', body })
      const again = filings.some(x => x.id === f.id)
      onFilings(fs => [...fs.filter(x => x.id !== f.id), f])
      const failed = f.checks.filter(c => c.pass === false).length
      const ties = f.checks.filter(c => c.pass === false && c.name.endsWith('matches the export')).length
      setNote(`${again ? 'Read again' : 'Attached'}: ${title(f)}. ${Object.keys(f.facts).length} lines mapped, ` +
        `${f.unmapped.length} unmapped${failed ? `, ${failed} check${failed > 1 ? 's' : ''} failed` : ''}.` +
        (ties > 1 ? ` Revenue and profit don’t match the export’s${f.company ? ` (the filing is ${f.company})` : ''}; ` +
          'check it is the same company and basis.' : ''))
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const remove = (f: Filing) => {
    if (!window.confirm(`Remove the filing ${f.file} (${title(f)}) from this model?`)) return
    onFilings(fs => fs.filter(x => x.id !== f.id))
    setNote(`Removed ${f.file}.`)
    head.current?.focus() // its Remove button is gone
  }
  /** The LLM proposes a std key per unmapped tag; the server's rules check each one. New ones join the list; a
   * proposal already decided keeps its decision. */
  const propose = async (f: Filing) => {
    if (busy) return
    setBusy(`Asking the model about ${f.unmapped.length} tags in ${f.file}…`)
    setAsking(f.id)
    setError(null)
    setNote('')
    try {
      const r = await api<{ proposals: Proposal[]; left: string[] }>('/api/mappings/propose', postJson({ filing: f }))
      onProposals(ps => [...ps, ...r.proposals.filter(p => !ps.some(x => x.id === p.id))])
      const ok = r.proposals.filter(p => !p.checks.some(c => c.pass === false)).length
      setNote(`${r.proposals.length} mapping${r.proposals.length === 1 ? '' : 's'} proposed for ${f.file}` +
        `${r.proposals.length ? ` (${ok} pass${ok === 1 ? 'es' : ''} the checks)` : ''}; ` +
        `${r.left.length} tag${r.left.length === 1 ? '' : 's'} left unmapped. Nothing is used until you approve it.`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null); setAsking(null) }
  }
  const decide = async (p: Proposal, status: Proposal['status']) => {
    if (p.kind === 'ar_note' && status === 'approved') {
      if (busy) return
      setBusy('Checking the note against the report again…')
      setError(null)
      setNote('')
      try {
        const report = reports.find(r => r.id === p.report)
        const r = await api<Proposal>('/api/notes/approve', postJson({ company, filings, report, proposal: p }))
        onProposals(ps => decideNote(ps.map(x => (x.id === p.id ? r : x)), r, 'approved'))
        setNote(`Approved: ${TOPICS[p.field] ?? p.field} ${p.period}, from ${p.source.file}.` +
          (p.field !== 'capex' ? '' : sources?.used.capex.includes(p.period ?? '')
            ? ' The XBRL cash flow already gives that year’s capex, and the two agree.'
            : ' It is now that year’s capex in the model’s history.'))
      } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
      return
    }
    if (p.kind !== 'mapping') {
      onProposals(ps => decideNote(ps, p, status))
      return setNote(status === 'approved' ? `Pinned the explanation of ${p.period}.` : 'Rejected; kept here for the record.'
        + (p.kind === 'ar_note' && p.field === 'capex' && p.status === 'approved' ? ' The capex history is back to before.' : ''))
    }
    if (busy) return
    setBusy(status === 'approved' ? 'Saving the mapping and reading the filings again…' : 'Saving…')
    setError(null)
    setNote('')
    try {
      const r = await api<Decided>(`/api/mappings/${status === 'approved' ? 'approve' : 'reject'}`,
        postJson({ proposal: p, filings, company }))
      onProposals(ps => ps.map(x => (x.id === p.id ? r.proposal : x)))
      onFilings(fs => fs.map(x => r.filings.find(y => y.id === x.id) ?? x))
      const tag = p.source.tag
      setNote(status === 'approved'
        ? `Saved: ${tag} is now read as ${label(p.field).toLowerCase()} in every filing, with no AI call.` +
          (r.missing.length ? ` Attach ${r.missing.join(', ')} again to apply it there.` : '')
        : p.status === 'approved' ? `Taken back: ${tag} is unmapped again.` : `Rejected; kept here for the record.`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const sorted = [...filings].sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''))
  const apply = () => {
    onApply()
    setNote('New defaults applied to base, bull and bear.')
    head.current?.focus() // the button is gone
  }
  const d = sources?.drivers ?? {}
  const used = sources ? [sources.used.payables.length > 0 && d.dpo, d.ol_pct, d.lease,
    (sources.used.capex.length > 0 || (sources.used.capex_ar?.length ?? 0) > 0) && d.capex_pct].filter((x): x is string => !!x) : []
  const arNotes = Object.entries(notes).filter(([k]) => k.startsWith('ar:')).map(([, v]) => v as ArNote)
    .sort((a, b) => b.year.localeCompare(a.year) || Object.keys(TOPICS).indexOf(a.topic) - Object.keys(TOPICS).indexOf(b.topic))

  return (
    <section className="sources" aria-labelledby="src-head">
      <div className="val-top"><h2 id="src-head" ref={head} tabIndex={-1}>Filings and AI proposals</h2></div>
      <p className="muted small">
        Results filings from the exchanges, read by fixed rules and checked against the export’s figures. An annual
        filing whose revenue matches the export’s adds that year’s trade payables, lease liabilities and cash-flow capex
        to the model; the totals don’t move. Other filings are kept for reference.
      </p>
      <label className={`drop drop-small ${over ? 'is-over' : ''}`} aria-busy={!!busy}
        onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); attach(e.dataTransfer.files[0]) }}>
        <input type="file" accept=".xml,text/xml,application/xml" className="visually-hidden" disabled={!!busy}
          onChange={e => { attach(e.target.files?.[0]); e.target.value = '' }} />
        <span className="drop-title">{busy ?? 'Attach an XBRL results filing'}</span>
        {!busy && <span className="drop-sub">Drop it here or <u>choose a file</u> (.xml from NSE or BSE)</span>}
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="src-note" role="status">{note}</p>
      <div aria-live="polite">
        {upgrades.length > 0 && (
          <div className="src-upgrade">
            <p className="small">
              The filings and approved notes moved these defaults:{' '}
              {upgrades.map((u, i) => <span key={u.key}>{i > 0 && '; '}{u.label.toLowerCase()} now{' '}
                <span className="pencil-num">{fmt(u.to, u.kind)}</span> (base uses {fmt(u.from, u.kind)})</span>)}.
              Your assumptions haven’t changed.
            </p>
            <button type="button" onClick={apply}>Use the new defaults in base, bull and bear</button>
          </div>
        )}
      </div>
      {(used.length > 0 || (sources?.notes.length ?? 0) > 0) && (
        <section className="src-used" aria-labelledby="src-used-head">
          <h3 id="src-used-head" className="src-sub">In the model from filings</h3>
          <ul className="src-checks">
            {used.map(t => <li key={t} className="is-pass"><span aria-hidden="true" className="src-mark">✓</span>{t}.</li>)}
            {sources?.notes.map(t => (
              <li key={t} className="is-note"><span aria-hidden="true" className="src-mark">–</span>
                <span className="visually-hidden">Not used: </span>{t}</li>
            ))}
          </ul>
        </section>
      )}

      {sorted.length > 0 && (
        <ul className="src-list" aria-label="Filings">
          {sorted.map(f => {
            const facts = Object.entries(f.facts)
            return (
              <li key={f.id} className="src-item">
                <div className="src-head">
                  <h3>{title(f)}</h3>
                  <button type="button" className="link lib-del" onClick={() => remove(f)}
                    aria-label={`Remove filing ${f.file}, ${title(f)}`}>Remove</button>
                </div>
                <p className="muted small src-meta">
                  {f.file}{f.company && <> · {f.company}</>} · {facts.length} lines mapped · {f.unmapped.length} unmapped
                </p>
                {f.unmapped.length > 0 && (
                  <div className="prop-ask">
                    <button type="button" onClick={() => propose(f)} disabled={!ai?.available} aria-disabled={!!busy}
                      aria-describedby={ai && !ai.available ? `ai-off-${f.id}` : undefined}>Propose mappings</button>
                    <span className="muted small" id={`ai-off-${f.id}`} aria-busy={asking === f.id}>
                      {asking === f.id ? busy : ai && !ai.available ? ai.message
                        : 'AI suggests a line for each unmapped tag; rules check it and you approve it.'}
                    </span>
                  </div>
                )}
                <Checks checks={f.checks} />
                {facts.length > 0 && (
                  <details>
                    <summary>Mapped lines ({facts.length})</summary>
                    <div className="table-wrap src-wrap" tabIndex={0} role="region" aria-label={`Mapped lines, ${f.file}`}>
                      <table className="src-table">
                        <thead><tr><th scope="col">Line</th><th scope="col">Rs crore</th></tr></thead>
                        <tbody>{facts.map(([k, v]) => <tr key={k}><th scope="row">{label(k)}</th><td>{amount(k, v)}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </details>
                )}
                {f.unmapped.length > 0 && (
                  <details>
                    <summary>Unmapped tags ({f.unmapped.length})</summary>
                    <div className="table-wrap src-wrap" tabIndex={0} role="region" aria-label={`Unmapped tags, ${f.file}`}>
                      <table className="src-table">
                        <thead><tr><th scope="col">XBRL tag</th><th scope="col">Value</th><th scope="col">Context</th></tr></thead>
                        <tbody>{f.unmapped.map((u, i) => (
                          <tr key={i}><th scope="row" className="src-tag">{u.tag}</th><td>{dec2(u.value)}</td><td>{u.context}</td></tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <section className="src-reports" aria-labelledby="src-ar-head">
        <h3 id="src-ar-head" className="src-sub" tabIndex={-1}>Annual reports, call transcripts and presentations</h3>
        <p className="muted small">
          An annual report’s notes: segment revenue, debt maturity, capex, contingent liabilities and related-party
          transactions. Rules pick a few pages per topic, AI reads them and quotes each figure, rules check the quotes
          and tie the sums to the statements, and you approve. An approved capex figure becomes that year’s capex.
          Transcripts and presentations are read only when you draft assumptions (Forecast page).
        </p>
        <AttachReport years={years} ai={ai} onReports={onReports} />
        {reports.length > 0 && (
          <ul className="src-list" aria-label="Attached documents">
            {[...reports].sort((a, b) => b.year.localeCompare(a.year)).map(r => (
              <li key={r.id} className="src-item">
                <div className="src-head">
                  <h4>{r.year} {DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}</h4>
                  <button type="button" className="link lib-del" aria-label={`Remove ${r.file}, ${r.year} ${DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}`}
                    onClick={() => {
                      if (!window.confirm(`Remove ${r.file} from this model? Its proposals and approved notes stay.`)) return
                      onReports(rs => rs.filter(x => x.id !== r.id))
                      head.current?.focus()
                    }}>Remove</button>
                </div>
                <p className="muted small src-meta">{r.file} · {r.pages} pages · read by pdftotext; only the pages rules pick go to the model</p>
                {years.includes(r.year) && isAnnual(r) && <ReadNotes report={r} company={company} filings={filings} ai={ai}
                  onProposals={onProposals} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      {arNotes.length > 0 && (
        <section className="src-notes" aria-labelledby="src-notes-head">
          <h3 id="src-notes-head" className="src-sub">From the annual reports</h3>
          <p className="muted small"><span className="prop-ai">AI-read</span>, checked by rules and approved by you. Rs crore.</p>
          {arNotes.map(n => <ArNoteView key={`${n.topic}:${n.year}`} n={n} sources={sources} />)}
        </section>
      )}

      {proposals.length > 0 && (
        <>
          <h3 className="src-sub">Proposals</h3>
          <ul className="src-list" aria-label="Proposals">
            {proposals.map(p => <ProposalItem key={p.id} p={p} busy={!!busy} onDecide={decide} />)}
          </ul>
        </>
      )}
    </section>
  )
}

const PROP_STATUS: Record<Proposal['status'], string> = { proposed: 'Waiting for you', approved: 'Approved', rejected: 'Rejected' }

/** One proposal: what was read, where from, the rule checks, and the decision. */
export function ProposalItem({ p, busy, onDecide, as: H = 'h4', title }: {
  p: Proposal; busy: boolean; onDecide: (p: Proposal, s: Proposal['status']) => void; as?: 'h4' | 'h5'
  title?: string // a flag note: the flag's name
}) {
  const flag = p.kind === 'flag_note'
  const note = p.kind === 'oneoff_note' || flag
  const ar = p.kind === 'ar_note' ? p.value as ArValue : null
  // the source, value and status make each button's name unique among same-year proposals kept for the record
  const what = (note ? `the explanation of ${flag ? `the ${title ?? p.field} flag` : p.period}, ${p.from_numbers ? 'from the numbers'
    : `from ${p.source.file} page ${p.source.page}`}` : ar ? `${TOPICS[p.field] ?? p.field} ${p.period}, ${arHeadline(p.field, ar)}, ${p.source.file}`
    : `${p.source.tag ?? label(p.field)} as ${label(p.field)}, ${p.source.file}`)
    + (p.status === 'proposed' ? '' : `, ${PROP_STATUS[p.status].toLowerCase()}`)
  return (
    <li className={`src-item prop is-${p.status}`}>
      <div className="src-head">
        <H>{flag ? <>Why the {(title ?? p.field).toLowerCase()} flag lit</> : note ? <>Why {p.period} was unusual</> : ar ? <>{TOPICS[p.field] ?? p.field} · {p.period}:{' '}
          <span className="prop-value">{arHeadline(p.field, ar)}</span></> : <>{label(p.field)}{p.period && <> · {/^\d{4}-\d\d-\d\d$/.test(p.period)
          ? day(p.period) : p.period}</>}: <span className="prop-value">{show(p)}</span></>}</H>
        <span className="prop-status">{PROP_STATUS[p.status]}</span>
      </div>
      <p className="muted small src-meta">
        {p.ai && <span className="prop-ai">{p.kind === 'mapping' ? 'AI-proposed' : note ? 'AI-written' : 'AI-read'} · </span>}
        {p.from_numbers ? 'From the numbers only, no filing read' : p.source.file}
        {ar ? p.pages && <>, PDF pages sent {p.pages.join(', ')}</> : p.source.page != null && <>, PDF page {p.source.page}</>}
        {p.source.tag && <>, tag {p.source.tag}</>}
      </p>
      {note && <p className="prop-summary">{String(p.value)}</p>}
      {ar ? <ArRows v={ar} pct={p.field === 'pledge'} caption={`${TOPICS[p.field] ?? p.field}, ${p.period}, as read`} />
        : p.source.quote && <blockquote className="prop-quote">“{p.source.quote}”</blockquote>}
      {p.reasoning && <p className="small">{note ? <span className="muted">Flagged: </span>
        : p.ai && !ar && <span className="muted">AI’s reasoning: </span>}{p.reasoning}</p>}
      <Checks checks={p.checks} />
      <div className="prop-actions">
        <button type="button" aria-pressed={p.status === 'approved'} onClick={() => onDecide(p, 'approved')}
          disabled={p.checks.some(c => c.pass === false)} aria-disabled={busy}
          aria-label={`${note ? 'Pin' : 'Approve'} ${what}`}>{note ? 'Approve and pin' : 'Approve'}</button>
        <button type="button" aria-pressed={p.status === 'rejected'} onClick={() => onDecide(p, 'rejected')}
          aria-disabled={busy} aria-label={`Reject ${what}`}>Reject</button>
      </div>
    </li>
  )
}

/** The values of an annual-report note as read: label, Rs crore, PDF page and the quote it was checked against. */
function ArRows({ v, caption, pct }: { v: ArValue; caption: string; pct?: boolean }) {
  const words = v.rows.every(r => r.amount == null) // the auditor's report: quotes only
  return (
    <div className="table-wrap src-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="src-table ar-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead><tr><th scope="col">Item</th>{!words && <th scope="col">{pct ? '%' : 'Rs crore'}</th>}<th scope="col">Page</th><th scope="col">Quote</th></tr></thead>
        <tbody>{v.rows.map((r, i) => (
          <tr key={i}><th scope="row">{r.label}</th>{!words && <td>{pct ? dec2(r.amount ?? NaN) : money(r.amount)}</td>}<td>{r.page}</td>
            <td className="ar-quote">“{r.quote}”</td></tr>
        ))}</tbody>
      </table>
    </div>
  )
}

const pct = (a: number, b: number | undefined) => (b ? `${(100 * a / b).toFixed(1)}%` : '–')

/** An approved annual-report note, drawn for its topic: segment mix, maturity ladder, claims vs net worth... */
function ArNoteView({ n, sources }: { n: ArNote; sources?: Used }) {
  const title = TOPICS[n.topic] ?? n.topic
  const rows = n.rows.filter(r => r.amount != null) as (ArNote['rows'][number] & { amount: number })[]
  const max = Math.max(...rows.map(r => Math.abs(r.amount)), 1)
  const cite = (r: { page: number; quote: string }) => <span className="muted">p. {r.page}<span className="visually-hidden">: {r.quote}</span></span>
  const id = `arn-${n.topic}-${n.year}`
  return (
    <article className="ar-note" aria-labelledby={id}>
      <h4 id={id}>{title} · {n.year} <span className="muted small">{n.file}</span></h4>
      {n.topic === 'segments' && <>
        <div className="seg-bar" role="img" aria-label={`Segment mix ${n.year}: ${rows.map(r => `${r.label} ${pct(r.amount, n.total)}`).join(', ')}`}>
          {rows.map((r, i) => <span key={i} style={{ flexGrow: Math.max(r.amount, 0), opacity: 1 - (i % 4) * 0.2 }} title={`${r.label} ${pct(r.amount, n.total)}`} />)}
        </div>
        <div className="table-wrap src-wrap" tabIndex={0} role="region" aria-label={`Segment revenue, ${n.year}`}><table className="src-table ar-table">
          <thead><tr><th scope="col">Segment</th><th scope="col">Rs crore</th><th scope="col">Share</th><th scope="col">Source</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><th scope="row">{r.label}</th><td>{money(r.amount)}</td><td>{pct(r.amount, n.total)}</td><td>{cite(r)}</td></tr>)}</tbody>
        </table></div>
      </>}
      {n.topic === 'maturity' && (
        <ul className="ladder" aria-label={`Debt due by period, ${n.year}`}>
          {rows.map((r, i) => (
            <li key={i}><span className="ladder-label">{r.label}</span>
              <span className="ladder-bar" aria-hidden="true"><span style={{ width: `${(100 * r.amount) / max}%` }} /></span>
              <span className="ladder-num">{money(r.amount)}</span> {cite(r)}</li>
          ))}
        </ul>
      )}
      {(n.topic === 'contingent' || n.topic === 'related') && (
        <div className="table-wrap src-wrap" tabIndex={0} role="region" aria-label={`${title}, ${n.year}`}><table className="src-table ar-table">
          <thead><tr><th scope="col">{n.topic === 'related' ? 'Party and nature' : 'Claim'}</th><th scope="col">Rs crore</th>
            <th scope="col">Share of {n.against?.label.toLowerCase() ?? '–'}</th><th scope="col">Source</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><th scope="row">{r.label}</th><td>{money(r.amount)}</td>
            <td>{pct(r.amount, n.against?.value)}</td><td>{cite(r)}</td></tr>)}</tbody>
        </table></div>
      )}
      {(n.topic === 'pledge' || n.topic === 'auditor') ? <>
        <p className="small ar-sum">{n.topic === 'pledge'
          ? <><b>{fmt(n.total / 100, 'pct')}</b> of promoter shares pledged or encumbered.</>
          : <>{n.auditor}: <b>{n.opinion}</b> opinion{n.changed ? '; the auditor changed this year' : ''}.</>}</p>
        <ArRows v={n} pct={n.topic === 'pledge'} caption={`${title}, ${n.year}, quotes`} />
      </> : <p className="small ar-sum">
        Total Rs {money(n.total)} cr
        {n.against && <>{n.topic === 'contingent' ? ', ' : ' vs '}{n.topic === 'contingent'
          ? <><b>{pct(n.total, n.against.value)}</b> of net worth (Rs {money(n.against.value)} cr)</>
          : n.topic === 'related' ? <>{pct(n.total, n.against.value)} of revenue</>
          : <>{n.against.label} Rs {money(n.against.value)} cr</>}</>}.
        {n.topic === 'capex' && (sources?.used.capex.includes(n.year)
          ? ' The XBRL cash flow for this year is used in the model (they agree).'
          : sources?.used.capex_ar?.includes(n.year) ? ` Used as ${n.year} capex in the model’s history.` : '')}
      </p>}
    </article>
  )
}

/** Attach a PDF (annual report, call transcript or investor presentation) for one of the reported years; its page text
 * stays on the server. One of each kind per year: a second replaces the first. */
function AttachReport({ years, ai, onReports }: {
  years: string[]; ai: AiStatus | null; onReports: (f: (rs: Report[]) => Report[]) => void
}) {
  const [year, setYear] = useState(years[years.length - 1])
  const [kind, setKind] = useState<DocKind>('annual')
  const what = DOC_KINDS[kind].toLowerCase()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  const attach = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(`Reading ${file.name}…`)
    setMsg(null)
    const body = new FormData()
    body.append('file', file)
    body.append('year', year)
    body.append('kind', kind)
    try {
      const r = await api<Report>('/api/report', { method: 'POST', body })
      onReports(rs => [...rs.filter(x => !(x.year === year && (x.kind ?? 'annual') === kind) && x.id !== r.id), r])
      setMsg({ text: `Attached ${r.file} (${r.pages} pages) as the ${year} ${what}.` })
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }) } finally { setBusy(null) }
  }
  const off = !!busy || ai?.pdf === false
  return (
    <>
      <div className="prop-ask">
        <label className="ar-year">Document{' '}
          <select value={kind} onChange={e => setKind(e.target.value as DocKind)} disabled={!!busy}>
            {Object.entries(DOC_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="ar-year">{kind === 'annual' ? 'Year' : 'Latest year it follows'}{' '}
          <select value={year} onChange={e => setYear(e.target.value)} disabled={!!busy}>
            {[...years].reverse().map(y => <option key={y}>{y}</option>)}
          </select>
        </label>
        <label className={`file-btn ${off ? 'is-off' : ''}`}>
          <input type="file" accept=".pdf,application/pdf" className="visually-hidden" disabled={off}
            onChange={e => { attach(e.target.files?.[0]); e.target.value = '' }} />
          Attach the {year} {what} (PDF)
        </label>
        <span className="muted small" aria-busy={!!busy}>{busy ?? (ai?.pdf === false ? ai.pdf_message : '')}</span>
      </div>
      <p className={`src-note ${msg?.bad ? 'is-bad' : ''}`} role="status">{msg?.text}</p>
    </>
  )
}

const tokens = (chars: number) => Math.round(chars / 4 / 100) * 100 // ponytail: ~4 characters a token for English text

/** Per report: the pages rules would send per topic and the prompt size, shown before anything is sent; then one
 * call per chosen topic. Each answer comes back as a proposal already checked by rules. */
function ReadNotes({ report, company, filings, ai, onProposals }: {
  report: Report; company: Company; filings: Filing[]; ai: AiStatus | null
  onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
}) {
  const [plan, setPlan] = useState<NotesPlan | null>(null)
  const [pick, setPick] = useState<string[]>(Object.keys(TOPICS))
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  useEffect(() => {
    api<NotesPlan>('/api/notes/plan', postJson({ company, report }))
      .then(setPlan).catch(e => setMsg({ text: (e as Error).message, bad: true }))
  }, [report.id, report.year]) // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = plan ? pick.filter(t => plan.topics[t]?.pages.length) : []
  const pages = chosen.reduce((s, t) => s + plan!.topics[t].pages.length, 0)
  const chars = chosen.reduce((s, t) => s + plan!.topics[t].chars, 0)
  const read = async () => {
    if (busy || !chosen.length) return
    setMsg(null)
    const done: string[] = [], bad: string[] = []
    for (const [i, t] of chosen.entries()) {
      setBusy(`Reading ${TOPICS[t].toLowerCase()} (${i + 1} of ${chosen.length})…`)
      try {
        const p = await api<Proposal>('/api/notes/extract', postJson({ company, filings, report, topic: t }))
        onProposals(ps => addProposal(ps, p))
        done.push(`${TOPICS[t]}${p.status === 'rejected' ? ' (rejected by the rules)' : ''}`)
      } catch (e) { bad.push(`${TOPICS[t]}: ${(e as Error).message}`) }
    }
    setBusy(null)
    setMsg({ text: [done.length ? `Read ${done.join(', ')}. Check them under Proposals; nothing is used until you approve it.` : '',
      ...bad].filter(Boolean).join(' '), bad: !done.length })
  }
  const id = `notes-${report.id}`
  return (
    <div className="read-notes">
      {plan && (
        <fieldset className="ar-topics" disabled={!!busy}>
          <legend className="small">Topics to read</legend>
          {Object.entries(TOPICS).map(([t, title]) => {
            const x = plan.topics[t]
            return (
              <label key={t} className="small">
                <input type="checkbox" checked={pick.includes(t)} disabled={!x?.pages.length}
                  onChange={e => setPick(p => (e.target.checked ? [...p, t] : p.filter(y => y !== t)))} />{' '}
                {title} <span className="muted">{x?.pages.length ? `PDF p. ${x.pages.join(', ')} · ${x.chars.toLocaleString('en-IN')} characters`
                  : 'no page found'}</span>
              </label>
            )
          })}
        </fieldset>
      )}
      <div className="prop-ask">
        <button type="button" onClick={read} disabled={!ai?.available || !chosen.length} aria-disabled={!!busy}
          aria-describedby={id}>Read the notes with AI</button>
        <span className="muted small" id={id} aria-busy={!!busy}>
          {busy ?? (!ai?.available ? ai?.message ?? 'The AI status is unknown; is the server running?'
            : plan ? `Sends ${pages} page${pages === 1 ? '' : 's'}, ${chars.toLocaleString('en-IN')} characters (roughly ` +
              `${tokens(chars).toLocaleString('en-IN')} tokens) in ${chosen.length} call${chosen.length === 1 ? '' : 's'}.` : 'Finding the pages…')}
        </span>
      </div>
      <p className={`src-note ${msg?.bad ? 'is-bad' : ''}`} role="status">{msg?.text}</p>
    </div>
  )
}

/** Next to a flagged year: explain it in words, from that year's annual report (rules pick the pages and check the
 * quote) or from the numbers only. The result is a proposal; approving it pins the words, no number uses them. */
export function Explain({ year, company, filings, notes, report, proposals, note, ai, onProposals, onReports }: {
  year: string; company: Company; filings: Filing[]; notes: Record<string, unknown>; report?: Report; proposals: Proposal[]; note?: OneOffNote
  ai: AiStatus | null; onProposals: (f: (ps: Proposal[]) => Proposal[]) => void; onReports: (f: (rs: Report[]) => Report[]) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  const id = `explain-${year.replace(/\W+/g, '-')}`
  const noteRef = useRef<HTMLParagraphElement>(null)
  const askRef = useRef<HTMLDivElement>(null)
  // the waiting proposal disappears once decided: keep keyboard focus nearby (the pinned note, or the Explain button)
  const decided = (p: Proposal, s: Proposal['status']) => {
    onProposals(ps => decideNote(ps, p, s))
    setMsg({ text: s === 'approved' ? `Pinned the explanation of ${year}.` : 'Rejected; kept in the filings and AI proposals list for the record.' })
    setTimeout(() => (s === 'approved' ? noteRef.current : askRef.current?.querySelector('button'))?.focus())
  }
  const live = proposals.filter(p => p.kind === 'oneoff_note' && p.period === year && p.status === 'proposed').slice(-1)[0]

  const attach = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(`Reading ${file.name}…`)
    setMsg(null)
    const body = new FormData()
    body.append('file', file)
    body.append('year', year)
    try {
      const r = await api<Report>('/api/report', { method: 'POST', body })
      onReports(rs => [...rs.filter(x => !(x.year === year && isAnnual(x))), r])
      setMsg({ text: `Attached ${r.file} (${r.pages} pages) as the ${year} annual report.` })
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }) } finally { setBusy(null) }
  }
  const explain = async (from: Report | null) => {
    if (busy) return
    setBusy(from ? `Finding the pages about ${year} in ${from.file} and asking the model…` : 'Asking the model…')
    setMsg(null)
    try {
      const p = await api<Proposal>('/api/oneoffs/explain', postJson({ company, filings, notes, year, report: from }))
      const seen = proposals.find(x => x.id === p.id)
      onProposals(ps => addProposal(ps, p))
      const failed = p.checks.filter(c => c.pass === false)
      setMsg(seen ? { text: `The same explanation as before (${PROP_STATUS[seen.status].toLowerCase()}); it’s already in the filings and AI proposals list.` }
        : p.status === 'rejected'
        ? { text: `The rules rejected the explanation: ${failed.map(c => c.detail).join(' ')} It’s kept in the filings and AI proposals list.`, bad: true }
        : { text: from ? `Explained from ${from.file}, PDF page ${p.source.page}; the quote is on that page. Approve it to pin it.`
          : 'Explained from the numbers only. Approve it to pin it.' })
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }) } finally { setBusy(null) }
  }
  const remove = () => {
    if (report && window.confirm(`Remove ${report.file} from this model?`)) onReports(rs => rs.filter(x => x.id !== report.id))
  }
  const off = !ai?.available
  return (
    <div className="explain">
      {note && (
        <p className="explain-note" ref={noteRef} tabIndex={-1}>
          <span className="prop-ai">AI-written</span>{' '}{note.summary}{' '}
          <span className="muted">{note.from_numbers ? '(From the numbers only, no filing read.)'
            : <>({note.file}, PDF page {note.page}{note.quote && <>: “{note.quote}”</>})</>}</span>
        </p>
      )}
      {live && <ul className="src-list explain-live" aria-label={`Explanation of ${year} waiting for you`}>
        <ProposalItem p={live} busy={!!busy} as="h5" onDecide={decided} />
      </ul>}
      <div className="prop-ask" ref={askRef}>
        {report ? <>
          <button type="button" onClick={() => explain(report)} disabled={off} aria-disabled={!!busy}
            aria-describedby={`${id}-why`}>{note ? 'Explain again' : 'Explain'} from the report</button>
          <span className="muted small">{report.file}, {report.pages} pages ·{' '}
            <button type="button" className="link" onClick={remove} aria-label={`Remove ${report.file}`}>Remove</button></span>
        </> : <>
          <label className={`file-btn ${busy || ai?.pdf === false ? 'is-off' : ''}`}>
            <input type="file" accept=".pdf,application/pdf" className="visually-hidden" disabled={!!busy || ai?.pdf === false}
              onChange={e => { attach(e.target.files?.[0]); e.target.value = '' }} />
            Attach the {year} annual report
          </label>
          <button type="button" onClick={() => explain(null)} disabled={off} aria-disabled={!!busy}
            aria-describedby={`${id}-why`}>Explain from the numbers only</button>
        </>}
        <span className="muted small" id={`${id}-why`} aria-busy={!!busy}>
          {busy ?? (off ? ai?.message ?? 'The AI status is unknown; is the server running?'
            : ai?.pdf === false && !report ? ai.pdf_message : '')}
        </span>
      </div>
      <p className={`src-note ${msg?.bad ? 'is-bad' : ''}`} role="status">{msg?.text}</p>
    </div>
  )
}

/** An approved explanation of a forensic flag: serif words, marked AI-written, with its citation (or "from the numbers"). */
export function FlagNoteView({ note }: { note: FlagNote }) {
  return (
    <div className="ai-note">
      <span className="who">AI-written · {note.from_numbers ? 'from the numbers only' : 'cited'}</span>
      <p className="serif">{note.summary}</p>
      {note.quote && <p className="src-line"><span className="kind file">File</span>{note.file}, p.{note.page}: <q>{note.quote}</q></p>}
    </div>
  )
}

/** Beside a lit forensic flag: explain it in words from the latest attached annual report (rules pick the pages and
 * check the quote and every number in the words) or from the numbers only. Approving pins the words; nothing
 * numeric reads them. */
export function FlagExplain({ flag, company, filings, notes, reports, proposals, note, ai, onProposals }: {
  flag: Forensic; company: Company; filings: Filing[]; notes: Record<string, unknown>; reports: Report[]
  proposals: Proposal[]; note?: FlagNote; ai: AiStatus | null; onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  const askRef = useRef<HTMLDivElement>(null)
  const report = [...reports].sort((a, b) => b.year.localeCompare(a.year))[0]
  const live = proposals.filter(p => p.kind === 'flag_note' && p.field === flag.key && p.status === 'proposed').slice(-1)[0]
  const id = `fx-${flag.key}`
  const decided = (p: Proposal, s: Proposal['status']) => {
    onProposals(ps => decideNote(ps, p, s))
    setMsg({ text: s === 'approved' ? `Pinned the explanation of ${flag.title.toLowerCase()}.` : 'Rejected; kept in the filings and AI proposals list for the record.' })
    setTimeout(() => askRef.current?.querySelector('button')?.focus())
  }
  const explain = async (from: Report | null) => {
    if (busy) return
    setBusy(from ? `Finding the pages in ${from.file} and asking the model…` : 'Asking the model…')
    setMsg(null)
    try {
      const p = await api<Proposal>('/api/flags/explain', postJson({ company, filings, notes, key: flag.key, report: from }))
      const seen = proposals.find(x => x.id === p.id)
      onProposals(ps => addProposal(ps, p))
      const failed = p.checks.filter(c => c.pass === false)
      setMsg(seen ? { text: `The same explanation as before (${PROP_STATUS[seen.status].toLowerCase()}).` }
        : p.status === 'rejected' ? { text: `The rules rejected it: ${failed.map(c => c.detail).join(' ')} It’s kept for the record.`, bad: true }
        : { text: from ? `Explained from ${from.file}, PDF page ${p.source.page}; the quote is on that page. Approve it to pin it.`
          : 'Explained from the numbers only. Approve it to pin it.' })
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }) } finally { setBusy(null) }
  }
  const off = !ai?.available
  return (
    <div className="explain">
      {note && <FlagNoteView note={note} />}
      {live && <ul className="src-list explain-live" aria-label={`Explanation of ${flag.title} waiting for you`}>
        <ProposalItem p={live} busy={!!busy} as="h5" title={flag.title} onDecide={decided} />
      </ul>}
      <div className="prop-ask" ref={askRef}>
        {report && <button type="button" onClick={() => explain(report)} disabled={off} aria-disabled={!!busy}
          aria-describedby={`${id}-why`} aria-label={`Explain ${flag.title.toLowerCase()} from the ${report.year} report`}>
          {note ? 'Explain again' : 'Explain'} from the {report.year} report</button>}
        <button type="button" onClick={() => explain(null)} disabled={off} aria-disabled={!!busy}
          aria-describedby={`${id}-why`} aria-label={`Explain ${flag.title.toLowerCase()} from the numbers only`}>
          {report ? 'From the numbers only' : 'Explain from the numbers only'}</button>
        <span className="muted small" id={`${id}-why`} aria-busy={!!busy}>
          {busy ?? (off ? ai?.message ?? 'The AI status is unknown; is the server running?'
            : report ? '' : 'No annual report attached, so no citation.')}
        </span>
      </div>
      <p className={`src-note ${msg?.bad ? 'is-bad' : ''}`} role="status">{msg?.text}</p>
    </div>
  )
}
