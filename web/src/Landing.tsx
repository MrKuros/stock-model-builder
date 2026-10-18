import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MiniRange, latestOf, rangeWords, slugOf } from './Shell'
import { pathOf, placed } from './route'
import { NAMES, api, fmt, rs, when, type ModelSummary, type Parsed, type Report } from './lib'
import { AddBox, FetchRun, streamFetch } from './Fetch'

interface Props {
  models: ModelSummary[] | null
  error: string | null
  onAdd: (p: Parsed, reports?: Report[]) => Promise<void> // saves the new company and opens its Overview
  onDeleted: (id: string) => void
  onChecked: (saved: { id: string; saved_at: string }[]) => void // "Check all for new results" saved these versions
}

/** Your companies: every saved model with its price against our value range, and the add-a-company panel (a name or
 * NSE symbol, or a Export export). With an empty library it is the first-run screen, then straight to the Overview.
 * /?add=TCS (the company switcher's box) starts adding that symbol here. */
export default function Landing({ models, error: listError, onAdd, onDeleted, onChecked }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState<string | null>(() => { // a symbol picked in the company switcher
    const a = new URLSearchParams(location.search).get('add')?.toUpperCase() ?? null
    if (a) history.replaceState(history.state, '', '/')
    return a && /^[A-Z0-9&-]{1,20}$/.test(a) ? a : null
  })
  const libHead = useRef<HTMLHeadingElement>(null)
  const [upOpen] = useState(() => { // "Upload a Export export instead" from the company switcher
    const u = new URLSearchParams(location.search).has('upload')
    if (u) history.replaceState(history.state, '', '/')
    return u
  })
  useEffect(() => { // back on the list from a company: focus its heading, like any page change (not on a cold load)
    if (models == null) return
    if (placed.once) document.getElementById('page-h')?.focus({ preventScroll: true })
    placed.once = true
  }, [models == null]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, req: () => Promise<Parsed>) => {
    if (busy) return // one load at a time, so a slow earlier upload can't replace a later one
    setBusy(label)
    setError(null)
    try { await onAdd(await req()) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const upload = (f: File | undefined) => {
    if (!f) return
    const body = new FormData()
    body.append('file', f)
    run(`Reading ${f.name}…`, () => api<Parsed>('/api/parse', { method: 'POST', body }))
  }
  const sample = () => run('Loading the sample…', () => api<Parsed>('/api/sample'))
  const remove = async (m: ModelSummary) => {
    const date = m.saved_at ? when(m.saved_at) : 'earlier'
    if (!window.confirm(`Delete the ${m.company} model saved ${date}? This can’t be undone.`)) return
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' })
      onDeleted(m.id)
      ;((models?.length ?? 0) > 1 ? libHead : input).current?.focus() // the focused row is gone
    } catch (e) { setError((e as Error).message) }
  }

  const drop = (big: boolean) => (
    <label className={`drop${big ? ' big' : ''}${over ? ' is-over' : ''}`} aria-busy={!!busy}
      onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]) }}>
      <input ref={input} type="file" accept=".xlsx" className="sr" disabled={!!busy}
        onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} />
      {big && <svg className="up" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M4 20h16" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>}
      <strong>{busy ?? (big ? 'Drop a Export export here' : 'Add a company')}</strong>
      {!busy && <span>{big ? 'or ' : 'Drop a Export.in export here, or '}<u>choose a file</u> (.xlsx)</span>}
    </label>
  )
  const err = (error || listError) && <p className="error" role="alert">{error ?? listError}</p>
  const uploadLink = <button type="button" className="link" disabled={!!busy} onClick={() => input.current?.click()}>Upload a Export export instead</button>
  const box = () => adding
    ? <FetchRun key={adding} symbol={adding} onAdd={onAdd} onClose={() => setAdding(null)} upload={uploadLink} />
    : <AddBox models={models} onAdd={setAdding} upload={uploadLink} busy={!!busy} />

  if (models == null) return <main id="main" className="page" tabIndex={-1}><p className="muted pad" role="status">Opening your companies…</p></main>

  if (!models.length) return (
    <main id="main" className="page first" tabIndex={-1}>
      <p className="label">Get started · <b>one step</b></p>
      <h1 id="page-h" tabIndex={-1}>Add your first company</h1>
      <p className="purpose">Type a listed company’s name or NSE symbol: the app reads its results filings from NSE and in
        about half a minute you get a valuation, its fundamentals and a forecast you can change. No account needed.</p>
      <div className="first-add">{box()}</div>
      <p className="label or">or use a Export.in export</p>
      <div className="choices">
        {drop(true)}
        <div className="sample"><b>No file yet?</b>
          <p>Open a made-up company to see how everything works. You can delete it later.</p>
          <button className="primary" type="button" onClick={sample} disabled={!!busy}>Try the sample company</button></div>
      </div>
      {err}
      <ol className="how" aria-label="How to get a Export export">
        <li><b>1. Open export.in</b>Search for the company. A free account is enough.</li>
        <li><b>2. Click “Export to Excel”</b>It’s on the company page, above the numbers.</li>
        <li><b>3. Drop the file above</b>Ten years at once, also for companies that listed recently. Banks, NBFCs and insurers aren’t supported.</li>
      </ol>
    </main>
  )

  // newest version of each company leads; older days follow, dimmed
  const latest = latestOf(models)
  const isLatest = new Set(latest.map(m => m.id))
  const below = latest.filter(m => m.price != null && m.values?.bear != null && m.price < m.values.bear)
  const above = latest.filter(m => m.price != null && m.values?.bull != null && m.price > m.values.bull)
  const count = (ms: ModelSummary[], one: string, many: string) => ms.length === 1 ? `${ms[0].company} ${one}` : `${ms.length} companies ${many}`
  const headline = below.length ? `${count(below, 'trades below even our cautious (bear) value', 'trade below even our cautious (bear) value')}.`
    : above.length ? `${count(above, 'trades above even our hopeful (bull) value', 'trade above even our hopeful (bull) value')}.`
    : `${latest.length === 1 ? 'One company' : `${latest.length} companies`} covered, all priced inside our range.`

  return (
    <main id="main" className="page" tabIndex={-1}>
      <div className="land-head">
        <div>
          <p className="label">Your companies · <b>computed by rules</b> · base case</p>
          <h1 id="page-h" tabIndex={-1}>{headline}</h1>
          <p className="purpose">Open a company to see what its price assumes against what the business does, ten years of
            fundamentals, the forecast and the checks behind it. Analysis, not a recommendation.</p>
        </div>
        <div className="add">
          {box()}
          <details className="up-alt" open={!!busy || over || upOpen || undefined}>
            <summary>Or upload a Export export</summary>
            {drop(false)}
            <p className="small muted">On export.in open the company and click <b>Export to Excel</b> (free account).{' '}
              <button type="button" className="link" disabled={!!busy} onClick={sample}>Try a sample company</button> (made-up numbers).</p>
          </details>
          {err}
        </div>
      </div>

      <section aria-labelledby="library-head">
        <h2 id="library-head" ref={libHead} tabIndex={-1} className="label sec-label">
          <span>Companies · <b>price against our value range</b></span><span>newest first</span>
        </h2>
        {latest.some(m => m.symbol) && <CheckAll n={latest.filter(m => m.symbol).length} onSaved={onChecked} />}
        <div className="legend" aria-hidden="true">
          <span><i className="lg-band" />Our value range, cautious (bear) to hopeful (bull)</span>
          <span><i className="lg-mkt" />Today’s price</span>
        </div>
        <ul className="cov">
          {models.map(m => { const latest = isLatest.has(m.id); return (
            <li key={m.id} className={`cov-row${latest ? '' : ' old'}`}>
              <a className="cov-open" href={pathOf(slugOf(m.id), m.values?.base == null ? 'forecast' : 'overview', '', latest ? null : m.id.split('/')[1])}>
                <span className="co"><strong>{m.company}</strong>
                  <span>{m.saved_at ? when(m.saved_at) : '–'} · {NAMES[m.active]} · {m.n} yrs
                    {m.reviewed_at ? ' · reviewed' : ' · draft'}{latest ? '' : ' · older version'}</span></span>
                <MiniRange price={m.price ?? null} bear={m.values?.bear ?? null} base={m.values?.base ?? null} bull={m.values?.bull ?? null} />
                <span className="pf">{coverText(m)}</span>
                <span className="fl">{latest && m.new_results?.length ? <><span className="tag prop">New {m.new_results.join(', ')} results</span></> : null}{m.flags == null ? '' : m.flags ? `${m.flags} warning sign${m.flags > 1 ? 's' : ''}` : 'No warning signs'}</span>
              </a>
              <button type="button" className="link lib-del" disabled={!!busy} onClick={() => remove(m)}
                aria-label={`Delete ${m.company}, saved ${m.saved_at ? when(m.saved_at) : 'earlier'}`}>Delete</button>
            </li>
          ) })}
        </ul>
      </section>
      <footer className="foot">
        <p>Works for manufacturing, services and other non-financial companies; banks, NBFCs and insurers aren’t
          supported. Models save themselves to the <code>models</code> folder next to the app. Analysis, not a
          recommendation: no management access or channel checks.</p>
      </footer>
    </main>
  )
}

