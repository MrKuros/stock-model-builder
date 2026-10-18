import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { latestOf, slugOf } from './Shell'
import { navigate, pathOf, useHref } from './route'
import { api, postJson, type Company, type ModelDoc, type ModelSummary, type Parsed, type Report, type SourceDoc } from './lib'

/** One line of /api/nse/fetch: a step in plain words, its progress, the company once its numbers are in, a kept
 * document, something that didn't work, or the end. */
export interface FetchEvent {
  step?: string; detail?: string; company?: Parsed; report?: Report; documents?: SourceDoc[]; note?: string
  error?: string; done?: true
}

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
function useMinute() {
  const [, tick] = useState(0)
  useEffect(() => { const t = window.setInterval(() => tick(x => x + 1), 60_000); return () => window.clearInterval(t) }, [])
}

const SYMBOL = /^[A-Z0-9&-]{1,20}$/
type Option = { key: string; kind: 'open'; name: string; href: string } | { key: string; kind: 'add'; name: string; symbol: string }

/** "Add a company": one box for a name or an NSE symbol, with suggestions (your saved companies first, then NSE's).
 * Picking a saved one opens it; picking an NSE one calls onAdd(symbol). */
export function AddBox({ models, onAdd, upload, compact, busy }: {
  models: ModelSummary[] | null; onAdd: (symbol: string) => void; upload: ReactNode; compact?: boolean; busy?: boolean
}) {
  const id = useId()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ symbol: string; name: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const text = q.trim()
  useEffect(() => { // ask NSE once typing pauses
    setHits([])
    setError(null)
    if (text.length < 2) return
    const ctl = new AbortController()
    const t = window.setTimeout(() => {
      setSearching(true)
      api<{ results: { symbol: string; name: string }[]; error: string | null }>('/api/nse/search', postJson({ q: text }, ctl.signal))
        .then(r => { setHits(r.results); setError(r.error) })
        .catch(e => { if (e.name !== 'AbortError') setError((e as Error).message) })
        .finally(() => setSearching(false))
    }, 300)
    return () => { window.clearTimeout(t); ctl.abort() }
  }, [text])

  const low = text.toLowerCase()
  const saved = text.length < 1 ? [] : latestOf(models).filter(m => m.company.toLowerCase().includes(low)).slice(0, 4)
  const typed = text.toUpperCase()
  const options: Option[] = [
    ...saved.map(m => ({ key: `o-${m.id}`, kind: 'open' as const, name: m.company, href: pathOf(slugOf(m.id), 'overview') })),
    ...hits.map(h => ({ key: `a-${h.symbol}`, kind: 'add' as const, name: h.name, symbol: h.symbol })),
    ...(SYMBOL.test(typed) && !hits.some(h => h.symbol === typed) ? [{ key: `s-${typed}`, kind: 'add' as const, name: `${typed} (by symbol)`, symbol: typed }] : []),
  ]
  const shown = open && text.length > 0 && options.length > 0
  const pick = (o: Option | undefined) => {
    if (!o || busy) return
    setOpen(false)
    if (o.kind === 'open') navigate(o.href)
    else { setQ(''); onAdd(o.symbol) }
  }
  const optId = (i: number) => `${id}-o${i}`
  return (
    <div className={`addbox${compact ? ' compact' : ''}`}>
      <label htmlFor={`${id}-in`} className="add-l">Add a company: type a name or NSE symbol</label>
      <div className="add-row">
        <input id={`${id}-in`} type="text" role="combobox" autoComplete="off" spellCheck={false} value={q} disabled={busy}
          placeholder="e.g. TCS or Hindustan Unilever" aria-expanded={shown} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={shown ? optId(active) : undefined} aria-describedby={`${id}-hint`}
          onChange={e => { setQ(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
              setActive(a => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(options.length, 1))
            } else if (e.key === 'Enter') { e.preventDefault(); pick(options[shown ? active : 0]) }
            else if (e.key === 'Escape' && shown) { e.preventDefault(); setOpen(false) }
          }} />
        <button type="button" className="primary" disabled={busy || !options.length} onClick={() => pick(options[shown ? active : 0])}>Add</button>
        {shown && <ul className="add-list" role="listbox" id={`${id}-list`} aria-label="Suggestions">
          {options.map((o, i) => (
            <li key={o.key} id={optId(i)} role="option" aria-selected={i === active} className={i === active ? 'on' : undefined}
              onMouseDown={e => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setActive(i)}>
              <span>{o.name}</span>
              <span className="tag">{o.kind === 'open' ? 'Open yours' : o.symbol}</span>
            </li>
          ))}
        </ul>}
      </div>
      <p className="small muted" id={`${id}-hint`} aria-live="polite">
        {error ? <span className="bad">{error} </span> : searching ? 'Looking on NSE… ' : text.length >= 2 && !options.length ? 'Nothing on NSE matches that. ' : null}
        Numbers come from NSE’s filings, read by rules. {upload}
      </p>
    </div>
  )
}

