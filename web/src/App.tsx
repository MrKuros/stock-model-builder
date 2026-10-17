import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { withFlagNotes, withNotes } from './Sources'
import Note from './Note'
import ModelView, { UPGRADED, type Upgrade } from './Model'
import Evidence from './Evidence'
import {
  api, defaultPaths, flat, fmt, groupKeys, money, postJson, rs, seed, when, clock, SCENARIOS,
  type ModelDoc, type ModelSummary, type Opened, type Parsed, type Projection, type Proposal, type Scenario,
} from './lib'

const LAST = 'financial-model:last' // id of the last open model; the model itself lives in models/ on disk
const THEME = 'financial-model:theme'
const SAVE_DELAY = 1500
const NAMES: Record<Scenario, string> = { base: 'Base', bull: 'Bull', bear: 'Bear' }

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

/** Light / dark: the system's unless picked here; the pick is kept per browser (index.html applies it before paint). */
function toggleTheme() {
  const r = document.documentElement
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  r.dataset.theme = dark ? 'light' : 'dark'
  try { localStorage.setItem(THEME, r.dataset.theme) } catch { /* private mode */ }
}

// a re-import of a saved company keeps its filings, proposals, notes and reports (p.defaults already use them)
const newDoc = (p: Parsed): ModelDoc => ({
  version: 6, company: p.company, n: 5, active: 'base', scenarios: seed(defaultPaths(p.defaults, p.default_ends)),
  excluded_years: [], saved_at: null, valuation: p.valuation, filings: [], proposals: [], notes: {}, reports: [],
  note: null, assumption_sources: {}, flag_notes: [], reviewed_at: null,
  ...p.restated?.carry,
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
    // keepalive: still goes out if the tab is closing; browsers refuse keepalive bodies over 64 KB
    if (d) send(d, JSON.stringify(d).length < 60_000)
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
    if (!/^#(note|model|evidence)/.test(location.hash)) history.replaceState(null, '', '#note') // old models open into the note
  }
  const close = async () => {
    if ((await flush()) === false) return // stay: the "Not saved … Try again" alert is showing, nothing is lost
    gen.current++
    remember(null)
    setParsed(null)
    setDoc(null)
    history.replaceState(null, '', location.pathname)
  }

  useEffect(() => {
    const id = lastId()
    if (!id) return
    api<Opened>(`/api/models/${id}`).then(open).catch(() => remember(null)).finally(() => setBooting(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (booting) return <main className="wrap"><p className="muted pad" role="status">Opening your last model…</p></main>
  return parsed && doc
    ? <Workspace parsed={parsed} doc={doc} setDoc={f => setDoc(d => d && f(d))} onClose={close} save={save}
        onRetry={flush} setDefaults={defaults => setParsed(p => p && { ...p, defaults })}
        setParsed={next => setParsed(p => p && { ...next, restated: p.restated })} />
    : <Landing onOpen={open} />
}

const Brand = ({ onClick }: { onClick?: () => void }) => {
  const mark = <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="14" width="6" height="14" fill="currentColor" />
    <rect x="13" y="8" width="6" height="20" fill="currentColor" />
    <rect x="22" y="3" width="6" height="25" fill="none" stroke="var(--ours)" strokeWidth="2.4" /></svg>
  return onClick
    ? <button type="button" className="brand" onClick={onClick} aria-label="Stock Model Builder: all companies">{mark}Stock Model Builder</button>
    : <span className="brand">{mark}Stock Model Builder</span>
}
const ThemeButton = () => (
  <button className="tbtn" type="button" onClick={toggleTheme} aria-label="Switch light or dark theme">
    <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" /></svg><span className="t-l">Theme</span>
  </button>
)

/** Coverage: every saved model with its price against our value range, then the add-company panel. */
function Landing({ onOpen }: { onOpen: (o: Opened) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [models, setModels] = useState<ModelSummary[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const libHead = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    api<ModelSummary[]>('/api/models').then(setModels)
      .catch(e => { setModels([]); setError(`Couldn’t list saved models: ${e.message}`) })
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
      setModels(ms => ms && ms.filter(x => x.id !== m.id))
      ;((models?.length ?? 0) > 1 ? libHead : input).current?.focus() // the focused row is gone
    } catch (e) { setError((e as Error).message) }
  }

  // newest version of each company leads; older days follow, dimmed
  const seen = new Set<string>()
  const rows = (models ?? []).map(m => ({ m, latest: !seen.has(m.company) && !!seen.add(m.company) }))
  const latest = rows.filter(r => r.latest).map(r => r.m)
  const below = latest.filter(m => m.price != null && m.values?.bear != null && m.price < m.values.bear).length
  const above = latest.filter(m => m.price != null && m.values?.bull != null && m.price > m.values.bull).length
  const count = (k: number, one: string) => `${k === 1 ? 'One company is' : `${k} companies are`} ${one}`
  const headline = !latest.length ? 'Open a company to get a research note.'
    : below ? `${count(below, 'priced below our bear case')}.`
    : above ? `${count(above, 'priced above our bull case')}.`
    : `${latest.length === 1 ? 'One company' : `${latest.length} companies`} covered, all priced inside our range.`

  return (
    <>
      <a className="skip" href="#main">Skip to the companies</a>
      <header className="top"><div className="top-in"><Brand /><span className="spacer" /><ThemeButton /></div></header>
      <main id="main" className="wrap">
        <div className="land-head">
          <div>
            <p className="label">Coverage · <b>computed by rules</b> · base case</p>
            <h1>{models == null ? 'Your companies' : headline}</h1>
            <p className="lede">Each note leads with what the price assumes against what the business does: the growth
              the price needs, our value range, and the rule checks behind it. Analysis, not a recommendation.</p>
          </div>
          <div className="add">
            <label className={`drop ${over ? 'is-over' : ''}`} aria-busy={!!busy}
              onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
              onDrop={e => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]) }}>
              <input ref={input} type="file" accept=".xlsx" className="sr" disabled={!!busy}
                onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} />
              <strong>{busy ?? 'Add a company'}</strong>
              {!busy && <span>Drop a Export.in export here, or <u>choose a file</u> (.xlsx)</span>}
            </label>
            <p className="small muted">On export.in open the company and click <b>Export to Excel</b> (free account).{' '}
              <button type="button" className="link" disabled={!!busy}
                onClick={() => run('Loading sample…', async () => ({ parsed: await api<Parsed>('/api/sample') }))}>
                Try a sample company</button> (made-up numbers).</p>
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        </div>

        {rows.length > 0 && (
          <section aria-labelledby="library-head">
            <h2 id="library-head" ref={libHead} tabIndex={-1} className="label sec-label">
              <span>Companies · <b>price against our value range</b></span><span>newest first</span>
            </h2>
            <ul className="cov">
              {rows.map(({ m, latest }) => (
                <li key={m.id} className={`cov-row${latest ? '' : ' old'}`}>
                  <button type="button" className="cov-open" disabled={!!busy}
                    onClick={() => run(`Opening ${m.company}…`, () => api<Opened>(`/api/models/${m.id}`))}>
                    <span className="co"><strong>{m.company}</strong>
                      <span>{m.saved_at ? when(m.saved_at) : '–'} · {NAMES[m.active]} · {m.n} yrs
                        {m.reviewed_at ? ' · reviewed' : ' · draft'}</span></span>
                    <MiniRange m={m} />
                    <span className="pf">{coverText(m)}</span>
                    <span className="fl">{m.flags == null ? '' : m.flags ? `${m.flags} flag${m.flags > 1 ? 's' : ''}` : 'No flags'}</span>
                  </button>
                  <button type="button" className="link lib-del" disabled={!!busy} onClick={() => remove(m)}
                    aria-label={`Delete ${m.company}, saved ${m.saved_at ? when(m.saved_at) : 'earlier'}`}>Delete</button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <footer className="foot">
          <p>Works for manufacturing, services and other non-financial companies; banks, NBFCs and insurers aren’t
            supported. Models save themselves to the <code>models</code> folder next to the app. Analysis, not a
            recommendation: no management access or channel checks.</p>
        </footer>
      </main>
    </>
  )
}

function coverText(m: ModelSummary): ReactNode {
  if (m.values?.base == null) return <span className="muted">No value yet: {m.why ?? 'open it to see why'}</span>
  if (m.implied != null && m.growth != null)
    return <>Priced for <span className="num mkt">{fmt(m.implied, 'pct')}</span> / ours <span className="num ours">{fmt(m.growth, 'pct')}</span></>
  if (m.price == null) return <>Base <span className="num ours">Rs {rs(m.values.base)}</span>, no price</>
  return <>Base <span className="num ours">Rs {rs(m.values.base)}</span>, no growth rate reaches the price</>
}

/** Price (ochre) against bear-bull (blue band) and base (blue tick) on one small scale. */
function MiniRange({ m }: { m: ModelSummary }) {
  const v = m.values
  const pts = [m.price, v?.bear, v?.base, v?.bull].filter((x): x is number => x != null)
  if (!v || v.base == null || pts.length < 2) return <span className="mini" aria-hidden="true" />
  const lo = Math.min(...pts), hi = Math.max(...pts), pad = (hi - lo || 1) * 0.08
  const x = (n: number) => `${((n - lo + pad) / (hi - lo + 2 * pad)) * 100}%`
  const label = `Bear Rs ${v.bear == null ? '–' : rs(v.bear)}, base Rs ${rs(v.base)}, bull Rs ${v.bull == null ? '–' : rs(v.bull)}` +
    (m.price != null ? `, price Rs ${rs(m.price)}` : '')
  return (
    <span className="mini" role="img" aria-label={label}>
      <i className="ax" />
      {v.bear != null && v.bull != null && <i className="bd" style={{ left: x(v.bear), width: `calc(${x(v.bull)} - ${x(v.bear)})` }} />}
      <i className="bs" style={{ left: x(v.base) }} />
      {m.price != null && <i className={`px${m.price > (lo + hi) / 2 ? ' r' : ''}`} style={{ left: x(m.price) }}><span>{rs(m.price)}</span></i>}
    </span>
  )
}

export type View = 'note' | 'model' | 'evidence'
const VIEWS: [View, string, string][] = [['note', 'Note', 'N'], ['model', 'Model', 'M'], ['evidence', 'Evidence', 'E']]
const readHash = (): [View, string] => {
  const [v, a = ''] = location.hash.slice(1).split(':')
  return [(VIEWS.some(x => x[0] === v) ? v : 'note') as View, a]
}
/** Go to a view (and an element in it): the hash keeps the tab across reloads and works with Back. */
export type Go = (view: View, anchor?: string) => void

interface WorkspaceProps {
  parsed: Parsed
  doc: ModelDoc
  setDoc: (f: (d: ModelDoc) => ModelDoc) => void
  setDefaults: (d: Record<string, number>) => void
  setParsed: (p: Parsed) => void // the dashboard payload again, after the filings changed
  onClose: () => void
  save: SaveState
  onRetry: () => Promise<string | false>
}

function Workspace({ parsed, doc, setDoc: setDocRaw, setDefaults, setParsed, onClose, save, onRetry }: WorkspaceProps) {
  const { company, years: histYears, drivers } = parsed
  const { n, scenarios, valuation, filings, notes, flag_notes, assumption_sources, excluded_years } = doc
  // any change to what the numbers come from puts the note back to draft; an input changed without a new source
  // (a strip, a typed value) is yours: its source flips to "manual"
  const setDoc = (f: (d: ModelDoc) => ModelDoc) => setDocRaw(d => {
    let x = f(d)
    if (x.scenarios !== d.scenarios && x.assumption_sources === d.assumption_sources) {
      const src = { ...d.assumption_sources }
      for (const s of SCENARIOS) for (const k of Object.keys(x.scenarios[s]))
        if (JSON.stringify(x.scenarios[s][k]) !== JSON.stringify(d.scenarios[s][k])) src[s] = { ...src[s], [k]: 'manual' }
      x = { ...x, assumption_sources: src }
    }
    const moved = x.scenarios !== d.scenarios || x.valuation !== d.valuation || x.n !== d.n || x.filings !== d.filings
      || x.excluded_years !== d.excluded_years
    return moved && x.reviewed_at ? { ...x, reviewed_at: null } : x
  })
  const [projection, setProjection] = useState<Projection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [retried, setRetried] = useState<string | null>(null)
  const [[view, anchor], setRoute] = useState(readHash)
  const back = useRef<HTMLButtonElement>(null)
  // where you were in each view, so Back from an evidence row returns to your place in the note (memory only)
  const pos = useRef<Partial<Record<View, number>>>({})
  const viewNow = useRef(view)
  viewNow.current = view
  const hist = parsed.hist ?? company.hist
  const nHist = hist.length

  useEffect(() => {
    const on = () => { pos.current[viewNow.current] = window.scrollY; setRoute(readHash()) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go: Go = (v, a) => {
    const h = `#${v}${a ? `:${a}` : ''}`
    pos.current[view] = window.scrollY
    if (location.hash === h) setRoute([v, a ?? '']) // same link again: scroll to it again
    else location.hash = h
  }
  // after a view switch, bring the anchored element (a strip cell's evidence row, a model input) into view
  useEffect(() => {
    if (!anchor) {
      window.scrollTo({ top: pos.current[view] ?? 0 }) // ponytail: the scroll comes back, focus doesn't (the row it left is gone)
      return
    }
    const t = window.setTimeout(() => {
      const el = document.getElementById(`a-${anchor}`) ?? document.getElementById(anchor)
      // a tall section starts at the top (under the sticky bar: scroll-padding-top); a small target is centred
      if (el) { el.scrollIntoView({ block: el.offsetHeight > innerHeight * 0.6 ? 'start' : 'center' }); (el.matches('button, a, [tabindex]') ? el : el.querySelector<HTMLElement>('button, a, [tabindex]') ?? el).focus?.({ preventScroll: true }) }
    }, 30)
    return () => window.clearTimeout(t)
  }, [view, anchor, projection != null])
  // N / M / E switch views, unless typing
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return
      const v = VIEWS.find(x => x[2] === e.key.toUpperCase())
      if (v) { e.preventDefault(); go(v[0]) }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ctl = new AbortController()
    // the words' sources go too: they don't move a number, only the note's inputs hash (stale words)
    api<Projection>('/api/project', postJson({ company, scenarios, n, valuation, filings, notes, flag_notes, assumption_sources, excluded_years }, ctl.signal))
      .then(p => { setProjection(p); setError(null) })
      .catch(e => { if (e.name !== 'AbortError') { setProjection(null); setError(e.message) } })
    return () => ctl.abort()
  }, [company, scenarios, n, valuation, filings, notes, flag_notes, assumption_sources, excluded_years])

  // A filing attached or removed changes the history (payables, leases, cash-flow capex) and so the defaults; like
  // excluding a year, it never changes the assumptions by itself. The upgraded defaults are offered in one click.
  const filingIds = JSON.stringify([filings.map(f => [f.id, f.facts]), Object.entries(notes).filter(([k]) => k.startsWith('ar:'))])
  const seenIds = useRef(filingIds)
  const [upgrades, setUpgrades] = useState<Upgrade[]>([])
  const byKey = Object.fromEntries(drivers.map(d => [d[0], d]))
  useEffect(() => {
    if (filingIds === seenIds.current) return
    seenIds.current = filingIds
    const before = parsed.defaults
    api<Parsed>('/api/company', postJson({ company, excluded_years: doc.excluded_years, filings, notes }))
      .then(p => {
        setParsed(p)
        const keys = UPGRADED.filter(k => upgrades.some(u => u.key === k) || Math.abs((p.defaults[k] ?? 0) - (before[k] ?? 0)) > 1e-9)
        setUpgrades(keys.filter(k => p.defaults[k] != null && Math.abs((scenarios.base[k]?.start ?? 0) - p.defaults[k]) > 1e-9)
          .map(k => ({ key: k, label: byKey[k]?.[1] ?? k, kind: byKey[k]?.[2] ?? 'pct', from: scenarios.base[k]?.start ?? 0, to: p.defaults[k] })))
      })
      .catch(e => setError((e as Error).message))
  }, [filingIds]) // eslint-disable-line react-hooks/exhaustive-deps
  const applyUpgrades = () => {
    const next = Object.fromEntries(upgrades.map(u => [u.key, flat(u.to)]))
    const hist = Object.fromEntries(upgrades.map(u => [u.key, 'history']))
    setDoc(d => ({ ...d, scenarios: { base: { ...d.scenarios.base, ...next }, bull: { ...d.scenarios.bull, ...next },
      bear: { ...d.scenarios.bear, ...next } }, assumption_sources: Object.fromEntries(SCENARIOS.map(s => [s, { ...d.assumption_sources[s], ...hist }])) }))
    setUpgrades([])
  }
  const onProposals = (f: (ps: Proposal[]) => Proposal[]) =>
    setDoc(d => {
      const proposals = f(d.proposals)
      return { ...d, proposals, notes: withNotes(d.notes, proposals), flag_notes: withFlagNotes(proposals) }
    })

  const [pendingYear, setPendingYear] = useState<string | null>(null)
  const [defaultsNote, setDefaultsNote] = useState('')
  const toggleYear = async (year: string) => {
    if (pendingYear) return
    const ex = doc.excluded_years
    const next = ex.includes(year) ? ex.filter(y => y !== year) : [...ex, year]
    setPendingYear(year)
    try {
      const d = await api<Record<string, number>>('/api/defaults', postJson({ company, excluded_years: next, filings, notes }))
      setDefaults(d)
      setDoc(doc => ({ ...doc, excluded_years: next }))
      setDefaultsNote(`Defaults ${next.length ? `now leave out ${histYears.filter(y => next.includes(y)).join(', ')}` : 'use every year again'}. ` +
        'Your assumptions haven’t changed; Reset applies the new defaults to a scenario.')
    } catch (e) { setError((e as Error).message) } finally { setPendingYear(null) }
  }

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/export', postJson({ company, scenarios, active: doc.active, n, valuation, filings, notes }))
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? 'Export failed. Try again.')
      const url = URL.createObjectURL(await res.blob())
      const link = Object.assign(document.createElement('a'), { href: url, download: `${company.name} model.xlsx` })
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) { setError((e as Error).message) } finally { setExporting(false) }
  }
  const retry = async () => {
    const at = await onRetry()
    if (at) { setRetried(at); back.current?.focus() }
  }

  const proj = projection?.scenarios.base.length === n ? projection : null // null while a new horizon loads
  const m = company.market
  const price = valuation.price ?? m?.price ?? null
  const shares = valuation.shares ?? m?.shares ?? null
  const fromDocs = Object.values(doc.assumption_sources.base ?? {}).filter(v => v !== 'manual' && v !== 'history').length
  const ai = Object.values(notes).some(x => (x as { ai?: boolean })?.ai) || doc.note != null || doc.flag_notes.length > 0
  const tabs = useMemo(() => VIEWS, [])

  return (
    <>
      {/* not a hash link for the router: "#main" would read as an unknown view and open the note */}
      <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to the {view}</a>
      <header className="top">
        <div className="top-in">
          <Brand onClick={onClose} />
          <span className="crumb" aria-hidden="true">/ <strong>{company.name}</strong></span>
          <nav aria-label="Views of this company">
            <div className="views" role="tablist" aria-label="View">
              {tabs.map(([v, label, key]) => (
                <button key={v} type="button" role="tab" id={`tab-${v}`} aria-selected={view === v} aria-controls="view"
                  tabIndex={view === v ? 0 : -1} aria-keyshortcuts={key} onClick={() => go(v)}
                  onKeyDown={e => groupKeys(e, tabs.map(t => t[0]), view, v => go(v))}>
                  {label}<kbd aria-hidden="true">{key}</kbd>
                </button>
              ))}
            </div>
          </nav>
          <span className="spacer" />
          <ThemeButton />
          <button type="button" className="tbtn" onClick={exportXlsx} disabled={!proj || exporting} aria-label={exporting ? 'Exporting to Excel' : 'Export to Excel'}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3 3-3M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            <span className="t-l">{exporting ? 'Exporting…' : 'Excel'}</span>
          </button>
        </div>
      </header>

      <div className="wrap">
        <p className="meta">
          <span className="meta-co">{company.name}</span>
          <span className="meta-x">Rs crore · reported {histYears[0]}–{histYears[nHist - 1]}</span>
          {price != null
            ? <span>Price <span className="num mkt">Rs {rs(price)}</span> {valuation.price != null ? '(typed)' : 'in the export'}</span>
            : <span>No share price</span>}
          {price != null && shares != null && <span className="meta-x">Market cap <span className="num">Rs {money(price * shares)} cr</span></span>}
          {save.at && !save.error && <span className="meta-x">Saved {clock(save.at)}</span>}
        </p>
        <div className="review" aria-label="Review status">
          <span className={`rv-state${doc.reviewed_at ? ' done' : ''}`}>
            {doc.reviewed_at ? <>● Reviewed {when(doc.reviewed_at)}</> : <>○ Draft, not reviewed by you</>}
          </span>
          <span className="chip">Numbers: rules, from your Export export{filings.length ? ', filings' : ''}{fromDocs ? `, ${fromDocs} input${fromDocs > 1 ? 's' : ''} drafted from documents and approved` : ''} and your inputs</span>
          <span className="chip serif">Words: {ai ? 'AI-written, cited' : 'none by AI yet'}</span>
          <button type="button" className="btn"
            onClick={() => setDocRaw(d => ({ ...d, reviewed_at: d.reviewed_at ? null : new Date().toISOString() }))}>
            {doc.reviewed_at ? 'Mark as draft' : 'Mark as reviewed'}
          </button>
          <button ref={back} type="button" className="link small" onClick={onClose}>All companies</button>
        </div>
        <div className="status" aria-live="polite">
          {retried != null && retried === save.at && !save.error && <span className="ok">Saved</span>}
          {error && <span className="bad" role="alert">{error}</span>}
          {save.error && <span className="bad" role="alert">Not saved: {save.error}{' '}
            <button type="button" className="link" onClick={retry}>Try again</button></span>}
        </div>
      </div>

      <main id="main" className="wrap" tabIndex={-1}>
        <div role="tabpanel" id="view" aria-labelledby={`tab-${view}`}>
        {view === 'note' && <Note parsed={parsed} doc={doc} setDoc={setDoc} projection={proj} go={go} />}
        {view === 'model' && <ModelView parsed={parsed} doc={doc} setDoc={setDoc} projection={proj} anchor={anchor} go={go} />}
        {view === 'evidence' && <Evidence parsed={parsed} doc={doc} setDoc={setDoc} projection={proj} go={go}
          upgrades={upgrades} onApply={applyUpgrades} onProposals={onProposals} toggleYear={toggleYear}
          pendingYear={pendingYear} defaultsNote={defaultsNote} />}
        </div>
      </main>
    </>
  )
}
