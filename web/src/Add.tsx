import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { PageHead, latestOf, slugOf } from './Shell'
import { navigate, pathOf } from './route'
import { api, clock, postJson, when, type ModelSummary, type Parsed, type Report, type WatchList } from './lib'
import { pendingMerge, sameCompany, streamFetch } from './Fetch'

export interface AddOpts { keep?: boolean; name?: string }
/** Saves a new company: keep = Replace (today's version is kept first), name = the saved company it replaces. */
export type OnAdd = (p: Parsed, reports?: Report[], opts?: AddOpts) => Promise<void>

interface Step { text: string; detail?: string }
type Mode = 'new' | 'separate' | 'replace'
export interface Build {
  symbol: string | null; mode: Mode; steps: Step[]; notes: string[]; error: string | null; started: number
  state: 'running' | 'stopped' | 'failed' | 'adding' | 'choose' | 'done'; fail: { final?: boolean; lender?: boolean }; name: string | null
}
const IDLE: Build = { symbol: null, mode: 'new', steps: [], notes: [], error: null, started: 0, state: 'done', fail: {}, name: null }

/** Adding a company by ticker, held by App so it keeps running while you look at other pages. */
export function useBuild(onAdd: OnAdd) {
  const [b, setB] = useState<Build>(IDLE)
  const ctl = useRef<AbortController | null>(null)
  const got = useRef<{ p: Parsed | null; reports: Report[]; replace?: string }>({ p: null, reports: [] })
  const set = (f: (b: Build) => Build) => setB(x => f(x))
  const finish = async (mode: Mode) => {
    const { p, reports, replace } = got.current
    if (!p) return
    // NSE's years were filled from a saved Excel upload of this company: ask (the guard on Add a company usually asks first)
    if (mode === 'new' && p.company.source?.from === 'your earlier Excel upload') { set(x => ({ ...x, state: 'choose' })); return }
    set(x => ({ ...x, state: 'adding' }))
    try {
      await onAdd(p, reports, replace ? { keep: true, name: replace } : {})
      set(x => ({ ...x, state: 'done' }))
    } catch (e) { set(x => ({ ...x, error: (e as Error).message, state: 'failed' })) }
  }
  const start = (symbol: string, mode: Mode = 'new', replace?: string) => {
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    got.current = { p: null, reports: [], replace }
    setB({ ...IDLE, symbol, mode, started: Date.now(), state: 'running' })
    streamFetch({ symbol, separate: mode !== 'new' }, c.signal, e => {
      if (e.step) set(x => ({ ...x, steps: [...x.steps, { text: e.step! }] }))
      if (e.detail) set(x => ({ ...x, steps: x.steps.map((s, i) => (i === x.steps.length - 1 ? { ...s, detail: e.detail } : s)) }))
      if (e.note) set(x => ({ ...x, notes: [...x.notes, e.note!] }))
      if (e.company) { got.current.p = e.company; set(x => ({ ...x, name: e.company!.company.name })) }
      if (e.documents && got.current.p) {
        const pc = got.current.p.company
        got.current.p = { ...got.current.p, company: { ...pc, source: pc.source && { ...pc.source, documents: e.documents } } }
      }
      if (e.report) got.current.reports.push(e.report)
      if (e.error) set(x => ({ ...x, error: e.error!, fail: { final: e.final, lender: e.lender }, state: 'failed' }))
      if (e.done) finish(mode)
    }).catch(e => {
      if ((e as Error).name === 'AbortError') return
      set(x => ({ ...x, error: (e as Error).message, state: 'failed' }))
    })
  }
  return {
    b, start,
    stop: () => { ctl.current?.abort(); set(x => ({ ...x, state: 'stopped' })) },
    retry: () => b.symbol && start(b.symbol, b.mode, got.current.replace),
    take: () => finish('separate'), // a stopped run as it is, or the merged one after "choose"
    hasNumbers: () => !!got.current.p,
    clear: () => { ctl.current?.abort(); setB(IDLE) },
  }
}
export type BuildApi = ReturnType<typeof useBuild>

