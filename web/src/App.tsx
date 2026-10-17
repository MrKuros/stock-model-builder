import { useCallback, useEffect, useRef, useState } from 'react'
import Landing from './Landing'
import Workspace from './Workspace'
import { MobileTop, Side, keysOn, slugOf } from './Shell'
import { PAGES, navigate, onLinkClick, pathOf, placed, readRoute, type Page, type Route } from './route'
import { api, defaultPaths, postJson, seed, type ModelDoc, type ModelSummary, type Opened, type Parsed } from './lib'

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
  if (v === 'note') return pathOf(slug, 'overview')
  if (v === 'evidence') return pathOf(slug, 'checks', '', null, a === 'oneoffs' ? 'unusual' : a)
  if (a === 'valuation' || a === 'bridge') return pathOf(slug, 'valuation', '', null, a === 'bridge' ? 'bridge' : '')
  if (a === 'statements') return pathOf(slug, 'statements')
  return pathOf(slug, 'forecast', '', null, a)
}

// a re-import of a saved company keeps its filings, proposals, notes and reports (p.defaults already use them)
const newDoc = (p: Parsed): ModelDoc => ({
  version: 6, company: p.company, n: 5, active: 'base', scenarios: seed(defaultPaths(p.defaults, p.default_ends)),
  excluded_years: [], saved_at: null, valuation: p.valuation, filings: [], proposals: [], notes: {}, reports: [],
  note: null, assumption_sources: {}, flag_notes: [], reviewed_at: null,
  ...p.restated?.carry,
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
    const on = () => setRoute(readRoute())
    window.addEventListener('popstate', on)
    window.addEventListener('app:navigate', on)
    document.addEventListener('click', onLinkClick)
    const old = !routeRef.current.slug && lastId() ? oldLink(location.hash, lastId()!) : null
    if (old) navigate(old, true)
    return () => {
      window.removeEventListener('popstate', on)
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

  // ---- keys: 1-6 for the pages; N, M and E as before (Overview, Forecast, Checks); never while typing ----
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented || !keysOn()) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return
      const r = routeRef.current
      if (!r.slug) return
      const k = e.key.toUpperCase(), i = '123456'.indexOf(k)
      const page = (i >= 0 && k ? PAGES[i][0] : ({ N: 'overview', M: 'forecast', E: 'checks' } as Record<string, Page>)[k])
      if (!page) return
      e.preventDefault()
      if (page !== r.page) navigate(pathOf(r.slug, page, page === 'statements' ? r.sub : '', r.version))
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const add = async (p: Parsed) => { // a fresh upload (or the sample) is saved straight away, then its Overview opens
    // the company you just left may still have an edit on its way (or one the server refused): never drop it
    if ((await flushRef.current()) === false)
      throw new Error('Your last change to the open company isn’t saved yet. Open it and press Try again.')
    const d = newDoc(p)
    const r = await api<{ id: string; saved_at: string }>('/api/models', postJson(d))
    channel?.postMessage({ type: 'saved', id: r.id, saved_at: r.saved_at } satisfies Msg)
    openDoc(p, { ...d, saved_at: r.saved_at }, r.id, null)
    loadList()
    navigate(pathOf(slugOf(r.id), 'overview'))
  }
  const deleted = (id: string) => {
    channel?.postMessage({ type: 'deleted', id } satisfies Msg)
    if (lastId() === id) remember(null)
    if (openRef.current === id) { gen.current++; pending.current = null; openRef.current = null; setOpenId(null); setParsed(null); setDoc(null) }
    setModels(ms => ms && ms.filter(x => x.id !== id))
  }

  const ready = !!route.slug && !!parsed && !!doc && !!openId && slugOf(openId) === route.slug
    && (route.version ?? null) === openedVer.current
  if (ready) lastUrl.current = location.pathname + location.search
  useEffect(() => {
    if (route.slug) return
    document.title = TITLE
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

  if (ready) return (
    <Workspace key={route.slug} route={route} models={models} parsed={parsed!} doc={doc!} save={save} notice={notice}
      setDoc={f => setDoc(d => d && mine(f)(d))} onRetry={flush}
      setDefaults={defaults => setParsed(p => p && mine<Parsed>(x => ({ ...x, defaults }))(p))}
      setParsed={next => setParsed(p => p && mine<Parsed>(x => ({ ...next, restated: x.restated }))(p))} />
  )
  return (
    <div className="app">
      <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to the page</a>
      <Side here={null} />
      <div className="col">
        <MobileTop here={null} />
        {route.slug
          ? <main id="main" className="page" tabIndex={-1}>
              {missing
                ? <div className="gone"><h1 id="page-h" tabIndex={-1}>Couldn’t open this company</h1>
                    <p className="purpose">{missing}</p><p><a className="btn" href="/">See all your companies</a></p></div>
                : <p className="muted pad" role="status">Opening {route.slug.replace(/-/g, ' ')}…</p>}
            </main>
          : <Landing models={models} error={listError} onAdd={add} onDeleted={deleted} />}
      </div>
    </div>
  )
}
