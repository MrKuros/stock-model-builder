import { useEffect, useRef, useState } from 'react'
import { useHref } from './route'
import { api, postJson, type Company, type ModelDoc, type Parsed, type Report, type SourceDoc } from './lib'

/** One line of /api/nse/fetch: a step in plain words, its progress, the company once its numbers are in, a kept
 * document, something that didn't work, or the end. */
export interface FetchEvent {
  step?: string; detail?: string; company?: Parsed; report?: Report; documents?: SourceDoc[]; note?: string
  error?: string; done?: true
  final?: boolean // trying again won't change the error (no such symbol, too few years)
  lender?: boolean // a bank, NBFC or insurer: an Excel export won't work either
}

/** A company name for matching an upload to a saved company: 'Tata Consultancy Services Ltd.' = '... Limited'
 * (server._norm). */
export const sameCompany = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/\b(limited|ltd|the|india|co|company)\b|[^a-z0-9]/g, '')
  return n(a) === n(b)
}

/** "Add these years to it" from Add a company: the saved company opens and merges them there (Workspace), so its
 * inputs, notes and review stay. parsed: an Excel export's years; symbol: NSE's filings for that symbol. */
export const pendingMerge: { company: string; parsed?: Parsed; symbol?: string }[] = []

/** POST a JSON-lines endpoint (/api/nse/fetch by default), calling `on` for each line as it arrives; aborting the
 * signal stops the server's work too. */
export async function streamFetch<E = FetchEvent>(body: unknown, signal: AbortSignal, on: (e: E) => void, url = '/api/nse/fetch') {
  const res = await fetch(url, postJson(body, signal))
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => null)
    throw new Error(typeof b?.detail === 'string' ? b.detail : `Server error (${res.status}). Try again.`)
  }
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) on(JSON.parse(line))
    }
  }
}

/** "just now", "10 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null | undefined) {
  if (!iso) return 'not yet'
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
/** Re-render every minute, so "10 min ago" stays true. */
export function useMinute() {
  const [, tick] = useState(0)
  useEffect(() => { const t = window.setInterval(() => tick(x => x + 1), 60_000); return () => window.clearInterval(t) }, [])
}

/** "FY2019 to FY2022, FY2024" from year labels. */
function spans(ys: string[]) {
  const out: [string, string][] = []
  for (const y of ys) {
    const p = out.at(-1)
    if (p && +y.slice(2) === +p[1].slice(2) + 1) p[1] = y
    else out.push([y, y])
  }
  return out.map(([a, b]) => (a === b ? a : `${a} to ${b}`)).join(', ')
}

/** On the Overview of a company added by ticker: where each year came from, what's missing, where filings and
 * the export disagree, and the documents. An Excel export can fill the missing years, right here. */