function coverText(m: ModelSummary): ReactNode {
  if (m.values?.base == null) return <span className="muted">No value yet: {(m.why ?? 'open it to see why').replace(/\.$/, '')}. Open it to fix the forecast.</span>
  const where = rangeWords(m.price ?? null, m.values.bear ?? null, m.values.base, m.values.bull ?? null)
  if (m.implied != null && m.growth != null)
    return <>{where}<br /><span className="muted">Priced for <span className="num mkt">{fmt(m.implied, 'pct')}</span> growth a year / ours <span className="num ours">{fmt(m.growth, 'pct')}</span></span></>
  if (m.price == null) return <>Base <span className="num ours">Rs {rs(m.values.base)}</span>, no price</>
  return <>Base <span className="num ours">Rs {rs(m.values.base)}</span>, no growth rate reaches the price</>
}

interface CheckResult { id: string; company: string; status: 'new' | 'none' | 'skipped' | 'failed'; text: string; saved_at?: string }

/** "Check all for new results": every company added by ticker, one after another (NSE once a second). New results
 * are saved as today's version with the forecast they replace kept for comparison; assumptions never change. Stop
 * keeps what was saved so far. */
function CheckAll({ n, onSaved }: { n: number; onSaved: (saved: { id: string; saved_at: string }[]) => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'stopped' | 'failed'>('idle')
  const [step, setStep] = useState<string | null>(null)
  const [results, setResults] = useState<CheckResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const ctl = useRef<AbortController | null>(null)
  useEffect(() => () => ctl.current?.abort(), [])
  const run = () => {
    const c = new AbortController()
    ctl.current = c
    setState('running'); setResults([]); setError(null); setStep(null)
    const saved: { id: string; saved_at: string }[] = []
    streamFetch<{ step?: string; result?: CheckResult; error?: string; done?: true }>({}, c.signal, e => {
      if (e.step) setStep(e.step)
      if (e.result) { setResults(r => [...r, e.result!]); if (e.result.status === 'new') saved.push({ id: e.result.id, saved_at: e.result.saved_at! }) }
      if (e.error) { setError(e.error); setState('failed') }
      if (e.done) setState('done')
    }, '/api/track/check')
      .catch(e => { if ((e as Error).name !== 'AbortError') { setError((e as Error).message); setState('failed') } })
      .finally(() => { if (saved.length) onSaved(saved) })
  }
  const running = state === 'running'
  const found = results.filter(r => r.status === 'new').length
  return (
    <div className="check-all" aria-busy={running}>
      <div className="ca-row">
        <button type="button" className="btn" onClick={run} disabled={running}>{running ? 'Checking…' : 'Check all for new results'}</button>
        {running && <button type="button" className="link" onClick={() => { ctl.current?.abort(); setState('stopped') }}>Stop</button>}
        <span className="small muted">{running ? step ?? 'Starting…'
          : state === 'done' ? `Done: ${found ? `new results for ${found} compan${found > 1 ? 'ies' : 'y'}, saved` : 'nothing new'}.`
          : state === 'stopped' ? `Stopped after ${results.filter(r => r.status !== 'skipped').length} of ${n}${found ? `; ${found} saved with new results` : ''}. The rest weren’t checked.`
          : `Asks NSE about the ${n === 1 ? 'company' : `${n} companies`} you added by ticker, about half a minute each. New results are saved next to your forecast; your assumptions never change.`}</span>
      </div>
      {results.length > 0 && <ul className="ca-list" aria-live="polite">{results.map(r => (
        <li key={r.id} className={r.status}><b>{r.company}</b>: {r.status === 'new'
          ? <>{r.text} <a href={pathOf(slugOf(r.id), 'overview', '', null, 'changed')}>See what changed</a></> : r.text}</li>))}</ul>}
      {error && <p className="error" role="alert">{error} Refresh on each company works too.</p>}
    </div>
  )
}
