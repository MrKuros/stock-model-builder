import { useEffect, useMemo, useRef, useState } from 'react'
import Chart from './Chart'
import DriverStrip from './DriverStrip'
import Statements from './Statements'
import {
  api, flat, flatAll, fmt, groupKeys, money, postJson, seed, SCENARIOS, when, clock,
  type ModelDoc, type ModelSummary, type OneOff, type Opened, type Parsed, type Paths, type Projection, type Row,
  type Scenario,
} from './lib'

const GROUPS: [string, string[]][] = [
  ['Growth and margins', ['growth', 'ebitda_margin', 'oi_pct']],
  ['Investment', ['capex_pct', 'dep_pct']],
  ['Working capital', ['dso', 'dio', 'oca_pct', 'ol_pct']],
  ['Financing and tax', ['debt_change', 'int_rate', 'tax_rate', 'mi_pct', 'payout']],
]
const HINTS: Record<string, string> = {
  growth: 'Change in sales vs the year before',
  ebitda_margin: 'Operating profit before depreciation, share of sales',
  oi_pct: 'Treasury and non-operating income, share of sales',
  capex_pct: 'Spend on new fixed assets, share of sales',
  dep_pct: 'Share of last year’s net block written off',
  dso: 'Days of sales waiting to be collected',
  dio: 'Days of sales held as stock',
  oca_pct: 'Advances, deposits and other current assets',
  ol_pct: 'Payables, provisions and other liabilities',
  debt_change: 'Net new debt you plan each year. Shortfalls are borrowed automatically',
  int_rate: 'Interest as share of last year’s borrowings',
  tax_rate: 'Tax as share of profit before tax',
  mi_pct: 'Associates’ profit added, minority holders’ share taken out',
  payout: 'Share of net profit paid as dividend',
}
const METRICS: [string, string, (r: Row) => number | null][] = [
  ['revenue', 'Revenue', r => r.revenue],
  ['ebitda', 'EBITDA', r => r.ebitda],
  ['pat', 'Net profit', r => r.pat],
  ['fcf', 'Free cash flow', r => r.fcf],
  ['net_cash', 'Net cash', r => (r.cash ?? 0) + (r.investments ?? 0) - (r.borrowings ?? 0)],
]
const HORIZONS = [3, 5, 7, 10]
const NAMES: Record<Scenario, string> = { base: 'Base', bull: 'Bull', bear: 'Bear' }
const LAST = 'financial-model:last' // id of the last open model; the model itself lives in models/ on disk
const SAVE_DELAY = 1500

function lastId(): string | null {
  try { return localStorage.getItem(LAST) } catch { return null }
}
function remember(id: string | null) {
  try {
    localStorage.removeItem('financial-model:v4') // whole sessions lived here before the library
    if (id) localStorage.setItem(LAST, id)
    else localStorage.removeItem(LAST)
  } catch { /* private mode */ }
}

const newDoc = (p: Parsed): ModelDoc => ({
  version: 3, company: p.company, n: 5, active: 'base', scenarios: seed(flatAll(p.defaults)),
  excluded_years: [], saved_at: null,
})

export interface SaveState { at: string | null; error: string | null }

