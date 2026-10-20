import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Home from './Home'
import AddPage, { useBuild, watchSymbol, type AddOpts } from './Add'
import Workspace from './Workspace'
import { BottomBar, Finder, HomeRail, KeysDialog, PhoneTop, keysOn, slugOf } from './Shell'
import { ANSWERS, navigate, onLinkClick, pathOf, placed, readRoute, type Route } from './route'
import { api, defaultPaths, postJson, seed, type ModelDoc, type ModelSummary, type Opened, type Parsed, type Report, type WatchList } from './lib'
import { shortName } from './Note'

const LAST = 'financial-model:last' // id of the last open model: only the old #note/#model/#evidence links need it now
const SAVE_DELAY = 1500
const TITLE = 'Stock Model Builder'

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

/** Links from before the app had pages (#note, #model:dso, #evidence:src-head...) open the same place under /c/. */
function oldLink(hash: string, id: string): string | null {
  const m = /^#(note|model|evidence)(?::(.*))?$/.exec(hash)
  if (!m) return null
  const [, v, a = ''] = m, slug = slugOf(id)
  if (v === 'note') return pathOf(slug, 'summary')
  if (v === 'evidence') return pathOf(slug, 'checks', '', null, a === 'oneoffs' ? 'unusual' : a)
  if (a === 'valuation' || a === 'bridge') return pathOf(slug, 'valuation', '', null, a === 'bridge' ? 'bridge' : '')
  if (a === 'statements') return pathOf(slug, 'statements')
  return pathOf(slug, 'forecast', '', null, a)
}

const byId = <T extends { id: string }>(a: T[] = [], b: T[] = []) => [...a, ...b.filter(x => !a.some(y => y.id === x.id))]
// a re-import of a saved company keeps its filings, proposals, notes and reports (p.defaults already use them); a
// company added by ticker brings the filings its years came from and the documents downloaded with it
const newDoc = (p: Parsed, reports: Report[] = []): ModelDoc => ({
  version: 6, company: p.company, n: 5, active: 'base', scenarios: seed(defaultPaths(p.defaults, p.default_ends)),
  excluded_years: [], saved_at: null, valuation: p.valuation, proposals: [], notes: {},
  note: null, assumption_sources: {}, flag_notes: [], reviewed_at: null,
  ...p.restated?.carry,
  filings: byId(p.restated?.carry?.filings, p.fetched?.filings), reports: byId(p.restated?.carry?.reports, reports),
})

