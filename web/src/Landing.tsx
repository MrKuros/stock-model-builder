import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MiniRange, latestOf, rangeWords, slugOf } from './Shell'
import { navigate, pathOf, placed } from './route'
import { NAMES, api, fmt, postJson, rs, when, type ModelSummary, type Parsed, type Report, type WatchList } from './lib'
import { AddBox, FetchRun, ago, pendingMerge, sameCompany, streamFetch } from './Fetch'
import { month } from './Statements'
import { Prices, Spark, WatchSection } from './Watch'

interface Props {
  models: ModelSummary[] | null
  error: string | null
  onAdd: (p: Parsed, reports?: Report[]) => Promise<void> // saves the new company and opens its Overview
  onDeleted: (id: string) => void
  onChecked: (saved: { id: string; saved_at: string }[]) => void // "Check all for new results" saved these versions
  onReload: () => void // prices were refreshed: list again (values are recomputed at today's price)
}

const SORTS = {
  cheap: 'Cheapest against our value',
  flags: 'Most warning signs',
  changed: 'Recently changed',
  name: 'Name, A to Z',
} as const
const FILTERS = {
  all: 'All companies',
  below: 'Price below our base value',
  flags: 'With warning signs',
  results: 'New results to review',
  draft: 'Not reviewed yet',
} as const
type Sort = keyof typeof SORTS
type Filter = keyof typeof FILTERS
const upside = (m: ModelSummary) => (m.price && m.values?.base != null ? m.values.base / m.price - 1 : null)
const PREFS = 'financial-model:coverage' // the sort and filter you last chose, this browser only
function pref<T extends string>(key: 'sort' | 'filter', ok: Record<T, string>, dflt: T): T {
  try { const v = JSON.parse(localStorage.getItem(PREFS) ?? '{}')[key]; return v in ok ? v : dflt } catch { return dflt }
}

/** Your companies: every saved model with its price against our value range, and the add-a-company panel (a name or
 * NSE symbol, or a Export export). With an empty library it is the first-run screen, then straight to the Overview.
 * /?add=TCS (the company switcher's box) starts adding that symbol here. */