export default function App() {
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [doc, setDoc] = useState<ModelDoc | null>(null)
  const [booting, setBooting] = useState(() => lastId() != null)
  const [save, setSave] = useState<SaveState>({ at: null, error: null })
  const clean = useRef<ModelDoc | null>(null) // the doc as opened from disk: nothing to save until it changes
  const pending = useRef<ModelDoc | null>(null) // changed, not yet saved
  const timer = useRef<number>()
  const gen = useRef(0) // bumped on open and close: a late save reply for an earlier model must not touch this one
  const inflight = useRef<Promise<string | false>>(Promise.resolve('')) // the last save: its saved_at, or false if it failed

  const send = (d: ModelDoc, keepalive = false) => {
    const g = gen.current
    inflight.current = api<{ id: string; saved_at: string }>('/api/models', { ...postJson(d), keepalive })
      .then(r => {
        if (g === gen.current) { remember(r.id); setSave({ at: r.saved_at, error: null }) }
        return r.saved_at
      })
      .catch(e => {
        if (g === gen.current) { pending.current ??= d; setSave(s => ({ ...s, error: (e as Error).message })) }
        return false as const
      })
    return inflight.current
  }
  const flush = () => {
    window.clearTimeout(timer.current)
    const d = pending.current
    pending.current = null
    if (d) send(d, true) // keepalive: still goes out if the tab is closing (docs are ~10-20 KB, under the 64 KB cap)
    return inflight.current
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  // autosave: debounced, so a drag saves once when it settles
  useEffect(() => {
    if (!doc || doc === clean.current) return
    pending.current = doc
    timer.current = window.setTimeout(() => flushRef.current(), SAVE_DELAY)
    return () => window.clearTimeout(timer.current)
  }, [doc])
  useEffect(() => {
    const out = () => flushRef.current()
    window.addEventListener('pagehide', out)
    return () => window.removeEventListener('pagehide', out)
  }, [])

  const open = ({ parsed, doc, id }: Opened) => {
    const d = doc ?? newDoc(parsed)
    clean.current = doc ? d : null // a fresh upload is saved straight away; a reopened one only once edited
    window.clearTimeout(timer.current)
    pending.current = null
    gen.current++
    inflight.current = Promise.resolve('')
    if (id) remember(id)
    setSave({ at: doc?.saved_at ?? null, error: null })
    setParsed(parsed)
    setDoc(d)
  }
  const close = async () => {
    if ((await flush()) === false) return // stay: the "Not saved … Try again" alert is showing, nothing is lost
    gen.current++
    remember(null)
    setParsed(null)
    setDoc(null)
  }

  useEffect(() => {
    const id = lastId()
    if (!id) return
    api<Opened>(`/api/models/${id}`).then(open).catch(() => remember(null)).finally(() => setBooting(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (booting) return <main className="landing"><p className="muted" role="status">Opening your last model…</p></main>
  return parsed && doc
    ? <Workspace parsed={parsed} doc={doc} setDoc={f => setDoc(d => d && f(d))} onClose={close} save={save}
        onRetry={flush} setDefaults={defaults => setParsed(p => p && { ...p, defaults })} />
    : <Landing onOpen={open} />
}

function Landing({ onOpen }: { onOpen: (o: Opened) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [models, setModels] = useState<ModelSummary[]>([])
  const input = useRef<HTMLInputElement>(null)
  const libHead = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    api<ModelSummary[]>('/api/models').then(setModels).catch(e => setError(`Couldn’t list saved models: ${e.message}`))
  }, [])

  const run = async (label: string, req: () => Promise<Opened>) => {
    if (busy) return // one load at a time, so a slow earlier upload can't replace a later one
    setBusy(label)
    setError(null)
    try { onOpen(await req()) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const upload = (f: File | undefined) => {
    if (!f) return
    const body = new FormData()
    body.append('file', f)
    run(`Reading ${f.name}…`, async () => ({ parsed: await api<Parsed>('/api/parse', { method: 'POST', body }) }))
  }
  const remove = async (m: ModelSummary) => {
    const date = m.saved_at ? when(m.saved_at) : 'earlier'
    if (!window.confirm(`Delete the ${m.company} model saved ${date}? This can’t be undone.`)) return
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' })
      if (lastId() === m.id) remember(null)
      setModels(ms => ms.filter(x => x.id !== m.id))
      // the button that had focus is gone; with the last row the whole list goes, so land on the file picker
      ;(models.length > 1 ? libHead : input).current?.focus()
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <main className="landing">
      <p className="wordmark">Financial model</p>
      <h1>Turn a company’s reported numbers into a forecast you can steer.</h1>
      <p className="lede">
        Reported years come in <span className="ink-word">ink</span>. You set the future in{' '}
        <span className="pencil-word">pencil</span>, then take it away as a live Excel model.
      </p>

      <label
        className={`drop ${over ? 'is-over' : ''}`}
        aria-busy={!!busy}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]) }}
      >
        <input ref={input} type="file" accept=".xlsx" className="visually-hidden" disabled={!!busy}
          onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} />
        <span className="drop-title">{busy ?? 'Drop a Export.in export here'}</span>
        {!busy && <span className="drop-sub">or <u>choose a file</u> (.xlsx)</span>}
      </label>
      {error && <p className="error" role="alert">{error}</p>}

      {models.length > 0 && (
        <section className="library" aria-labelledby="library-head">
          <h2 id="library-head" ref={libHead} tabIndex={-1}>Recent models</h2>
          <ul>
            {models.map(m => (
              <li key={m.id}>
                <button type="button" className="lib-open" disabled={!!busy}
                  onClick={() => run(`Opening ${m.company}…`, () => api<Opened>(`/api/models/${m.id}`))}>
                  <span className="lib-name">{m.company}</span>
                  <span className="lib-meta">
                    {m.saved_at ? when(m.saved_at) : '–'} · {NAMES[m.active]} · {m.n} yrs
                    {m.revenue != null && <> · revenue <span className="pencil-num">Rs {money(m.revenue)} cr</span> in {m.year}</>}
                  </span>
                </button>
                <button type="button" className="link lib-del" disabled={!!busy} onClick={() => remove(m)}
                  aria-label={`Delete ${m.company}, saved ${m.saved_at ? when(m.saved_at) : 'earlier'}`}>Delete</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="how">
        <h2>Getting the file</h2>
        <ol>
          <li>Open the company on <a href="https://www.export.in" target="_blank" rel="noreferrer">export.in</a>.</li>
          <li>Click <b>Export to Excel</b>. A free account is needed.</li>
          <li>Drop the downloaded file above.</li>
        </ol>
        <button type="button" className="link" disabled={!!busy}
          onClick={() => run('Loading sample…', async () => ({ parsed: await api<Parsed>('/api/sample') }))}>
          Explore with a sample company
        </button>
        <span className="muted"> (made-up numbers)</span>
      </div>
      <p className="scope muted">Works for manufacturing, services and other non-financial companies. Banks, NBFCs and insurers aren’t supported yet. Models save themselves to the <code>models</code> folder next to the app.</p>
    </main>
  )
}

interface WorkspaceProps {
  parsed: Parsed
  doc: ModelDoc
  setDoc: (f: (d: ModelDoc) => ModelDoc) => void
  setDefaults: (d: Record<string, number>) => void
  onClose: () => void
  save: SaveState
  onRetry: () => Promise<string | false>
}

function Workspace({ parsed, doc, setDoc, setDefaults, onClose, save, onRetry }: WorkspaceProps) {
  const { company, years: histYears, ratios, defaults, checks, drivers, layout } = parsed
  const { n, active, scenarios } = doc
  const a = scenarios[active]
  const setN = (n: number) => setDoc(d => ({ ...d, n }))
  const setActive = (active: Scenario) => setDoc(d => ({ ...d, active }))
  const setA = (f: (p: Paths) => Paths) =>
    setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [d.active]: f(d.scenarios[d.active]) } }))
  const seeded = useMemo(() => seed(flatAll(defaults)), [defaults]) // each scenario's own defaults
  const [projection, setProjection] = useState<Projection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState(METRICS[0][0])
  const [showChecks, setShowChecks] = useState(false)
  const [showOneoffs, setShowOneoffs] = useState(false)
  const [pending, setPending] = useState<string | null>(null) // year whose exclusion is being applied
  const [defaultsNote, setDefaultsNote] = useState('')
  const [exporting, setExporting] = useState(false)
  const [retried, setRetried] = useState<string | null>(null) // saved_at of a successful "Try again", announced once
  const back = useRef<HTMLButtonElement>(null)
  const retry = async () => {
    const at = await onRetry()
    if (at) { setRetried(at); back.current?.focus() } // the Try again button is gone
  }
  const hist = company.hist
  const nHist = hist.length

  useEffect(() => {
    const ctl = new AbortController()
    api<Projection>('/api/project', postJson({ company, scenarios, n }, ctl.signal))
      .then(p => { setProjection(p); setError(null) })
      .catch(e => { if (e.name !== 'AbortError') { setProjection(null); setError(e.message) } })
    return () => ctl.abort()
  }, [company, scenarios, n])

  const proj = projection?.scenarios[active].length === n ? projection.scenarios[active] : null // null while a new horizon loads
  const projYears = proj ? projection!.years : []
  const years = [...histYears, ...projYears]
  const rows = proj ? [...hist, ...proj] : hist

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/export', postJson({ company, scenarios, active, n }))
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? 'Export failed. Try again.')
      const url = URL.createObjectURL(await res.blob())
      const link = Object.assign(document.createElement('a'), { href: url, download: `${company.name} model.xlsx` })
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) { setError((e as Error).message) } finally { setExporting(false) }
  }

  const byKey = Object.fromEntries(drivers.map(d => [d[0], d]))
  const balanced = proj?.every(r => Math.abs(r.chk_bs ?? 0) < 0.5 && Math.abs(r.chk_cash ?? 0) < 0.5)
  const borrowed = proj ? proj.reduce((s, r) => s + (r.revolver ?? 0), 0) : 0
  const m = METRICS.find(x => x[0] === metric)!
  const others = proj ? SCENARIOS.filter(s => s !== active).map(s => ({
    name: s, values: [...hist.map(() => null), ...projection!.scenarios[s].map(m[2])],
  })) : []
  const copyBase = () => {
    const next = seed(scenarios.base)
    const edited = (['bull', 'bear'] as const).some(s => JSON.stringify(scenarios[s]) !== JSON.stringify(next[s]))
    if (edited && !window.confirm('Replace your bull and bear assumptions with base ± 3 pp growth and ± 1.5 pp EBITDA margin?')) return
    setDoc(d => ({ ...d, scenarios: next }))
  }

  const excluded = doc.excluded_years
  const oneoffYears = Object.entries(parsed.oneoffs.reduce<Record<string, OneOff[]>>(
    (g, o) => ({ ...g, [o.year]: [...(g[o.year] ?? []), o] }), {}))
  // fetch first, then store the year and its defaults together, so the two never disagree
  const toggleYear = async (year: string) => {
    if (pending) return // one at a time; the checkbox stays focusable (aria-disabled) so keyboard focus isn't lost
    const next = excluded.includes(year) ? excluded.filter(y => y !== year) : [...excluded, year]
    setPending(year)
    try {
      const d = await api<Record<string, number>>('/api/defaults', postJson({ company, excluded_years: next }))
      setDefaults(d)
      setDoc(doc => ({ ...doc, excluded_years: next }))
      setDefaultsNote(`Defaults ${next.length ? `now leave out ${histYears.filter(y => next.includes(y)).join(', ')}` : 'use every year again'}. ` +
        'Your assumptions haven’t changed; Reset applies the new defaults to a scenario.')
    } catch (e) { setError((e as Error).message) } finally { setPending(null) }
  }

  return (
    <div className="workspace">
      <div className="head-area">
      <header className="top">
        <div className="title">
          <button ref={back} type="button" className="link back" onClick={onClose}>Open another file</button>
          <h1>{company.name}</h1>
          <p className="muted">
            Rs crore · <span className="ink-word">{histYears[0]}–{histYears[nHist - 1]} reported</span>
            {proj && <> · <span className="pencil-word">{projYears[0]}–{projYears[n - 1]} projected</span></>}
            {save.at && !save.error && <> · <span className="saved">Saved {clock(save.at)}</span></>}
          </p>
        </div>
        <div className="actions">
          <div className="segmented" role="radiogroup" aria-label="Scenario">
            {SCENARIOS.map(s => (
              <button key={s} type="button" role="radio" aria-checked={active === s} tabIndex={active === s ? 0 : -1}
                onClick={() => setActive(s)} onKeyDown={e => groupKeys(e, [...SCENARIOS], active, setActive)}>{NAMES[s]}</button>
            ))}
          </div>
          <div className="segmented" role="radiogroup" aria-label="Years to project">
            {HORIZONS.map(h => (
              <button key={h} type="button" role="radio" aria-checked={n === h} tabIndex={n === h ? 0 : -1}
                onClick={() => setN(h)} onKeyDown={e => groupKeys(e, HORIZONS, n, setN)}>{h} yrs</button>
            ))}
          </div>
          <button type="button" className="primary" onClick={exportXlsx} disabled={!proj || exporting}>
            {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
        </div>
      </header>

      <div className="status" aria-live="polite">
        {balanced && <span className="ok">Balance sheet balances in every projected year</span>}
        {checks.length > 0 && (
          <button type="button" className="warn" onClick={() => setShowChecks(s => !s)} aria-expanded={showChecks}>
            {checks.length} issue{checks.length > 1 ? 's' : ''} in the reported data
          </button>
        )}
        {oneoffYears.length > 0 && (
          <button type="button" className="warn" onClick={() => setShowOneoffs(s => !s)} aria-expanded={showOneoffs}
            aria-controls="oneoffs">
            {oneoffYears.length} unusual year{oneoffYears.length > 1 ? 's' : ''}
            {excluded.length > 0 && <> · {excluded.length} left out of defaults</>}
          </button>
        )}
        {retried != null && retried === save.at && !save.error && <span className="ok">Saved</span>}
        {error && <span className="bad" role="alert">{error}</span>}
        {save.error && (
          <span className="bad" role="alert">
            Not saved: {save.error}{' '}
            <button type="button" className="link" onClick={retry}>Try again</button>
          </span>
        )}
      </div>
      {showChecks && <ul className="check-list">{checks.map(c => <li key={c}>{c}</li>)}</ul>}
      {showOneoffs && (
        <OneOffs id="oneoffs" years={oneoffYears} histYears={histYears} excluded={excluded} pending={pending}
          note={defaultsNote} onToggle={toggleYear} />
      )}

      </div>

      <aside className="drivers" aria-label="Assumptions">
        <div className="drivers-head">
          <h2>Assumptions <span className="scen-tag">{NAMES[active]}</span></h2>
          <button type="button" className="link" onClick={() => setA(() => seeded[active])}>Reset {active}</button>
        </div>
        <p className="muted small">
          Strips edit the <b>{active}</b> case. Bull and bear start from base with revenue growth ± 3 pp and EBITDA
          margin ± 1.5 pp; everything else is the same.{' '}
          <button type="button" className="link" onClick={copyBase}>Copy base to bull and bear</button>
        </p>
        <p className="muted small">Dots are reported years. Drag the pencil line, use arrow keys, or type a value. Fade slopes it from the first projected year to the last.</p>
        {GROUPS.map(([group, keys]) => (
          <section key={group} className="group">
            <h3>{group}</h3>
            {keys.filter(k => byKey[k]).map(k => (
              <DriverStrip
                key={`${company.name}-${k}`}
                id={k}
                label={byKey[k][1]}
                hint={HINTS[k] ?? ''}
                kind={byKey[k][2]}
                history={ratios.map(r => r[k])}
                value={a[k] ?? flat(seeded[active][k].start)} // a model saved before this driver existed
                base={seeded[active][k].start}
                baseLabel={k === 'debt_change' ? 'no new debt' : `default ${fmt(seeded[active][k].start, byKey[k][2])}`}
                onChange={v => setA(prev => ({ ...prev, [k]: v }))}
              />
            ))}
          </section>
        ))}
      </aside>

      <main className="main">
        {proj && <Readout hist={hist} proj={proj} histYear={histYears[nHist - 1]} projYear={projYears[n - 1]} n={n} />}
        {proj && <Compare all={projection!.scenarios} active={active} projYear={projYears[n - 1]} />}
        {borrowed >= 0.5 && (
          <p className="banner">
            Cash would run out, so the model borrows <b>Rs {money(borrowed)} cr</b> over {n} years to cover it.
            Lower capex or payout, or set <b>Planned borrowing change per year</b> yourself.
          </p>
        )}
        <section className="chart-card">
          <div className="tabs" role="tablist" aria-label="Chart">
            {METRICS.map(([k, label]) => (
              <button key={k} id={`chart-tab-${k}`} type="button" role="tab" className="tab" aria-selected={metric === k}
                aria-controls="chart-panel" tabIndex={metric === k ? 0 : -1} onClick={() => setMetric(k)}
                onKeyDown={e => groupKeys(e, METRICS.map(x => x[0]), metric, setMetric)}>{label}</button>
            ))}
          </div>
          <div id="chart-panel" role="tabpanel" aria-labelledby={`chart-tab-${metric}`}>
            <Chart title={m[1]} years={years} values={rows.map(m[2])} nHist={nHist} others={others} />
          </div>
        </section>
      </main>
      <div className="tables">
        <Statements layout={layout} years={years} rows={rows} nHist={nHist} />
      </div>
    </div>
  )
}