/** Seconds since `from`, ticking while `on`. */
function useSeconds(from: number, on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!on) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [on])
  const s = Math.max(0, Math.round((now - from) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const SYMBOL = /^[A-Z0-9&-]{1,20}$/
type Option = { key: string; kind: 'open'; name: string; href: string } | { key: string; kind: 'add'; name: string; symbol: string; exchange?: 'BSE' }

/** One box for a name or an NSE symbol. Your saved companies come first (they open); an NSE match, when highlighted,
 * shows Build model and Watch price on its own row. ↑ ↓ pick, Enter builds, W watches (after picking with the arrows). */
export function SearchBox({ models, onBuild, onWatch, busy }: {
  models: ModelSummary[] | null; onBuild: (symbol: string, name: string) => void; onWatch: (symbol: string) => void; busy?: boolean
}) {
  const id = useId()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ symbol: string; name: string; exchange?: 'BSE' }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [asked, setAsked] = useState<string | null>(null) // the text NSE has answered for
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [arrowed, setArrowed] = useState(false) // W watches only after picking with the arrows (otherwise it's typing)
  const text = q.trim()
  useEffect(() => { // ask NSE once typing pauses
    setHits([])
    setError(null)
    if (text.length < 2) return
    const ctl = new AbortController()
    const t = window.setTimeout(() => {
      setSearching(true)
      api<{ results: { symbol: string; name: string; exchange?: 'BSE' }[]; error: string | null }>('/api/nse/search', postJson({ q: text }, ctl.signal))
        .then(r => { setHits(r.results); setError(r.error); setAsked(text) })
        .catch(e => { if (e.name !== 'AbortError') setError((e as Error).message) })
        .finally(() => setSearching(false))
    }, 300)
    return () => { window.clearTimeout(t); ctl.abort() }
  }, [text])

  const low = text.toLowerCase()
  const saved = text.length < 1 ? [] : latestOf(models).filter(m => m.company.toLowerCase().includes(low) || m.symbol?.toLowerCase() === low).slice(0, 4)
  const typed = text.toUpperCase()
  const none = asked === text && !error && !hits.length // NSE answered: nothing by that name or symbol
  const options: Option[] = [
    ...saved.map(m => ({ key: `o-${m.id}`, kind: 'open' as const, name: m.company, href: pathOf(slugOf(m.id), 'summary') })),
    ...hits.map(h => ({ key: `a-${h.symbol}`, kind: 'add' as const, name: h.name, symbol: h.symbol, exchange: h.exchange })),
    ...(SYMBOL.test(typed) && !hits.some(h => h.symbol === typed) ? [{ key: `s-${typed}`, kind: 'add' as const, name: none ? `${typed}: not found on NSE, try the symbol anyway` : `${typed} (by symbol)`, symbol: typed }] : []),
  ]
  const shown = open && text.length > 0 && options.length > 0
  const cur = options[shown ? Math.min(active, options.length - 1) : 0]
  const act = (o: Option | undefined, watch = false) => {
    if (!o || busy) return
    setOpen(false)
    if (o.kind === 'open') { navigate(o.href); return }
    setQ('')
    if (watch) onWatch(o.symbol)
    else onBuild(o.symbol, o.name)
  }
  const optId = (i: number) => `${id}-o${i}`
  return (
    <div className="addbox">
      <label htmlFor={`${id}-in`} className="add-l">Company name, NSE symbol or BSE scrip code</label>
      <div className="add-row">
        <svg className="add-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.8" /></svg>
        <input id={`${id}-in`} type="text" role="combobox" autoComplete="off" spellCheck={false} value={q} disabled={busy}
          placeholder="e.g. Wipro or TCS" aria-expanded={shown} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={shown ? optId(active) : undefined} aria-describedby={`${id}-hint`}
          onChange={e => { setQ(e.target.value); setOpen(true); setActive(0); setArrowed(false) }}
          onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault(); setOpen(true); setArrowed(true)
              setActive(a => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(options.length, 1))
            } else if (e.key === 'Enter') { e.preventDefault(); act(cur) }
            else if ((e.key === 'w' || e.key === 'W') && arrowed && shown && cur?.kind === 'add') { e.preventDefault(); act(cur, true) }
            else if (e.key === 'Escape' && shown) { e.preventDefault(); setOpen(false) }
          }} />
        {shown && <ul className="add-list" role="listbox" id={`${id}-list`} aria-label="Matches">
          {options.map((o, i) => (
            <li key={o.key} id={optId(i)} role="option" aria-selected={i === active} className={i === active ? 'on' : undefined}
              onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => act(o)}>
              <span className="al-main"><b>{o.name}</b><span className="al-sub">{o.kind === 'open' ? 'Yours already · open it' : o.exchange === 'BSE' ? `BSE scrip code ${o.symbol}` : `NSE: ${o.symbol}`}</span></span>
              {i === active && o.kind === 'add'
                ? <span className="al-act">
                    <button type="button" className="primary" tabIndex={-1} onClick={e => { e.stopPropagation(); act(o) }}>Build model</button>
                    <button type="button" className="btn" tabIndex={-1} onClick={e => { e.stopPropagation(); act(o, true) }}>Watch price</button>
                  </span>
                : <span className="tag">{o.kind === 'open' ? 'Open' : o.symbol}</span>}
            </li>
          ))}
        </ul>}
      </div>
      <p className="small muted" id={`${id}-hint`} aria-live="polite">
        {error ? <span className="bad">{error} </span> : searching ? 'Looking on NSE… ' : text.length >= 2 && none && !saved.length ? `NSE has no listed share called “${text}”. Check the spelling or try the symbol. ` : null}
        Use <kbd>↑</kbd> <kbd>↓</kbd> to pick, <kbd>Enter</kbd> to build, <kbd>W</kbd> to watch. Banks and NBFCs build on the lender template; insurers aren’t supported, and the app says so as soon as you pick one.
      </p>
      <dl className="add-what">
        <div><dt>Build model</dt><dd>Filings, CMP, documents, three-statement model, DCF and forensic checks. About a minute.</dd></div>
        <div><dt>Watch price</dt><dd>CMP only, on the watchlist. Build the model later in one click.</dd></div>
      </dl>
    </div>
  )
}