export function SourceNote({ company, doc, onCompany }: { company: Company; doc: ModelDoc; onCompany: (p: Parsed, c: Company) => void }) {
  useMinute()
  const href = useHref()
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const s = company.source
  if (!s?.symbol) return null
  const yrs = Object.entries(s.years)
  const nse = yrs.filter(([, w]) => w === 'NSE filing').map(([y]) => y)
  const chosen = yrs.filter(([, w]) => w === 'Excel export (restated)').map(([y]) => y)
  const other = yrs.filter(([, w]) => w !== 'NSE filing' && w !== 'Excel export (restated)').map(([y]) => y)
  const restated = s.restated ?? []
  // a year with both rows kept gets its own line with the switch; an older model only has the sentence
  const notes = s.notes.filter(n => !restated.some(r => n.startsWith(`${r.year} looks restated later`)))
  const useRestated = async (year: string, use: boolean) => {
    setError(null)
    setBusy(use ? `Switching ${year} to the restated numbers…` : `Switching ${year} back…`)
    try {
      const p = await api<Parsed>('/api/restated', postJson({ company, year, use, filings: doc.filings, notes: doc.notes, excluded_years: doc.excluded_years }))
      onCompany(p, p.company)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const upload = async (f: File | undefined) => {
    if (!f) return
    setError(null)
    try {
      setBusy('Reading the Excel export…')
      const body = new FormData()
      body.append('file', f)
      await merge(await api<Parsed>('/api/parse', { method: 'POST', body }))
    } catch (e) { setError((e as Error).message); setBusy(null) }
  }
  async function merge(p: Parsed) {
    if (!s?.symbol) return
    setError(null)
    try {
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
    <section className="provenance" aria-labelledby="prov-h">
      <h2 id="prov-h" className="label">Where these numbers come from · <b>NSE: {s.symbol}</b>{s.industry ? ` · ${s.industry}` : ''}</h2>
      <ul>
        {nse.length > 0 && <li><b>{spans(nse)}</b>: NSE’s annual results filings ({s.basis}), read by rules.</li>}
        {other.length > 0 && <li><b>{spans(other)}</b>: {s.from ?? 'an Excel export'}, for years NSE has no filing with a balance sheet.</li>}
        {chosen.length > 0 && <li><b>{spans(chosen)}</b>: the restated numbers, chosen by you (below).</li>}
        {s.missing.map(m => <li key={m} className="miss">Not available: {m}.</li>)}
        <li>Price and share count: NSE, checked {ago(s.price_at)} (Check for new results, at the top).</li>
      </ul>
      {s.mismatches.length > 0 && <details className="fold">
        <summary>{s.mismatches.length} difference{s.mismatches.length > 1 ? 's' : ''} over 1% between the filings and the export (the filings’ numbers are used)</summary>
        <div className="scroll" tabIndex={0} role="region" aria-label="Differences between filings and the export"><table className="mini-t">
          <thead><tr><th scope="col">Year</th><th scope="col">Line</th><th scope="col" className="r">Filing (Rs cr)</th><th scope="col" className="r">Export</th></tr></thead>
          <tbody>{s.mismatches.map((m, i) => <tr key={i}><td>{m.year}</td><td>{m.line}</td>
            <td className="r num">{Math.round(m.filing).toLocaleString('en-IN')}</td><td className="r num">{Math.round(m.export).toLocaleString('en-IN')}</td></tr>)}</tbody>
        </table></div>
        <p className="small-note">Net profit is compared before the minority’s share on both sides. Where the export’s borrowings are higher, the difference is lease liabilities a filing keeps in other liabilities; they’re moved into borrowings and listed in the notes below.</p>
      </details>}
      {restated.length > 0 && <ul className="fetch-notes restated-l">{restated.map(r => (
        <li key={r.year}>
          <b>{r.year} {r.line}</b>: first filed <span className="num">Rs {Math.round(r.filed).toLocaleString('en-IN')} cr</span>, restated by a later
          filing to <span className="num">Rs {Math.round(r.restated).toLocaleString('en-IN')} cr</span>.{' '}
          {r.used ? <>The model uses the restated year, so growth into the next year is like for like.{' '}
            <button type="button" className="link" disabled={!!busy} onClick={() => useRestated(r.year, false)}>Use the first-filed numbers</button></>
          : <>The model uses the first-filed numbers, so growth and margins into the next year aren’t like for like.{' '}
            <button type="button" className="btn" disabled={!!busy} onClick={() => useRestated(r.year, true)}>Use the restated {r.year}</button></>}
        </li>))}</ul>}
      {notes.length > 0 && <ul className="fetch-notes">{notes.map((n, i) => <li key={i}>{n}{/ looks restated later/.test(n)
        ? ' To switch to the restated year in one click, add years from an Excel export below; the two are compared again.' : ''}</li>)}</ul>}
      {s.documents.length > 0 && <details className="fold">
        <summary>{s.documents.length} documents on NSE (annual reports, call transcripts, presentations)</summary>
        <ul className="doc-links">{s.documents.map((d, i) => <li key={i}>
          <a href={d.url} target="_blank" rel="noreferrer">{d.kind === 'annual' ? d.title : `${d.kind === 'transcript' ? 'Call transcript' : 'Presentation'}, ${new Date(d.date!).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`}</a></li>)}</ul>
      </details>}
      <p className="small-note">The documents kept with this model are on <a href={href('documents')}>Documents and sources</a>.{' '}
        {other.length || !s.missing.length ? 'Have an Excel export? ' : 'Missing years? '}
        <label className="link up-l">{busy ?? 'Add years from an Excel export'}<input ref={file} type="file" accept=".xlsx" className="sr" disabled={!!busy}
          onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} /></label>{' '}
        (filings still win where both have a year).</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