/** Flagged years as sentences, each with a switch to leave that year out of the defaults. */
function OneOffs({ id, years, histYears, excluded, pending, note, onToggle }: {
  id: string; years: [string, OneOff[]][]; histYears: string[]; excluded: string[]; pending: string | null
  note: string; onToggle: (year: string) => void
}) {
  const used = histYears.filter(y => !excluded.includes(y)).slice(-3) // mirrors default_assumptions(years=3)
  return (
    <section id={id} className="oneoffs" aria-label="Unusual years">
      <p className="muted small">
        Years far from this company’s own history (more than 2σ from its median). Defaults use the last three
        reported years that aren’t left out; revenue growth always uses the last three.
      </p>
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
              <span className="muted small"> Older than the years the defaults use, so excluding it changes nothing.</span>
            )}
          </li>
        ))}
      </ul>
      <p className="oneoff-note" role="status">{note}</p>
    </section>
  )
}

function Readout({ hist, proj, histYear, projYear, n }: { hist: Row[]; proj: Row[]; histYear: string; projYear: string; n: number }) {
  const last = hist[hist.length - 1], end = proj[proj.length - 1]
  const r0 = last.revenue ?? 0, r1 = end.revenue ?? 0
  const cagr = r0 > 0 && r1 > 0 ? (r1 / r0) ** (1 / n) - 1 : null
  const margin = (r: Row) => (r.revenue ? (r.pat ?? 0) / r.revenue : null)
  const fcf = proj.reduce((s, r) => s + (r.fcf ?? 0), 0)
  const netCash = (end.cash ?? 0) + (end.investments ?? 0) - (end.borrowings ?? 0)
  const P = ({ children }: { children: React.ReactNode }) => <span className="pencil-num">{children}</span>

  return (
    <p className="readout">
      Revenue goes from Rs {money(r0)} cr in {histYear} to <P>Rs {money(r1)} cr</P> in {projYear}
      {cagr != null && <>, <P>{fmt(cagr, 'pct')}</P> a year</>}. Net margin moves from {fmt(margin(last), 'pct')} to{' '}
      <P>{fmt(margin(end), 'pct')}</P>. Over {n} years the business {fcf >= 0 ? 'generates' : 'burns'}{' '}
      <P>Rs {money(Math.abs(fcf))} cr</P> of free cash and ends with{' '}
      <P>Rs {money(Math.abs(netCash))} cr</P> net {netCash >= 0 ? 'cash' : 'debt'}.
    </p>
  )
}

/** One line: final-year revenue and net profit in each scenario, low case first. */
function Compare({ all, active, projYear }: { all: Projection['scenarios']; active: Scenario; projYear: string }) {
  const order: Scenario[] = ['bear', 'base', 'bull']
  const list = (k: string) => order.map((s, i) => {
    const v = money(all[s][all[s].length - 1][k])
    return <span key={s}>{i > 0 && ' · '}{s} {s === active ? <b className="pencil-num">{v}</b> : v}</span>
  })
  return (
    <p className="compare">
      In {projYear}, revenue: {list('revenue')} cr. Net profit: {list('pat')} cr.
    </p>
  )
}