interface Step { text: string; detail?: string }

/** Adding one company: each step in plain words, Stop, and what to do when something fails. Calls onAdd with the
 * company and the documents kept so far when it's done (or when you take a stopped one as it is). */
export function FetchRun({ symbol, onAdd, onClose, upload }: {
  symbol: string; onAdd: (p: Parsed, reports: Report[]) => Promise<void>; onClose: () => void; upload: ReactNode
}) {
  const [steps, setSteps] = useState<Step[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<'running' | 'stopped' | 'failed' | 'adding'>('running')
  const [run, setRun] = useState(0)
  const got = useRef<{ p: Parsed | null; reports: Report[] }>({ p: null, reports: [] })
  const ctl = useRef<AbortController | null>(null)
  const head = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const c = new AbortController()
    ctl.current = c
    got.current = { p: null, reports: [] }
    setSteps([]); setNotes([]); setError(null); setState('running')
    head.current?.focus()
    const finish = async () => {
      const { p, reports } = got.current
      if (!p) return
      setState('adding')
      try { await onAdd(p, reports) } catch (e) { setError((e as Error).message); setState('failed') }
    }
    streamFetch({ symbol }, c.signal, e => {
      if (e.step) setSteps(s => [...s, { text: e.step! }])
      if (e.detail) setSteps(s => s.map((x, i) => (i === s.length - 1 ? { ...x, detail: e.detail } : x)))
      if (e.note) setNotes(n => [...n, e.note!])
      if (e.company) got.current.p = e.company
      if (e.documents && got.current.p) {
        const pc = got.current.p.company
        got.current.p = { ...got.current.p, company: { ...pc, source: pc.source && { ...pc.source, documents: e.documents } } }
      }
      if (e.report) got.current.reports.push(e.report)
      if (e.error) { setError(e.error); setState('failed') }
      if (e.done) finish()
    }).catch(e => {
      if ((e as Error).name === 'AbortError') return
      setError((e as Error).message)
      setState('failed')
    })
    return () => c.abort()
  }, [symbol, run]) // eslint-disable-line react-hooks/exhaustive-deps
  const stop = () => { ctl.current?.abort(); setState('stopped') }
  const name = got.current.p?.company.name
  const last = steps.length - 1
  return (
    <section className="fetch" aria-labelledby="fetch-h" aria-busy={state === 'running' || state === 'adding'}>
      <h2 id="fetch-h" ref={head} tabIndex={-1}>{state === 'failed' ? `Couldn’t add ${symbol}` : state === 'stopped' ? `Stopped adding ${symbol}` : `Adding ${symbol} from NSE`}</h2>
      <ol className="steps" aria-live="polite">
        {steps.map((s, i) => {
          const now = i === last && state === 'running'
          return <li key={i} className={now ? 'now' : 'done'}><span className="tick" aria-hidden="true">{now ? '' : '✓'}</span>
            <span>{s.text}{s.detail && now && <span className="muted"> {s.detail}</span>}</span>
            <span className="sr">{now ? ' (in progress)' : ' (done)'}</span></li>
        })}
        {state === 'adding' && <li className="now"><span className="tick" aria-hidden="true" /><span>Saving {name} and opening its Overview…</span></li>}
      </ol>
      {notes.length > 0 && <ul className="fetch-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="fetch-act">
        {state === 'running' && <button type="button" className="btn" onClick={stop}>Stop</button>}
        {state === 'stopped' && got.current.p && <>
          <button type="button" className="primary" onClick={() => { setState('adding'); onAdd(got.current.p!, got.current.reports).catch(e => { setError((e as Error).message); setState('failed') }) }}>
            Add {name} without the rest</button>
          <span className="small muted">Its numbers are in; documents not yet downloaded can be attached later on the Checks page.</span></>}
        {(state === 'stopped' || state === 'failed') && <>
          <button type="button" className={got.current.p && state === 'stopped' ? 'btn' : 'primary'} onClick={() => setRun(r => r + 1)}>Try again</button>
          <button type="button" className="link" onClick={onClose}>Cancel</button></>}
        <span className="small">{upload}</span>
      </div>
      {state === 'running' && <p className="small muted">About half a minute: the app asks NSE once a second. What it downloads is kept, so trying again is quick.</p>}
    </section>
  )
}