export default function Landing({ models, error: listError, onAdd, onDeleted, onChecked, onReload }: Props) {
  const [watch, setWatch] = useState<WatchList | null>(null)
  const [watchMsg, setWatchMsg] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>(() => pref('sort', SORTS, 'cheap'))
  const [filter, setFilter] = useState<Filter>(() => pref('filter', FILTERS, 'all'))
  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify({ sort, filter })) } catch { /* private window */ } }, [sort, filter])
  const loadWatch = () => api<WatchList>('/api/watch').then(setWatch).catch(() => setWatch({ watch: [], history: {} }))
  useEffect(() => { loadWatch() }, [])
  const watchIt = async (symbol: string) => {
    setWatchMsg(`Looking up ${symbol} on NSE…`)
    try {
      const w = await api<WatchList>('/api/watch', postJson({ symbol }))
      setWatch(w)
      const x = w.watch.find(x => x.symbol === symbol)
      setWatchMsg(`Watching ${x?.name ?? symbol}. It’s listed under “Watching” below.`)
    } catch (e) { setWatchMsg(`Couldn’t watch ${symbol}: ${(e as Error).message}`) }
  }
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [twin, setTwin] = useState<{ p: Parsed; m: ModelSummary } | null>(null) // an export of a company added by ticker
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

  const run = async (label: string, req: () => Promise<Parsed>, then: (p: Parsed) => Promise<void> = p => onAdd(p)) => {
    if (busy) return // one load at a time, so a slow earlier upload can't replace a later one
    setBusy(label)
    setError(null)
    setTwin(null)
    try { await then(await req()) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const upload = (f: File | undefined) => {
    if (!f) return
    const body = new FormData()
    body.append('file', f)
    run(`Reading ${f.name}…`, () => api<Parsed>('/api/parse', { method: 'POST', body }), async p => {
      // the same company already added by ticker: offer to add the export's years to it rather than a second copy
      const m = latestOf(models).find(x => x.symbol && sameCompany(x.company, p.company.name))
      if (m) setTwin({ p, m })
      else await onAdd(p)
    })
  }
  useEffect(() => { if (twin) document.getElementById('twin-h')?.focus() }, [twin])
  const mergeTwin = () => {
    if (!twin) return
    pendingMerge.push({ company: twin.m.company, parsed: twin.p })
    navigate(pathOf(slugOf(twin.m.id), 'overview'))
  }
  const keepTwin = () => {
    if (!twin) return
    const { p } = twin
    run('Saving it as a separate model…', async () => ({ ...p, company: { ...p.company, name: `${p.company.name} (Export export)` } }))
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
  // the upload sits right under the box on this page, so the box itself doesn't offer it a second time
  const box = () => twin
    ? <section className="fetch" aria-labelledby="twin-h">
        <h2 id="twin-h" tabIndex={-1}>You already have {twin.m.company} from NSE</h2>
        <p className="small">This export is the same company. Adding its years to the one you have keeps a single model:
          NSE’s filings win where both have a year, and differences over 1% are listed on its Overview.</p>
        <div className="fetch-act">
          <button type="button" className="primary" onClick={mergeTwin}>Add these years to it</button>
          <button type="button" className="btn" disabled={!!busy} onClick={keepTwin}>Keep as a separate model</button>
          <button type="button" className="link" onClick={() => setTwin(null)}>Cancel</button>
        </div>
      </section>
    : adding
    ? <FetchRun key={adding} symbol={adding} onAdd={onAdd} onClose={() => setAdding(null)} upload={uploadLink} />
    : <AddBox models={models} onAdd={setAdding} onWatch={models?.length ? watchIt : undefined} upload={null} busy={!!busy} />

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

  // the newest version of each company is the list; older saved days sit in a fold under it
  const latest = latestOf(models)
  const isLatest = new Set(latest.map(m => m.id))
  const older = models.filter(m => !isLatest.has(m.id))
  const shown = latest.filter(m => filter === 'all' ? true
    : filter === 'below' ? (upside(m) ?? -1) > 0
    : filter === 'flags' ? (m.flags ?? 0) > 0
    : filter === 'results' ? !!m.new_results?.length
    : !m.reviewed_at)
  const by = (f: (m: ModelSummary) => number | null) => (x: ModelSummary, y: ModelSummary) => (f(y) ?? -Infinity) - (f(x) ?? -Infinity)
  shown.sort(sort === 'cheap' ? by(upside) : sort === 'flags' ? by(m => m.flags ?? null)
    : sort === 'changed' ? by(m => (m.saved_at ? new Date(m.saved_at).getTime() : null)) : (x, y) => x.company.localeCompare(y.company))
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
          {watchMsg && <p className="small" role="status">{watchMsg}</p>}
          {err}
        </div>
      </div>

      <section aria-labelledby="library-head">
        <h2 id="library-head" ref={libHead} tabIndex={-1} className="label sec-label">
          <span>Companies · <b>price against our value range</b></span><span>{latest.length}</span>
        </h2>
        <Prices models={latest} watch={watch?.watch ?? []} onDone={() => { onReload(); loadWatch() }} />
        {latest.some(m => m.symbol) && <CheckAll n={latest.filter(m => m.symbol).length} onSaved={onChecked} />}
        <div className="cov-tools">
          <label>Sort by <select value={sort} onChange={e => setSort(e.target.value as Sort)}>
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Show <select value={filter} onChange={e => setFilter(e.target.value as Filter)}>
            {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <span className="small muted" role="status">{shown.length === latest.length ? `${latest.length} compan${latest.length === 1 ? 'y' : 'ies'}` : `${shown.length} of ${latest.length} companies`}</span>
        </div>
        <div className="legend" aria-hidden="true">
          <span><i className="lg-band" />Our value range, cautious (bear) to hopeful (bull)</span>
          <span><i className="lg-mkt" />Today’s price</span>
          {Object.values(watch?.history ?? {}).some(h => h.length > 1) && <span><i className="lg-line ours" />Base value and <i className="lg-line mkt" />price, day by day</span>}
        </div>
        {shown.length === 0
          ? <p className="pad-s">No company matches “{FILTERS[filter]}”. <button type="button" className="link" onClick={() => setFilter('all')}>Show all companies</button></p>
          : <ul className="cov">{shown.map(m => <Row key={m.id} m={m} hist={watch?.history[slugOf(m.id)]} busy={!!busy} onDelete={remove} />)}</ul>}
        {older.length > 0 && <details className="fold older">
          <summary>{older.length} older saved day{older.length > 1 ? 's' : ''} (earlier versions of these models)</summary>
          <ul className="cov">{older.map(m => <Row key={m.id} m={m} old busy={!!busy} onDelete={remove} />)}</ul>
        </details>}
      </section>
      <WatchSection list={watch} models={latest} onChange={setWatch}
        onBuild={sym => { setAdding(sym); window.scrollTo({ top: 0 }) }} />
      <footer className="foot">
        <p>Works for manufacturing, services and other non-financial companies; banks, NBFCs and insurers aren’t
          supported. Models save themselves to the <code>models</code> folder next to the app. Analysis, not a
          recommendation: no management access or channel checks.</p>
      </footer>
    </main>
  )
}

/** One company on the coverage list: name and status, price against our range (with its day-by-day history), what
 * the price assumes, upside to our base, warning signs and results. */
function Row({ m, old, hist, busy, onDelete }: { m: ModelSummary; old?: boolean; hist?: Parameters<typeof Spark>[0]['pts']; busy: boolean; onDelete: (m: ModelSummary) => void }) {
  const up = upside(m)
  return (
    <li className={`cov-row${old ? ' old' : ''}`}>
      <a className="cov-open" href={pathOf(slugOf(m.id), m.values?.base == null ? 'forecast' : 'overview', '', old ? m.id.split('/')[1] : null)}>
        <span className="co"><strong>{m.company}</strong>
          <span>{m.symbol ? `NSE: ${m.symbol} · ` : ''}changed {m.saved_at ? when(m.saved_at) : '–'} · {NAMES[m.active]} · {m.n} yrs
            {m.reviewed_at ? ' · reviewed' : ' · draft'}{old ? ' · older version' : ''}</span></span>
        <span className="rng">
          <MiniRange price={m.price ?? null} bear={m.values?.bear ?? null} base={m.values?.base ?? null} bull={m.values?.bull ?? null} />
          {!old && <Spark pts={hist} />}
        </span>
        <span className="pf">{coverText(m)}{!old && <PriceNote m={m} />}</span>
        <span className="fl">
          {up != null && <span className={`up num${up >= 0 ? ' ours' : ''}`} title="Our base value against today’s price">{up >= 0 ? '+' : '−'}{fmt(Math.abs(up), 'pct')}<span className="small"> {up >= 0 ? 'base above price' : 'base below price'}</span></span>}
          {!old && m.new_results?.length ? <span className="tag prop">New {m.new_results.join(', ')} results</span> : null}
          <span>{m.flags == null ? '' : m.flags ? `${m.flags} warning sign${m.flags > 1 ? 's' : ''}` : 'No warning signs'}</span>
          {m.results_to && <span className="small muted">Results to {month(m.results_to)}</span>}
        </span>
      </a>
      <button type="button" className="link lib-del" disabled={busy} onClick={() => onDelete(m)}
        aria-label={`Delete ${m.company}, saved ${m.saved_at ? when(m.saved_at) : 'earlier'}`}>Delete</button>
    </li>
  )
}

/** Where the price came from when it isn't the one saved in the model. */
function PriceNote({ m }: { m: ModelSummary }) {
  if (!m.symbol) return null
  if (!m.price_live) return <><br /><span className="small muted">Price saved with the model, {ago(m.price_at)}</span></>
  const moved = m.price_saved && m.price != null ? m.price / m.price_saved - 1 : null
  return moved != null && Math.abs(moved) >= 0.005
    ? <><br /><span className="small muted">Today’s price, {moved > 0 ? 'up' : 'down'} {fmt(Math.abs(moved), 'pct')} since the model was saved; open it and Refresh to keep it there</span></>
    : null
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
  const failed = results.filter(r => r.status === 'failed').length
  return (
    <div className="check-all" aria-busy={running}>
      <div className="ca-row">
        <button type="button" className="btn" onClick={run} disabled={running}>{running ? 'Checking…' : 'Check all for new results'}</button>
        {running && <button type="button" className="link" onClick={() => { ctl.current?.abort(); setState('stopped') }}>Stop</button>}
        <span className="small muted">{running ? step ?? 'Starting…'
          : state === 'done' ? `Done: ${found ? `new results for ${found} compan${found > 1 ? 'ies' : 'y'}, saved` : failed ? 'nothing new found' : 'nothing new'}${failed
            ? `; couldn’t check ${failed} compan${failed > 1 ? 'ies' : 'y'}, so try again when NSE can be reached` : ''}.`
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
