import { useRef, useState } from 'react'
import type { Upgrade } from './App'
import { api, dec2, fmt, money, type Check, type Company, type Filing, type Proposal, type Sources as Used } from './lib'

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
const show = (p: Proposal) => (typeof p.value !== 'number' ? String(p.value)
  : p.unit === 'Rs crore' ? `Rs ${Math.abs(p.value) >= 100 ? money(p.value) : dec2(p.value)} cr` : `${dec2(p.value)}${p.unit ? ` ${p.unit}` : ''}`)
const amount = (k: string, v: number) => (PER_SHARE.has(k) ? `Rs ${dec2(v)}` : money(v))

function Checks({ checks }: { checks: Check[] }) {
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
}

/** Exchange filings attached to the model, read by fixed rules, and AI proposals waiting for a decision. */
export default function Sources({ company, filings, proposals, onFilings, onProposals, sources, upgrades, onApply }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [over, setOver] = useState(false)
  const head = useRef<HTMLHeadingElement>(null)

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
      setNote(`${again ? 'Read again' : 'Attached'}: ${title(f)}. ${Object.keys(f.facts).length} lines mapped, ` +
        `${f.unmapped.length} unmapped${failed ? `, ${failed} check${failed > 1 ? 's' : ''} failed` : ''}.`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const remove = (f: Filing) => {
    if (!window.confirm(`Remove the filing ${f.file} (${title(f)}) from this model?`)) return
    onFilings(fs => fs.filter(x => x.id !== f.id))
    setNote(`Removed ${f.file}.`)
    head.current?.focus() // its Remove button is gone
  }
  const decide = (p: Proposal, status: Proposal['status']) =>
    onProposals(ps => ps.map(x => (x.id === p.id ? { ...x, status } : x)))
  const sorted = [...filings].sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''))
  const apply = () => {
    onApply()
    setNote('New defaults applied to base, bull and bear.')
    head.current?.focus() // the button is gone
  }
  const d = sources?.drivers ?? {}
  const used = sources ? [sources.used.payables.length > 0 && d.dpo, d.ol_pct, d.lease,
    sources.used.capex.length > 0 && d.capex_pct].filter((x): x is string => !!x) : []

  return (
    <section className="sources" aria-labelledby="src-head">
      <div className="val-top"><h2 id="src-head" ref={head} tabIndex={-1}>Sources &amp; proposals</h2></div>
      <p className="muted small">
        Results filings from the exchanges, read by fixed rules and checked against the Export figures. An annual
        filing whose revenue matches Export’s adds that year’s trade payables, lease liabilities and cash-flow capex
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
              The filings moved these defaults:{' '}
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

      {proposals.length > 0 && (
        <>
          <h3 className="src-sub">Proposals</h3>
          <ul className="src-list" aria-label="Proposals">
            {proposals.map(p => (
              <li key={p.id} className={`src-item prop is-${p.status}`}>
                <div className="src-head">
                  <h4>{label(p.field)}{p.period && <> · {p.period}</>}: <span className="prop-value">
                    {show(p)}</span></h4>
                  <span className="prop-status">{p.status === 'proposed' ? 'Waiting for you' : p.status === 'approved' ? 'Approved' : 'Rejected'}</span>
                </div>
                <p className="muted small">
                  {p.ai && <span className="prop-ai">AI-read · </span>}
                  {p.source.file}{p.source.page != null && <>, page {p.source.page}</>}{p.source.tag && <>, tag {p.source.tag}</>}
                </p>
                {p.source.quote && <blockquote className="prop-quote">“{p.source.quote}”</blockquote>}
                {p.reasoning && <p className="small">{p.reasoning}</p>}
                <Checks checks={p.checks} />
                <div className="prop-actions">
                  <button type="button" aria-pressed={p.status === 'approved'} onClick={() => decide(p, 'approved')}
                    disabled={p.checks.some(c => c.pass === false)}>Approve</button>
                  <button type="button" aria-pressed={p.status === 'rejected'} onClick={() => decide(p, 'rejected')}>Reject</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