/** The context bar's price line for a company added by ticker: when the price was checked, and Refresh (today's price,
 * then any new results; assumptions never change by themselves). New annual results first record the forecast they
 * replace (/api/track/apply), so the Overview can show what came in against it. */
export function Refresh({ doc, onCompany, onResults }: {
  doc: ModelDoc; onCompany: (p: Parsed | null, c: Company) => void; onResults: (p: Parsed, d: ModelDoc) => void
}) {
  useMinute()
  const href = useHref()
  const company = doc.company
  const s = company.source
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<ReactNode>(null)
  if (!s?.symbol) return null
  const run = async () => {
    setBusy(true)
    setMsg('Checking the price…')
    const ctl = new AbortController()
    try {
      const r = await api<{ price: number | null; shares: number | null; face_value: number | null; at: string }>('/api/nse/price', postJson({ symbol: s.symbol }, ctl.signal))
      const m = company.market ?? { price: null, shares: null, price_hist: [], shares_hist: [] }
      const c: Company = { ...company, market: { ...m, price: r.price ?? m.price, shares: r.shares ?? m.shares, face_value: r.face_value ?? m.face_value },
        source: { ...s, price_at: r.at } }
      setMsg('Looking for new results…')
      let got: Parsed | null = null
      await streamFetch({ symbol: s.symbol, company: c, documents: false }, ctl.signal, e => {
        if (e.company) got = e.company
        if (e.error) throw new Error(e.error)
      })
      const p = got as Parsed | null
      const a = p && await api<{ doc: ModelDoc | null; years: string[]; quarter: string | null }>('/api/track/apply',
        postJson({ doc: { ...doc, company: c }, company: p.company, filings: p.fetched?.filings ?? [] }, ctl.signal))
      if (p && a?.doc) {
        onResults({ ...p, company: a.doc.company }, a.doc)
        setMsg(a.years.length
          ? <>New {a.years.join(', ')} results added. Your assumptions haven’t changed. <a href={href('overview', 'changed')}>See what changed</a></>
          : `Quarter to ${new Date(a.quarter!).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} added. Your assumptions haven’t changed.`)
      } else {
        onCompany(null, c)
        setMsg('Price updated. No new results.')
      }
    } catch (e) { setMsg(`Couldn’t refresh: ${(e as Error).message}`) } finally { setBusy(false) }
  }
  return <span className="refresh">
    <span>NSE price checked {ago(s.price_at)}</span>
    <button type="button" className="link" onClick={run} disabled={busy} aria-describedby={msg ? 'refresh-msg' : undefined}>
      {busy ? 'Refreshing…' : 'Refresh'}</button>
    {msg && <span id="refresh-msg" className="note" role="status">{msg}</span>}
  </span>
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
 * Export disagree, and the documents. A Export export can fill the missing years, right here. */
export function SourceNote({ company, onCompany }: { company: Company; onCompany: (p: Parsed, c: Company) => void }) {
  useMinute()
  const href = useHref()
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const s = company.source
  if (!s?.symbol) return null
  const yrs = Object.entries(s.years)
  const nse = yrs.filter(([, w]) => w === 'NSE filing').map(([y]) => y), other = yrs.filter(([, w]) => w !== 'NSE filing').map(([y]) => y)
  const merge = async (f: File | undefined) => {
    if (!f) return
    setError(null)
    try {
      setBusy('Reading the Export export…')
      const body = new FormData()
      body.append('file', f)
      const p = await api<Parsed>('/api/parse', { method: 'POST', body })
      setBusy('Putting the history together…')
      let got: Parsed | null = null
      await streamFetch({ symbol: s.symbol, company: p.company, documents: false }, new AbortController().signal, e => {
        if (e.company) got = e.company
        if (e.error) throw new Error(e.error)
      })
      const g = got as Parsed | null
      if (!g) throw new Error('The server stopped before the history was ready. Try again.')
      const c = { ...g.company, name: company.name, source: g.company.source && { ...g.company.source, from: 'your Export export', documents: s.documents } }
      onCompany({ ...g, company: c }, c)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <section className="provenance" aria-labelledby="prov-h">
      <h2 id="prov-h" className="label">Where these numbers come from · <b>NSE: {s.symbol}</b>{s.industry ? ` · ${s.industry}` : ''}</h2>
      <ul>
        {nse.length > 0 && <li><b>{spans(nse)}</b>: NSE’s annual results filings ({s.basis}), read by rules.</li>}
        {other.length > 0 && <li><b>{spans(other)}</b>: {s.from ?? 'Export'}, for years NSE has no filing with a balance sheet.</li>}
        {s.missing.map(m => <li key={m} className="miss">Not available: {m}.</li>)}
        <li>Price and share count: NSE, checked {ago(s.price_at)} (Refresh at the top).</li>
      </ul>
      {s.mismatches.length > 0 && <details className="fold">
        <summary>{s.mismatches.length} difference{s.mismatches.length > 1 ? 's' : ''} over 1% between the filings and Export (the filings’ numbers are used)</summary>
        <div className="scroll" tabIndex={0} role="region" aria-label="Differences between filings and Export"><table className="mini-t">
          <thead><tr><th scope="col">Year</th><th scope="col">Line</th><th scope="col" className="r">Filing (Rs cr)</th><th scope="col" className="r">Export</th></tr></thead>
          <tbody>{s.mismatches.map((m, i) => <tr key={i}><td>{m.year}</td><td>{m.line}</td>
            <td className="r num">{Math.round(m.filing).toLocaleString('en-IN')}</td><td className="r num">{Math.round(m.export).toLocaleString('en-IN')}</td></tr>)}</tbody>
        </table></div>
        <p className="small-note">Borrowings usually differ because Export counts lease liabilities as borrowings and results filings don’t; net profit because the filing’s is the owners’ share.</p>
      </details>}
      {s.notes.length > 0 && <ul className="fetch-notes">{s.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {s.documents.length > 0 && <details className="fold">
        <summary>{s.documents.length} documents on NSE (annual reports, call transcripts, presentations)</summary>
        <ul className="doc-links">{s.documents.map((d, i) => <li key={i}>
          <a href={d.url} target="_blank" rel="noreferrer">{d.kind === 'annual' ? d.title : `${d.kind === 'transcript' ? 'Call transcript' : 'Presentation'}, ${new Date(d.date!).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`}</a></li>)}</ul>
      </details>}
      <p className="small-note">The documents kept with this model are on <a href={href('checks', 'documents')}>Checks → Documents</a>.{' '}
        {other.length || !s.missing.length ? 'Have a Export export? ' : 'Missing years? '}
        <label className="link up-l">{busy ?? 'Add years from a Export export'}<input ref={file} type="file" accept=".xlsx" className="sr" disabled={!!busy}
          onChange={e => { merge(e.target.files?.[0]); e.target.value = '' }} /></label>{' '}
        (filings still win where both have a year).</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