/** The progress of adding a company: named steps, a timer, Stop, and what to do when something fails. */
export function BuildCard({ build, onWatch, onUpload, onClose }: { build: BuildApi; onWatch: (s: string) => void; onUpload: () => void; onClose: () => void }) {
  const { b } = build
  const time = useSeconds(b.started, b.state === 'running' || b.state === 'adding')
  const head = useRef<HTMLHeadingElement>(null)
  useEffect(() => { head.current?.focus() }, [b.state === 'failed' || b.state === 'choose' || b.state === 'stopped']) // eslint-disable-line react-hooks/exhaustive-deps
  if (!b.symbol) return null
  const who = b.name ?? b.symbol
  const last = b.steps.length - 1
  const upload = <button type="button" className="link" onClick={onUpload}>Upload an Excel export instead</button>
  return (
    <section className="pane build" aria-labelledby="build-h" aria-busy={b.state === 'running' || b.state === 'adding'}>
      <div className="build-top">
        <h2 id="build-h" ref={head} tabIndex={-1}>{b.state === 'failed' ? `Couldn’t add ${who}` : b.state === 'stopped' ? `Stopped adding ${who}`
          : b.state === 'choose' ? `You already have ${who} from an Excel export` : b.state === 'done' ? `${who} is ready` : `Building ${who}`}</h2>
        {(b.state === 'running' || b.state === 'adding') && <span className="num muted" aria-label={`${time} so far`}>{time}</span>}
      </div>
      <ol className="steps" role="status">
        {b.steps.map((s, i) => {
          const now = i === last && b.state === 'running'
          return <li key={i} className={now ? 'now' : 'done'}><span className="tick" aria-hidden="true">{now ? '●' : '✓'}</span>
            <span>{s.text}{s.detail && now && <span className="muted"> {s.detail}</span>}</span>
            <span className="sr">{now ? ' (in progress)' : ' (done)'}</span></li>
        })}
        {b.state === 'running' && <li className="todo"><span className="tick" aria-hidden="true">○</span><span>Build the model and run the checks</span></li>}
        {b.state === 'adding' && <li className="now"><span className="tick" aria-hidden="true">●</span><span>Saving {who} and opening its Summary…</span></li>}
      </ol>
      {b.notes.length > 0 && <ul className="fetch-notes">{b.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {b.error && <p className="error" role="alert">{b.fail.lender ? b.error : b.fail.final ? b.error
        : `${b.error.replace(/\.?$/, '.')} Nothing was added.`}</p>}
      {b.state === 'choose' && <p className="small">NSE’s filings are ready. Adding them to the model you have keeps one model: the export fills the years NSE
        lacks and NSE’s filings win where both have a year. Keeping both saves a second company, “{who} (NSE)”.</p>}
      <div className="fetch-act">
        {b.state === 'running' && <><button type="button" className="btn" onClick={build.stop}>Stop</button>{upload}</>}
        {b.state === 'choose' && <>
          <button type="button" className="primary" onClick={build.take}>Add these years to it</button>
          <button type="button" className="btn" onClick={() => build.start(b.symbol!, 'separate')}>Keep both, separately</button>
          <button type="button" className="link" onClick={onClose}>Cancel</button></>}
        {b.state === 'stopped' && build.hasNumbers() && <button type="button" className="primary" onClick={build.take}>Add {who} without the rest</button>}
        {b.state === 'failed' && b.fail.lender
          ? <><button type="button" className="primary" onClick={() => { onWatch(b.symbol!); onClose() }}>Watch price instead</button>
            <button type="button" className="link" onClick={onClose}>Close</button></>
          : (b.state === 'stopped' || b.state === 'failed') && <>
            <button type="button" className={b.fail.final || (b.state === 'stopped' && build.hasNumbers()) ? 'btn' : 'primary'} onClick={build.retry}>Try again</button>
            {upload}<button type="button" className="link" onClick={onClose}>Cancel</button></>}
      </div>
      {b.state === 'stopped' && build.hasNumbers() && <p className="small muted">Its numbers are in; documents not downloaded yet can be attached later on Documents.</p>}
      {b.state === 'running' && <p className="small muted">When it’s done you land on {who}’s Summary. You can keep working meanwhile. If NSE stops answering, what was fetched is kept and you can try again.</p>}
    </section>
  )
}

interface Dup { m: ModelSummary; what: 'upload' | 'ticker'; p?: Parsed; symbol?: string; name: string }

/** "You already have X": on every add path, before anything is saved. */
function Duplicate({ d, onCancel, onPick }: { d: Dup; onCancel: () => void; onPick: (mode: 'merge' | 'separate' | 'replace') => void }) {
  const [mode, setMode] = useState<'merge' | 'separate' | 'replace'>('merge')
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  const yrs = d.p?.years
  const opt = (k: typeof mode, title: string, line: string) => (
    <label className={`radio${mode === k ? ' on' : ''}`}><input type="radio" name="dup" checked={mode === k} onChange={() => setMode(k)} />
      <span><b>{title}</b><span>{line}</span></span></label>
  )
  return (
    <dialog ref={ref} className="dlg dup" aria-labelledby="dup-h" onCancel={onCancel} onClose={onCancel}>
      <p className="label">Before saving</p>
      <h2 id="dup-h">You already have {d.m.company}</h2>
      <p className="dlg-body">Saved {d.m.saved_at ? `${when(d.m.saved_at)} at ${clock(d.m.saved_at).slice(-5)}` : 'earlier'}
        {d.m.symbol ? `, built from NSE (${d.m.symbol})` : ', from an Excel export'}{d.m.reviewed_at ? ' and reviewed by you' : ''}.{' '}
        {d.what === 'upload' ? `This upload has ${yrs?.length ? `${yrs[0]}–${yrs[yrs.length - 1]}` : 'its years'}.` : `This adds ${d.name} from NSE’s filings.`} What should happen?</p>
      <fieldset className="radios"><legend className="sr">What should happen</legend>
        {opt('merge', 'Add these years to it', 'Keeps assumptions, notes and review status. Recommended.')}
        {opt('separate', 'Keep both, separately', 'Saves this as a second company.')}
        {opt('replace', 'Replace it', 'Starts again from this. The current version is kept under Versions.')}
      </fieldset>
      <div className="dlg-act">
        <button type="button" className="primary" onClick={() => onPick(mode)}>Continue</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </dialog>
  )
}

/** /add: by name or symbol (Build model / Watch price), or an Excel export, or the sample. With `first`, the same
 * pieces are the first-run screen on Coverage. */
export default function AddPage({ models, build, onAdd, onWatch, watchMsg, first }: {
  models: ModelSummary[] | null; build: BuildApi; onAdd: OnAdd; onWatch: (s: string) => void; watchMsg: ReactNode; first?: boolean
}) {
  const [dup, setDup] = useState<Dup | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ReactNode>(null)
  const [over, setOver] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const latest = latestOf(models)
  const running = build.b.state === 'running' || build.b.state === 'adding'

  const ticker = (symbol: string, name: string) => {
    setError(null)
    const m = latest.find(x => x.symbol === symbol) ?? latest.find(x => sameCompany(x.company, name))
    if (m) setDup({ m, what: 'ticker', symbol, name })
    else build.start(symbol)
  }
  useEffect(() => { // /add?symbol=WIPRO: Build model from Watching
    const s = new URLSearchParams(location.search).get('symbol')?.toUpperCase()
    if (!s) return
    history.replaceState(history.state, '', '/add')
    if (SYMBOL.test(s) && models) ticker(s, s)
  }, [models == null]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, f: () => Promise<void>) => {
    if (busy) return
    setBusy(label); setError(null)
    try { await f() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const upload = (f: File | undefined) => {
    if (!f) return
    run(`Reading ${f.name}…`, async () => {
      const body = new FormData()
      body.append('file', f)
      let p: Parsed
      try { p = await api<Parsed>('/api/parse', { method: 'POST', body }) } catch (e) {
        const msg = (e as Error).message
        setError(<>{/data sheet/i.test(msg) ? `This isn’t a 10-year financials Excel export: “${f.name}” has no “Data Sheet” tab.` : msg}{' '}
          <button type="button" className="link" onClick={() => file.current?.click()}>Choose another file</button></>)
        return
      }
      const m = latest.find(x => sameCompany(x.company, p.company.name))
      if (m) setDup({ m, what: 'upload', p, name: p.company.name })
      else await onAdd(p)
    })
  }
  const pick = (mode: 'merge' | 'separate' | 'replace') => {
    const d = dup!
    setDup(null)
    if (mode === 'merge') {
      pendingMerge.push({ company: d.m.company, parsed: d.p, symbol: d.symbol })
      navigate(pathOf(slugOf(d.m.id), 'summary'))
    } else if (d.what === 'ticker') build.start(d.symbol!, mode, mode === 'replace' ? d.m.company : undefined)
    else if (mode === 'separate') run('Saving it as a second company…', () => onAdd({ ...d.p!, company: { ...d.p!.company, name: `${d.p!.company.name} (Excel export)` } }))
    else run('Replacing it…', () => onAdd({ ...d.p!, restated: null }, [], { keep: true, name: d.m.company }))
  }
  const toUpload = () => { document.getElementById('upload')?.scrollIntoView({ block: 'center' }); file.current?.focus() }
  const sample = <button type="button" className="link" disabled={!!busy} onClick={() => run('Opening the sample…', async () => onAdd(await api<Parsed>('/api/sample')))}>Try the sample company</button>

  return (
    <>
      {!first && <PageHead title="Add company" purpose="Enter a name or NSE symbol. The app reads exchange filings (XBRL), CMP, annual reports and
        concall transcripts, then builds a first forecast, DCF and forensic checks for review. About a minute; you can keep working meanwhile." />}
      <div className="add-grid">
        <section className="pane" aria-labelledby="find-h">
          <h2 id="find-h">Find it on NSE</h2>
          <SearchBox models={models} onBuild={ticker} onWatch={onWatch} busy={running} />
          {watchMsg && <p className="small" role="status">{watchMsg}</p>}
        </section>
        {build.b.symbol && build.b.state !== 'done' && <BuildCard build={build} onWatch={onWatch} onUpload={toUpload} onClose={build.clear} />}
        <section className="pane" id="upload" aria-labelledby="up-h" tabIndex={-1}>
          <h2 id="up-h">Or upload an Excel export</h2>
          <p className="small">A 10-year financials Excel export with a <b>Data Sheet</b> tab. Useful for companies NSE filings don’t cover, or for years before FY2019.</p>
          <label className={`drop${over ? ' is-over' : ''}`} aria-busy={!!busy}
            onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]) }}>
            <input ref={file} type="file" accept=".xlsx" className="sr" disabled={!!busy} aria-describedby="up-h"
              onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} />
            <strong>{busy ?? 'Drop the .xlsx here'}</strong>
            {!busy && <span>or <u className="btn">Choose a file</u></span>}
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="small">New here? {sample}: a made-up firm with ten clean years.</p>
        </section>
      </div>
      {dup && <Duplicate d={dup} onCancel={() => setDup(null)} onPick={pick} />}
    </>
  )
}

/** Follow a symbol's price without a model: POST /api/watch. */
export async function watchSymbol(symbol: string): Promise<{ list: WatchList; name: string }> {
  const list = await api<WatchList>('/api/watch', postJson({ symbol }))
  return { list, name: list.watch.find(x => x.symbol === symbol)?.name ?? symbol }
}