export interface SaveState { at: string | null; error: string | null }
/** Tabs of this app tell each other when a model is saved, so a second tab on the same company follows (no polling). */
type Msg = { type: 'saved' | 'deleted'; id: string; saved_at?: string }
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('stock-model-builder') : null

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute)
  const [models, setModels] = useState<ModelSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [doc, setDoc] = useState<ModelDoc | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [missing, setMissing] = useState<string | null>(null) // the address's company couldn't be opened: why
  const [save, setSave] = useState<SaveState>({ at: null, error: null })
  const [notice, setNotice] = useState<string | null>(null) // another tab saved this company
  const openRef = useRef<string | null>(null) // openId, readable from listeners
  const openedVer = useRef<string | null>(null) // the ?v= the open doc was opened for (null: the newest)
  const epoch = useRef(0) // bumped when another company or version opens: a late AI reply for the old one is dropped
  const later = useRef<{ id: string; saved_at: string } | null>(null) // another tab's save that came while ours was pending
  const savedAt = useRef<string | null>(null) // the newest saved_at this tab knows for the open model
  const clean = useRef<ModelDoc | null>(null) // the doc as opened from disk: nothing to save until it changes
  const pending = useRef<ModelDoc | null>(null) // changed, not yet saved
  const timer = useRef<number>()
  const gen = useRef(0) // bumped on open: a late save reply for an earlier model must not touch this one
  const inflight = useRef<Promise<string | false>>(Promise.resolve('')) // the last save: its saved_at, or false if it failed
  const saving = useRef(0) // saves on their way: a save from another tab that lands meanwhile is older than ours
  const routeRef = useRef(route)
  routeRef.current = route
  const lastUrl = useRef('/') // the last company page shown, to go back to when leaving it would lose an unsaved edit

  // ---- routing: path URLs, links handled here, Back/Forward ----
  useEffect(() => {
    history.scrollRestoration = 'manual' // pages render after popstate; Workspace restores the place itself
    // an old #note/#model/#evidence link opens its page under /c/, on a fresh load and on any move inside the app
    // (a link, Back, or the hash typed in the address bar)
    const on = () => {
      const r = readRoute(), old = !r.slug && lastId() ? oldLink(location.hash, lastId()!) : null
      if (old) navigate(old, true) // replaceState: Back never lands on an old address
      else if (r.redirect) navigate(r.redirect, true)
      else setRoute(r)
    }
    window.addEventListener('popstate', on)
    window.addEventListener('hashchange', on)
    window.addEventListener('app:navigate', on)
    document.addEventListener('click', onLinkClick)
    on()
    return () => {
      window.removeEventListener('popstate', on)
      window.removeEventListener('hashchange', on)
      window.removeEventListener('app:navigate', on)
      document.removeEventListener('click', onLinkClick)
    }
  }, [])

  const loadList = useCallback(() => api<ModelSummary[]>('/api/models')
    .then(ms => { setModels(ms); setListError(null); return ms })
    .catch(e => { setModels(ms => ms ?? []); setListError(`Couldn’t list saved models: ${(e as Error).message}`); return null }), [])
  // the coverage list is fresh whenever you come back to it (values move as you edit)
  useEffect(() => { if (!route.slug || models == null) loadList() }, [route.slug]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- autosave: debounced, so a drag saves once when it settles ----
  const send = (d: ModelDoc, keepalive = false) => {
    const g = gen.current
    saving.current++
    inflight.current = api<{ id: string; saved_at: string }>('/api/models', { ...postJson(d), keepalive })
      .finally(() => { saving.current-- })
      .then(r => {
        channel?.postMessage({ type: 'saved', id: r.id, saved_at: r.saved_at } satisfies Msg)
        if (g === gen.current) {
          remember(r.id)
          savedAt.current = r.saved_at
          setSave({ at: r.saved_at, error: null })
          setNotice(null)
          if (openRef.current !== r.id) { // an older version, saved as today's: the address now means the newest
            openRef.current = r.id
            openedVer.current = null
            setOpenId(r.id)
            if (location.search) { history.replaceState(history.state, '', location.pathname + location.hash); setRoute(readRoute()) }
          }
        }
        // another tab saved after ours reached the server: theirs is on disk, so load it (last save wins)
        const l = later.current
        if (l && g === gen.current && saving.current === 0) later.current = null
        if (l && l.saved_at > r.saved_at && g === gen.current && !pending.current && saving.current === 0) {
          api<Opened>(`/api/models/${l.id}`).then(o => {
            if (g !== gen.current || pending.current || saving.current) return
            openDoc(o.parsed, o.doc!, l.id, null)
            setNotice('Another tab saved after you, so this tab now shows its changes.')
          }).catch(() => { /* the next save here wins */ })
        }
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
  useEffect(() => {
    if (!doc || doc === clean.current || openedVer.current) return // an older version is read only: Restore saves it
    pending.current = doc
    timer.current = window.setTimeout(() => flushRef.current(), SAVE_DELAY)
    return () => window.clearTimeout(timer.current)
  }, [doc])
  useEffect(() => {
    const out = () => flushRef.current()
    // leaving with an edit not yet saved (or one the server refused): start the save and let the browser ask first
    const ask = (e: BeforeUnloadEvent) => {
      if (!pending.current && !saving.current) return
      flushRef.current()
      e.preventDefault()
      e.returnValue = '' // older browsers need it set to show the prompt
    }
    window.addEventListener('pagehide', out)
    window.addEventListener('beforeunload', ask)
    return () => { window.removeEventListener('pagehide', out); window.removeEventListener('beforeunload', ask) }
  }, [])

  const openDoc = (p: Parsed, d: ModelDoc, id: string, ver: string | null) => {
    if (!openRef.current || slugOf(openRef.current) !== slugOf(id) || ver !== openedVer.current) epoch.current++
    openedVer.current = ver
    later.current = null
    clean.current = d
    window.clearTimeout(timer.current)
    pending.current = null
    gen.current++
    inflight.current = Promise.resolve('')
    remember(id)
    openRef.current = id
    savedAt.current = d.saved_at
    setOpenId(id)
    setSave({ at: d.saved_at, error: null })
    setParsed(p)
    setDoc(d)
    setMissing(null)
    setNotice(null)
  }

  // ---- open the company the address names (the newest version, or ?v=<date>) ----
  const want = route.slug ? `${route.slug}/${route.version ?? ''}` : null
  useEffect(() => {
    if (!route.slug) return
    setMissing(null)
    const slug = route.slug, version = route.version
    const cur = openRef.current
    if (cur && slugOf(cur) === slug && (version ?? null) === openedVer.current) return
    let live = true
    ;(async () => {
      // leaving a company with an edit the server refused: stay, the "Not saved … Try again" line is showing
      if (cur && (await flushRef.current()) === false) { if (live) navigate(lastUrl.current, true); return }
      let id = version ? `${slug}/${version}` : null
      if (!id) {
        const find = (ms: ModelSummary[] | null) => (ms ?? []).find(m => slugOf(m.id) === slug)?.id ?? null
        id = find(models) ?? find(await loadList()) // newest first; a company another tab just added needs a fresh list
      }
      if (!live) return
      if (!id) { setMissing(`There’s no saved company at this address (${slug}). It may have been deleted.`); return }
      try {
        const o = await api<Opened>(`/api/models/${id}`)
        if (live) openDoc(o.parsed, o.doc!, id, version)
      } catch (e) { if (live) setMissing((e as Error).message) }
    })()
    return () => { live = false }
  }, [want]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- other tabs: a save there reloads this tab's copy (last save wins; nothing changes under your typing) ----
  useEffect(() => {
    if (!channel) return
    let t: number | undefined
    const on = (e: MessageEvent<Msg>) => {
      const m = e.data
      if (!routeRef.current.slug) { window.clearTimeout(t); t = window.setTimeout(loadList, 400); return }
      const cur = openRef.current
      if (m.type !== 'saved' || !cur || slugOf(m.id) !== slugOf(cur) || (m.saved_at ?? '') < (savedAt.current ?? '')) return
      if (pending.current || saving.current) {
        later.current = { id: m.id, saved_at: m.saved_at ?? '' }
        setNotice('Another tab saved changes to this company. Your edits here are newer, so they replace those when they save in a moment.')
        return
      }
      const g = gen.current
      api<Opened>(`/api/models/${m.id}`).then(o => {
        if (g !== gen.current || pending.current || saving.current) return
        openDoc(o.parsed, o.doc!, m.id, null)
        setNotice('Updated with the changes saved in another tab.')
      }).catch(() => { /* the next save here wins */ })
    }
    channel.addEventListener('message', on)
    return () => channel.removeEventListener('message', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keys: / go to, ? the keys, 1-6 the answer pages; never while typing, and not at all when turned off ----
  const [find, setFind] = useState<'goto' | 'switch' | null>(null)
  const [keys, setKeys] = useState(false)
  useEffect(() => {
    const onFind = (e: Event) => setFind((e as CustomEvent).detail)
    const onKeysList = () => setKeys(true)
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !keysOn()) return
      const t = e.target as HTMLElement
      // typing in a box, or inside an open dialog (a box left focused in a closed one doesn't count)
      if (t.closest('dialog[open]') || (t.closest('input, textarea, select, [contenteditable="true"], [role="slider"]') && !t.closest('dialog'))) return
      const r = routeRef.current
      if (e.key === '/') { e.preventDefault(); setFind('goto'); return }
      if (e.key === '?') { e.preventDefault(); setKeys(true); return }
      const i = '123456'.indexOf(e.key)
      if (i < 0 || !e.key || !r.slug || e.shiftKey) return
      e.preventDefault()
      if (ANSWERS[i] !== r.page) navigate(pathOf(r.slug, ANSWERS[i], '', r.version))
    }
    window.addEventListener('keydown', on)
    window.addEventListener('app:find', onFind)
    window.addEventListener('app:keys', onKeysList)
    return () => { window.removeEventListener('keydown', on); window.removeEventListener('app:find', onFind); window.removeEventListener('app:keys', onKeysList) }
  }, [])

  // a fresh upload, a ticker or the sample is saved straight away, then its Summary opens; when a ticker finishes
  // while you're elsewhere, a notice says it's ready instead. Replace (opts.keep) keeps today's version first.
  const [ready, setReady] = useState<{ name: string; href: string } | null>(null)
  const add = async (p: Parsed, reports: Report[] = [], opts: AddOpts = {}) => {
    // the company you just left may still have an edit on its way (or one the server refused): never drop it
    if ((await flushRef.current()) === false)
      throw new Error('Your last change to the open company isn’t saved yet. Open it and press Try again.')
    const q = opts.name ? { ...p, company: { ...p.company, name: opts.name } } : p
    const d = newDoc(q, reports)
    const r = await api<{ id: string; saved_at: string }>(`/api/models${opts.keep ? '?keep=1' : ''}`, postJson(d))
    channel?.postMessage({ type: 'saved', id: r.id, saved_at: r.saved_at } satisfies Msg)
    openDoc(q, { ...d, saved_at: r.saved_at }, r.id, null)
    loadList()
    const to = pathOf(slugOf(r.id), 'summary')
    if (routeRef.current.top === 'add' || routeRef.current.top === 'home') navigate(to)
    else setReady({ name: shortName(q.company.name), href: to })
  }
  const build = useBuild(add)
  // the watch list: Home shows it, Add a company adds to it
  const [watch, setWatch] = useState<WatchList | null>(null)
  const [watchMsg, setWatchMsg] = useState<ReactNode>(null)
  const loadWatch = () => api<WatchList>('/api/watch').then(setWatch).catch(() => setWatch({ watch: [], history: {} }))
  useEffect(() => { loadWatch() }, [])
  const watchIt = async (symbol: string) => {
    setWatchMsg(`Looking up ${symbol} on NSE…`)
    try {
      const w = await watchSymbol(symbol)
      setWatch(w.list)
      setWatchMsg(<>Added {w.name} to the <a href="/#watching">watchlist</a>.</>)
    } catch (e) { setWatchMsg(<span className="bad">Couldn’t watch {symbol}: {(e as Error).message}</span>) }
  }
  // Restore: the version is re-read from disk and saved as today's; today's own file is kept first (keep=1). The
  // banner's Restore means the open version, so edits made while reading it (never saved) are dropped, as it said
  const restore = async (id: string | undefined = openRef.current ?? undefined) => {
    if (!doc || !parsed) return
    try {
      let [p, d] = [parsed, doc]
      if (id) {
        if ((await flushRef.current()) === false) return
        const o = await api<Opened>(`/api/models/${id}`)
        ;[p, d] = [o.parsed, o.doc!]
      }
      const r = await api<{ id: string; saved_at: string }>('/api/models?keep=1', postJson(d))
      channel?.postMessage({ type: 'saved', id: r.id, saved_at: r.saved_at } satisfies Msg)
      openDoc(p, { ...d, saved_at: r.saved_at }, r.id, null)
      loadList()
      navigate(location.pathname + location.hash, true)
      setNotice('Restored. The previous version is kept under Versions.')
    } catch (e) { setSave(s => ({ ...s, error: (e as Error).message })) }
  }
  const checked = (saved: { id: string; saved_at: string }[]) => { // other tabs on those companies reload them
    for (const r of saved) channel?.postMessage({ type: 'saved', id: r.id, saved_at: r.saved_at } satisfies Msg)
    loadList()
  }
  const deleted = (ids: string[]) => {
    for (const id of ids) {
      channel?.postMessage({ type: 'deleted', id } satisfies Msg)
      if (lastId() === id) remember(null)
      if (openRef.current === id) { gen.current++; pending.current = null; openRef.current = null; setOpenId(null); setParsed(null); setDoc(null) }
    }
    setModels(ms => ms && ms.filter(x => !ids.includes(x.id)))
  }

  // Documents → This model → Delete: nothing of it is saved again, every version goes, then the list
  const removeOpen = async () => {
    const slug = route.slug!
    window.clearTimeout(timer.current)
    pending.current = null
    await inflight.current
    const ids = (await loadList() ?? models ?? []).filter(m => slugOf(m.id) === slug).map(m => m.id)
    for (const id of ids) await api(`/api/models/${id}`, { method: 'DELETE' })
    deleted(ids)
    navigate('/')
  }
  const open = !!route.slug && !!parsed && !!doc && !!openId && slugOf(openId) === route.slug
    && (route.version ?? null) === openedVer.current
  if (open) lastUrl.current = location.pathname + location.search
  useEffect(() => {
    if (route.slug) return
    document.title = route.top === 'add' ? `Add company · ${TITLE}` : route.top === 'none' ? `No page here · ${TITLE}` : `Coverage · ${TITLE}`
    if (route.anchor) { window.setTimeout(() => document.getElementById(route.anchor)?.scrollIntoView({ block: 'start' }), 60); return }
    window.scrollTo({ top: route.y ?? 0, behavior: 'instant' })
    if (openRef.current) flushRef.current() // the list shows the values you just set
  }, [route])
  useEffect(() => { // "Couldn't open this company": say so, like any page change
    if (!missing) return
    if (placed.once) document.getElementById('page-h')?.focus({ preventScroll: true })
    placed.once = true
  }, [missing])
  // updates from a page belong to the company and version it was opened for: an AI reply that lands after you
  // switched to another company is dropped, never saved into that one
  const ep = epoch.current
  const mine = <T,>(f: (x: T) => T) => (x: T) => (epoch.current === ep ? f(x) : x)

  const global = <>
    <Finder mode={find} onClose={() => setFind(null)} models={models}
      here={open && route.slug ? { slug: route.slug, short: doc!.company.source?.symbol ?? shortName(doc!.company.name), name: doc!.company.name, page: route.page, sub: route.sub } : null} />
    <KeysDialog open={keys} onClose={() => setKeys(false)} />
    {ready && <p className="toast" role="status">{ready.name} is ready · <a href={ready.href} onClick={() => setReady(null)}>Open</a>{' '}
      <button type="button" className="link" onClick={() => setReady(null)}>Dismiss</button></p>}
  </>

  if (open) return (<>
    <Workspace key={route.slug} route={route} models={models} parsed={parsed!} doc={doc!} save={save} notice={notice}
      setDoc={f => setDoc(d => d && mine(f)(d))} onRetry={flush} onRestore={restore} onNotice={() => setNotice(null)}
      setDefaults={defaults => setParsed(p => p && mine<Parsed>(x => ({ ...x, defaults }))(p))}
      setParsed={next => setParsed(p => p && mine<Parsed>(x => ({ ...next, restated: x.restated }))(p))} onDelete={removeOpen} />
    {global}
  </>)
  const top = route.top === 'add' ? 'add' : 'home'
  const n = models ? new Set(models.map(m => slugOf(m.id))).size : null
  const building = build.b.symbol && build.b.state !== 'done' && route.top !== 'add'
  return (
    <div className="app">
      <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to the page</a>
      <HomeRail here={top} count={n} foot={building ? <p><a href="/add">Adding {build.b.name ?? build.b.symbol}…</a></p> : undefined} />
      <div className="col">
        <PhoneTop menu={[]} />
        {route.slug
          ? <main id="main" className="page" tabIndex={-1}>
              {missing
                ? <div className="gone"><h1 id="page-h" tabIndex={-1} className="h1">Couldn’t open this company</h1>
                    <p className="purpose">{missing} Other companies are unaffected.</p><p><a className="primary" href="/">Back to coverage</a></p></div>
                : <div aria-busy="true"><p className="label">Opening</p><h1 id="page-h" tabIndex={-1} className="h1">Opening {route.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}…</h1>
                    <div className="skel-block" /></div>}
            </main>
          : route.top === 'none'
          ? <main id="main" className="page" tabIndex={-1}><div className="gone"><h1 id="page-h" tabIndex={-1} className="h1">There’s no page here</h1>
              <p><a className="primary" href="/">Coverage</a></p></div></main>
          : route.top === 'add'
          ? <main id="main" className="page" tabIndex={-1}>
              <AddPage models={models} build={build} onAdd={add} onWatch={watchIt} watchMsg={watchMsg} /></main>
          : <Home models={models} error={listError} build={build} onAdd={add} onWatch={watchIt} watch={watch} setWatch={setWatch}
              watchMsg={watchMsg} onDeleted={deleted} onChecked={checked} onReload={() => { loadList(); loadWatch() }} />}
      </div>
      <BottomBar here={top} />
      {global}
    </div>
  )
}
