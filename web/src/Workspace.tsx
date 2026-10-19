import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAi, withFlagNotes, withNotes } from './Sources'
import NotePage, { shortName, subjectOf } from './Note'
import ModelView, { UPGRADED, inputName, type Upgrade } from './Model'
import Summary from './Summary'
import RisksPage from './Risks'
import Documents from './Documents'
import Fundamentals from './Fundamentals'
import StatementsPage from './Statements'
import ValuationPage, { PricedIn } from './Valuation'
import { PeersSection, peerWords } from './Peers'
import { BottomBar, CHECK, Confirm, DL, Next, PageHead, PhoneTop, Rail, Scale, Sheet, Verdict, openFinder, slugOf, type Here, type RailNote } from './Shell'
import { ago, pendingMerge, streamFetch } from './Fetch'
import { Accuracy, Changed, latestScored, unreviewed } from './Tracking'
import { path } from './Draft'
import { month } from './Statements'
import { HrefCtx, PAGES, REPORTED, STATEMENTS, pathOf, placed, type Href, type Page, type Route } from './route'
import type { SaveState } from './App'
import {
  NAMES, api, clock, defaultPaths, flat, fmt, gap, groupKeys, isAnnual, postJson, rs, seed, sevCounts, verdict, when, SCENARIOS,
  type Company, type Kind, type Filing, type ModelDoc, type ModelSummary, type Parsed, type Projection, type Proposal, type Scenario,
} from './lib'

const ORDER: Scenario[] = ['bear', 'base', 'bull']
interface Effect { from: number | null; active: Scenario; at: number; undo: Pick<ModelDoc, 'scenarios' | 'assumption_sources' | 'valuation'> }
const HORIZONS = [3, 5, 7, 10]

interface Props {
  route: Route
  models: ModelSummary[] | null
  parsed: Parsed
  doc: ModelDoc
  setDoc: (f: (d: ModelDoc) => ModelDoc) => void
  setDefaults: (d: Record<string, number>) => void
  setParsed: (p: Parsed) => void // the dashboard payload again, after the filings changed
  save: SaveState
  notice: string | null
  onRetry: () => Promise<string | false>
  onRestore: (id?: string) => void // the open older version (or the one named) becomes today's (today's is kept)
  onNotice: () => void // dismiss the other-tab notice
  onDelete: () => Promise<void> // delete every version of this company (after a confirm), then go to the list
}

type Check = { state: 'idle' | 'running' | 'done'; msg: ReactNode }

/** One company: the rail, the company bar, the phone bars and its pages. Stays mounted while you move between pages,
 * so the projection and every input are kept; /api/project runs again only when an input changes. */
export default function Workspace({ route, models, parsed, doc, setDoc: setDocRaw, setDefaults, setParsed, save, notice, onRetry, onRestore, onNotice, onDelete }: Props) {
  const { company, years: histYears, drivers } = parsed
  const { n, scenarios, valuation, filings, notes, flag_notes, assumption_sources, excluded_years } = doc
  const peers = doc.peers ?? null
  const track = doc.track ?? []
  const slug = route.slug!
  const ai = useAi()
  // any change to what the numbers come from puts the note back to draft; an input changed without a new source
  // (a strip, a typed value) is yours: its source flips to "manual"
  // the effect bar: the value before an edit (a burst of edits to one case counts as one) and one level of Undo
  const effRef = useRef<Effect | null>(null)
  const mineRef = useRef<number | null>(null)
  const [effect, setEffect] = useState<Effect | null>(null)
  const setDoc = (f: (d: ModelDoc) => ModelDoc) => setDocRaw(d => {
    let x = f(d)
    if (x.scenarios !== d.scenarios && x.assumption_sources === d.assumption_sources) {
      const src = { ...d.assumption_sources }
      for (const s of SCENARIOS) for (const k of Object.keys(x.scenarios[s]))
        if (JSON.stringify(x.scenarios[s][k]) !== JSON.stringify(d.scenarios[s][k])) src[s] = { ...src[s], [k]: 'manual' }
      x = { ...x, assumption_sources: src }
    }
    if (x.scenarios !== d.scenarios || x.valuation !== d.valuation) {
      const e = effRef.current
      const keep = e && Date.now() - e.at < 1500 && e.active === d.active
      effRef.current = { from: keep ? e.from : mineRef.current, active: d.active, at: Date.now(),
        undo: keep ? e.undo : { scenarios: d.scenarios, assumption_sources: d.assumption_sources, valuation: d.valuation } }
      const now = effRef.current
      queueMicrotask(() => setEffect(now))
    }
    const moved = x.scenarios !== d.scenarios || x.valuation !== d.valuation || x.n !== d.n || x.filings !== d.filings
      || x.excluded_years !== d.excluded_years
    return moved && x.reviewed_at ? { ...x, reviewed_at: null } : x
  })
  const undo = () => {
    const e = effRef.current
    if (!e) return
    effRef.current = null
    setEffect(null)
    setDocRaw(d => ({ ...d, ...e.undo }))
  }
  const [projection, setProjection] = useState<Projection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [sheet, setSheet] = useState(false)
  const nHist = histYears.length

  useEffect(() => {
    const ctl = new AbortController()
    // the words' sources go too: they don't move a number, only the note's inputs hash (stale words)
    api<Projection>('/api/project', postJson({ company, scenarios, n, valuation, filings, notes, flag_notes, assumption_sources, excluded_years, peers, track }, ctl.signal))
      .then(p => { setProjection(p); setError(null) })
      .catch(e => { if (e.name !== 'AbortError') { setProjection(null); setError(e.message) } })
    return () => ctl.abort()
  }, [company, scenarios, n, valuation, filings, notes, flag_notes, assumption_sources, excluded_years, peers, track])

  // A filing attached or removed changes the history (payables, leases, cash-flow capex) and so the defaults; like
  // excluding a year, it never changes the assumptions by itself. The upgraded defaults are offered in one click.
  const filingIds = JSON.stringify([filings.map(f => [f.id, f.facts]), Object.entries(notes).filter(([k]) => k.startsWith('ar:') || k.startsWith('adj:'))])
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
        // a move too small to show (15.3% to 15.3%) isn't offered: the button would change nothing you can see
        const kind = (k: string) => (byKey[k]?.[2] ?? 'pct') as Upgrade['kind']
        setUpgrades(keys.filter(k => p.defaults[k] != null && fmt(scenarios.base[k]?.start ?? 0, kind(k)) !== fmt(p.defaults[k], kind(k)))
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
  const toggleYear = async (year: string) => {
    if (pendingYear) return
    const ex = doc.excluded_years
    const next = ex.includes(year) ? ex.filter(y => y !== year) : [...ex, year]
    setPendingYear(year)
    try {
      const d = await api<Record<string, number>>('/api/defaults', postJson({ company, excluded_years: next, filings, notes }))
      setDefaults(d)
      setDoc(doc => ({ ...doc, excluded_years: next }))
      // the rules' figures that moved are offered in one click (Use the new figures · Keep mine); nothing changes by itself
      const kind = (k: string) => (byKey[k]?.[2] ?? 'pct') as Upgrade['kind']
      setUpgrades(drivers.map(x => x[0]).filter(k => d[k] != null && fmt(d[k], kind(k)) !== fmt(scenarios.base[k]?.start ?? 0, kind(k))
        && fmt(d[k], kind(k)) !== fmt(parsed.defaults[k] ?? 0, kind(k)))
        .map(k => ({ key: k, label: byKey[k]?.[1] ?? k, kind: kind(k), from: scenarios.base[k]?.start ?? 0, to: d[k] })))
    } catch (e) { setError((e as Error).message) } finally { setPendingYear(null) }
  }

  // Check for new results (today's price, new results) or an Excel export's years: a new company; the assumptions stay
  // as they are (new filings move the defaults, which the Forecast and Risks pages then offer in one click)
  const onCompany = (p: Parsed | null, c: Company) => {
    if (p) setParsed({ ...p, company: c })
    else setParsed({ ...parsed, company: c })
    const add = p?.fetched?.filings ?? []
    setDoc(d => ({ ...d, company: c, filings: add.length ? [...d.filings, ...add.filter((f: Filing) => !d.filings.some(x => x.id === f.id))] : d.filings }))
  }
  // new results came in: the server recorded the forecast they replace (/api/track/apply); assumptions as they were
  const onResults = (p: Parsed, nd: ModelDoc) => {
    setParsed(p)
    setDoc(d => ({ ...d, company: nd.company, filings: nd.filings, track: nd.track, reviewed_at: nd.reviewed_at }))
  }

  // ---- Check for new results: today's price, then any results filed since; never changes an assumption ----
  const sym = company.source?.symbol ?? null
  const [chk, setChk] = useState<Check>({ state: 'idle', msg: null })
  const chkCtl = useRef<AbortController | null>(null)
  useEffect(() => () => chkCtl.current?.abort(), [])
  const href: Href = (page, anchor = '', sub = '') => pathOf(slug, page, sub, route.version, anchor)
  const check = async () => {
    if (!sym) {
      setChk({ state: 'done', msg: <>{shortName(company.name)} came from an Excel export, so there’s no NSE symbol to check. Newer years can be added from a newer export on <a href={href('documents')}>Documents and sources</a>.</> })
      return
    }
    const s = company.source!
    const ctl = new AbortController()
    chkCtl.current = ctl
    setChk({ state: 'running', msg: null })
    try {
      const r = await api<{ price: number | null; shares: number | null; face_value: number | null; at: string; stale: boolean }>('/api/nse/price', postJson({ symbol: sym }, ctl.signal))
      if (r.stale) { // NSE didn't answer: the cache did. Never say "nothing new" for that
        setChk({ state: 'done', msg: <span className="bad">Couldn’t reach NSE: the price is from {clock(r.at)} and new results weren’t checked. Your model is unchanged. <button type="button" className="link" onClick={check}>Try again</button></span> })
        return
      }
      const m = company.market ?? { price: null, shares: null, price_hist: [], shares_hist: [] }
      const c: Company = { ...company, market: { ...m, price: r.price ?? m.price, shares: r.shares ?? m.shares, face_value: r.face_value ?? m.face_value },
        source: { ...s, price_at: r.at } }
      let got: Parsed | null = null
      await streamFetch({ symbol: sym, company: c, documents: false, fresh: true }, ctl.signal, e => {
        if (e.company) got = e.company
        if (e.error) throw new Error(e.error)
      })
      const p = got as Parsed | null
      const a = p && await api<{ doc: ModelDoc | null; years: string[]; quarter: string | null }>('/api/track/apply',
        postJson({ doc: { ...doc, company: c }, company: p.company, filings: p.fetched?.filings ?? [] }, ctl.signal))
      const at = clock(new Date().toISOString())
      if (p && a?.doc) {
        onResults({ ...p, company: a.doc.company }, a.doc)
        setChk({ state: 'done', msg: <>New results: {a.years.length ? a.years.join(', ') : `${month(a.quarter!)} quarter`}. Your inputs haven’t changed. <a href={href('changes')}>See what changed</a></> })
      } else {
        onCompany(null, c)
        setChk({ state: 'done', msg: `Checked ${at}: nothing new${Date.now() - new Date(r.at).getTime() > 60_000 ? ` (the price is from ${clock(r.at)}; NSE is asked at most every 15 minutes)` : ''}.` })
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') { setChk({ state: 'done', msg: 'Stopped. Nothing changed.' }); return }
      setChk({ state: 'done', msg: <span className="bad">Couldn’t check: {(e as Error).message} Your model is unchanged. <button type="button" className="link" onClick={check}>Try again</button></span> })
    }
  }
  const stopCheck = () => chkCtl.current?.abort()

  // ---- "Add these years to it" from Add a company: merged here, so your inputs, notes and review stay ----
  const [merging, setMerging] = useState<string | null>(null)
  useEffect(() => {
    const i = pendingMerge.findIndex(x => x.company === company.name)
    if (i < 0) return
    const m = pendingMerge.splice(i, 1)[0]
    const symbol = m.symbol ?? sym
    if (!symbol) { if (m.parsed) onCompany(m.parsed, { ...m.parsed.company, name: company.name }); return } // two exports: the newer one's years
    setMerging(`Adding ${m.parsed ? 'the export’s' : 'NSE’s'} years to ${shortName(company.name)}…`)
    let got: Parsed | null = null
    streamFetch({ symbol, company: m.parsed?.company ?? company, documents: false }, new AbortController().signal, e => {
      if (e.company) got = e.company
      if (e.error) throw new Error(e.error)
    }).then(() => {
      const g = got as Parsed | null
      if (!g) throw new Error('The server stopped before the years were ready. Try again from Add a company.')
      const c = { ...g.company, name: company.name, source: g.company.source && { ...g.company.source, from: m.parsed ? 'your Excel export' : g.company.source.from } }
      onCompany({ ...g, company: c }, c)
      setMerging(null)
    }).catch(e => setMerging(`Couldn’t add the years: ${(e as Error).message}`))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/export', postJson({ company, scenarios, active: doc.active, n, valuation, filings, notes, peers }))
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? 'Export failed. Try again.')
      const url = URL.createObjectURL(await res.blob())
      const link = Object.assign(document.createElement('a'), { href: url, download: `${company.name} model.xlsx` })
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) { setError((e as Error).message) } finally { setExporting(false) }
  }

  const proj = projection?.scenarios.base.length === n ? projection : null // null while a new horizon loads
  const v = proj?.valuation ?? null
  const m = company.market
  const price = v?.price ?? valuation.price ?? m?.price ?? null
  const pos = (x: number | null | undefined) => (x != null && x > 0 ? x : null) // zero or below is no value: the bar says so
  const values = { bear: pos(v?.scenarios.bear.per_share), base: pos(v?.scenarios.base.per_share), bull: pos(v?.scenarios.bull.per_share) }
  const mine = values[doc.active]
  const short = sym ?? shortName(company.name)
  const hasQuarters = !!company.quarters?.dates.length
  const tracking = proj?.tracking
  const mineSrc = doc.assumption_sources[doc.active] ?? {}
  const yoursKeys = Object.keys(mineSrc).filter(k => mineSrc[k] !== 'history')
  const yours = yoursKeys.length
  mineRef.current = mine
  // the effect bar goes with a page change; Undo is for the edit you just made
  useEffect(() => { effRef.current = null; setEffect(null) }, [route.page, slug])
  const vd = verdict(price, values)
  const rules = useMemo(() => seed(defaultPaths(parsed.defaults, parsed.default_ends)), [parsed.defaults, parsed.default_ends])
  const sev = sevCounts(parsed.forensic)
  const versions = (models ?? []).filter(x => slugOf(x.id) === slug)
  const fresh = !!latestScored(tracking) && unreviewed(doc, tracking)
  const lastQ = company.quarters?.dates.at(-1)
  const railNotes: Partial<Record<Page, RailNote>> = {
    value: { text: vd.kind === 'none' ? 'no price' : vd.word.toLowerCase(), tone: vd.kind === 'fix' ? 'warn' : undefined },
    ...(sev.signs ? { risks: { text: String(sev.signs), tone: 'warn' } } : {}),
    changes: fresh ? { text: 'New', tone: 'new' } : { text: lastQ ? month(lastQ) : histYears[nHist - 1] },
    peers: { text: doc.peers?.approved_at ? `${doc.peers.chosen.length} peers` : 'none yet' },
    ...(yours ? { forecast: { text: `${yours} yours` } } : {}),
    note: { text: doc.note ? when(doc.note.written_at).replace(/ \d{4}$/, '') : ai && !ai.available ? 'AI off' : 'not written' },
    ...(doc.reports.length ? { documents: { text: String(doc.reports.length) } } : {}),
    ...(versions.length > 1 ? { versions: { text: String(versions.length) } } : {}),
  }
  const here: Here = { slug, version: route.version, page: route.page, sub: route.sub, name: company.name, short, models, hasQuarters, notes: railNotes }

  // ---- page change: title, place (Back returns to it), anchor, focus on the heading ----
  const label = PAGES.find(p => p[0] === route.page)![1]
  const stmt = route.page === 'statements' ? STATEMENTS.find(s => s[0] === route.sub)?.[1] : null
  useEffect(() => { document.title = `${short} · ${label}${stmt ? ` · ${stmt}` : ''} · Stock Model Builder` }, [short, label, stmt])
  const shown = useRef<string | null>(null) // with placed.once, a remount (another company) still counts as a move
  const done = useRef<Route | null>(null) // each navigation is placed once, not again when the projection refreshes
  const ready = proj != null
  useEffect(() => {
    if (done.current === route || ((route.anchor || route.y != null) && !ready)) return // a place below the fold waits for the numbers
    done.current = route
    const where = `${route.page}/${route.sub}`
    const moved = placed.once && shown.current !== where
    placed.once = true
    shown.current = where
    if (!route.anchor || route.y != null) {
      if (moved) document.getElementById('page-h')?.focus({ preventScroll: true }) // a screen reader reads the new page's name
      window.scrollTo({ top: route.y ?? 0, behavior: 'instant' }) // a page change jumps; only in-page links glide
      return
    }
    const t = window.setTimeout(() => {
      const el = document.getElementById(`a-${route.anchor}`) ?? document.getElementById(route.anchor)
      if (!el) return
      for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true // e.g. the audit trail
      // a tall section starts at the top (under the sticky bars: scroll-padding-top); a small target is centred
      el.scrollIntoView({ block: el.offsetHeight > innerHeight * 0.6 || el.tagName === 'SECTION' ? 'start' : 'center' })
      const f = el.matches('button, a, input, [tabindex]') ? el : el.querySelector<HTMLElement>('button, a, input, [tabindex]') ?? el
      f.focus?.({ preventScroll: true })
    }, 30)
    return () => window.clearTimeout(t)
  }, [route, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const common = { parsed, doc, setDoc, projection: proj }
  const review = () => setDocRaw(d => ({ ...d, reviewed_at: d.reviewed_at ? null : new Date().toISOString() }))
  const excelButton = (cls: string, word = 'Excel') => <button type="button" className={cls} onClick={exportXlsx} disabled={!proj || exporting}
    aria-label={exporting ? 'Exporting to Excel' : 'Download as Excel, with live formulas'}>{DL}<span>{exporting ? 'Exporting…' : word}</span></button>
  const checkButton = (cls = 'btn') => chk.state === 'running'
    ? <span className="chk-run" role="status">Checking NSE… <button type="button" className="link" onClick={stopCheck}>Stop</button></span>
    : <button type="button" className={cls} onClick={check} aria-disabled={!sym || undefined}
        title={sym ? `Fetches today’s price and any results filed since ${lastQ ? month(lastQ) : histYears[nHist - 1]}` : 'Added from an Excel export: no NSE symbol to check'}>
        {CHECK}<span>Check for new results</span></button>
  let page: ReactNode
  switch (route.page) {
    case 'business': page = <Fundamentals parsed={parsed} tracking={tracking} notes={doc.notes} hasAnnual={doc.reports.some(isAnnual)} />; break
    case 'statements': page = <StatementsPage parsed={parsed} doc={doc} projection={proj} sub={route.sub} excel={excelButton('primary', 'Download Excel')} />; break
    case 'forecast': page = <ModelView {...common} anchor={route.anchor} upgrades={upgrades} onApply={applyUpgrades} onKeep={() => setUpgrades([])} />; break
    case 'value': page = <ValuationPage {...common} />; break
    case 'priced-in': page = <PricedIn {...common} />; break
    case 'risks': page = <RisksPage parsed={parsed} doc={doc} setDoc={setDoc} upgrades={upgrades} onApply={applyUpgrades} onKeep={() => setUpgrades([])}
      onProposals={onProposals} toggleYear={toggleYear} pendingYear={pendingYear} />; break
    case 'documents': page = <Documents {...common} versions={versions} upgrades={upgrades} onApply={applyUpgrades} onProposals={onProposals}
      onCompany={onCompany} onDelete={onDelete} />; break
    case 'note': page = <NotePage {...common} />; break
    case 'peers': {
      const t = proj?.peers, read = t && peers?.approved_at ? t.peers.filter(r => r.metrics && peers.chosen.includes(r.symbol ?? '')).length : 0
      page = <>
        <PageHead label="Answers · How does it compare?" title="How does it compare?" purpose={<>{shortName(company.name)} next to listed companies in the
          same line of business, on size, growth, profitability and price.</>}
          answer={!peers?.approved_at ? <>No peers picked yet. Rules find listed companies in the same line of business{ai?.available ? '; AI can pick the closest' : ''}; you approve the set.</>
            : read && t ? peerWords(t, read, subjectOf(company)) : <>Peers picked; their numbers haven’t been read yet.</>} />
        <PeersSection parsed={parsed} doc={doc} setDoc={setDoc} projection={proj} short={shortName(company.name)} />
        <Next lead="See the price against our value, next to these peers."><a className="btn" href={href('value', 'yardsticks')}>Is it cheap?</a></Next></>
      break
    }
    case 'changes': {
      const since = company.source?.fetched_at ?? doc.saved_at
      const scored = latestScored(tracking)
      page = <>
        <PageHead label="Answers · What changed?" title="What changed?" purpose="New results set against what this model forecast. Earlier copies of the model are under Saved versions."
          answer={scored ? <Changed doc={doc} setDoc={setDoc} projection={proj} answerOnly />
            : <>No new results since {since ? `you built this on ${when(since).replace(/ \d{4}$/, '')}` : 'you built this'}. The latest filed {lastQ ? `quarter is ${month(lastQ)}` : `year is ${histYears[nHist - 1]}`}.</>} />
        {scored
          ? <><Changed doc={doc} setDoc={setDoc} projection={proj} full />
              <section className="blk" id="by-input" tabIndex={-1}><Accuracy doc={doc} setDoc={setDoc} projection={proj} /></section>
              <p className="chk-line">{checkButton()} {chk.msg && <span className="small" role="status">{chk.msg}</span>}</p></>
          : <div className="empty-state">
              <p>Results are usually filed within 45 days of a quarter’s end. Checking asks NSE for today’s price and any results filed since.</p>
              <p className="chk-line">{checkButton('primary')} {chk.msg && <span className="small" role="status">{chk.msg}</span>}</p>
            </div>}
        <Next lead="Earlier copies of this model, one per day you changed it."><a className="btn" href={href('versions')}>See saved versions</a></Next></>
      break
    }
    case 'versions': page = <Versions versions={versions} slug={slug} open={route.version} name={shortName(company.name)} onRestore={onRestore} href={href} />; break
    default: page = <Summary {...common} check={checkButton()} checkMsg={chk.msg} onReview={review} />
  }

  // ---- the company bar: who, price against our value, then case, years, check and Excel in the same place everywhere ----
  const inert = REPORTED.includes(route.page)
  const priceSrc = valuation.price != null ? 'you typed it' : sym ? `NSE, ${ago(company.source?.price_at)}` : 'from the Excel export'
  const facts = (
    <>
      {price != null
        ? <span className="bf"><span className="bl">Price</span> <b className="num mkt">Rs {rs(price)}</b> <span className="bs">({priceSrc})</span></span>
        : <a className="bf" href={href('value', 'v-price')}>No share price: type one</a>}
      <span className={`bf${yours ? ' you' : ''}`} title={yours ? `Includes ${yours} number${yours > 1 ? 's' : ''} you set` : undefined}>
        <span className="bl">Our {doc.active === 'base' ? '' : `${NAMES[doc.active].toLowerCase()} `}value</span>{' '}
        {mine != null ? <b className="num ours">Rs {rs(mine)}</b> : <b>{proj ? 'none yet' : '…'}</b>}</span>
      <Verdict price={price} values={{ ...values, base: mine }} />
    </>
  )
  const controls = (where: 'bar' | 'sheet') => <Controls where={where} doc={doc} setDoc={setDoc} inert={inert} check={checkButton(where === 'sheet' ? 'btn wide' : 'btn')}
    excel={excelButton(where === 'sheet' ? 'btn wide' : 'btn')} />
  const foot = (
    <>
      <p className={save.error ? 'bad' : 'saved'}>{save.error
        ? <>Couldn’t save · <button type="button" className="link" onClick={onRetry}>Try again</button></>
        : route.version ? 'Older version: read only' : save.at ? `✓ Saved ${clock(save.at)}` : 'Not changed yet'}</p>
      <p>{doc.reviewed_at ? <span className="reviewed">● Reviewed {when(doc.reviewed_at).replace(/ \d{4}$/, '')}</span> : <span className="draft">○ Draft, not reviewed</span>}{' · '}
        <button type="button" className="link" onClick={review}>
          {doc.reviewed_at ? 'Mark as draft' : 'Mark as reviewed'}</button></p>
      {sym && <p>Prices checked {ago(company.source?.price_at)}</p>}
    </>
  )
  const verLabel = route.version ? when(versions.find(x => x.id.endsWith(`/${route.version}`))?.saved_at ?? route.version.slice(0, 10)).replace(/ \d{4}$/, '') : ''

  return (
    <HrefCtx.Provider value={href}>
      <div className="app">
        <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to the page</a>
        <Rail here={here} foot={foot} />
        <div className="col">
          <PhoneTop short={short} menu={[{ label: doc.reviewed_at ? 'Mark as draft' : 'Mark as reviewed', onClick: review }]} />
          <header className="bar" aria-label={`${company.name}: price, our value, case and years`}>
            <div className="bar-in">
              <div className="bar-id">
                <button type="button" className="switch" onClick={() => openFinder('switch')} aria-label={`Company: ${company.name}. Switch company`}>
                  <b>{short}</b> <span aria-hidden="true">▾</span></button>
                {short !== shortName(company.name) && <span className="bar-name">{shortName(company.name)}</span>}
              </div>
              <div className="bar-facts">{facts}<Scale price={price} bear={values.bear} base={values.base} bull={values.bull} size="mini" ghost={effect?.from} /></div>
              <div className="bar-ctl">{controls('bar')}</div>
              <button type="button" className="m-ctl btn" onClick={() => setSheet(true)} aria-haspopup="dialog">
                {inert ? 'Reported years' : `${NAMES[doc.active]} · ${n} yrs`} ▾</button>
            </div>
            {(merging || (chk.msg && route.page !== 'changes' && route.page !== 'summary')) && <p className="bar-msg" role="status">{merging ?? chk.msg}</p>}
          </header>
          {effect && <EffectBar e={effect} now={mine} price={price} active={doc.active} save={save} onUndo={undo}
            changes={yoursKeys.map(k => {
              const kind = (byKey[k]?.[2] ?? 'pct') as Kind, p = scenarios[doc.active][k], d = rules[doc.active][k]
              return p && d ? `${inputName(k, byKey[k]?.[1])} ${path(d, kind)} → ${path(p, kind)}` : null
            }).filter((x): x is string => !!x)}
            onReset={() => setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [d.active]: rules[d.active] }, assumption_sources: { ...d.assumption_sources, [d.active]: {} } }))} />}
          <Sheet open={sheet} title="Case, years, new results and Excel" onClose={() => setSheet(false)}>{controls('sheet')}</Sheet>
          {route.version && <div className="notice-bar ro" role="region" aria-label="Older version">
            You’re looking at the {verLabel} version. Changes won’t be saved.{' '}
            <a href={pathOf(slug, route.page, route.sub, null, '')}>Back to today</a> · <button type="button" className="link" onClick={() => onRestore()}>Restore this version</button></div>}
          {save.error && <div className="notice-bar bad" role="alert">Couldn’t save{save.at ? ` after ${clock(save.at)}` : ''}: {save.error}. Your changes are kept in this tab.{' '}
            <button type="button" className="link" onClick={onRetry}>Try again</button></div>}
          {notice && <div className="notice-bar" role="status">{notice} <button type="button" className="link" onClick={onNotice}>OK</button></div>}
          {error && <div className="notice-bar bad" role="alert">{error}</div>}
          <main id="main" className="page" tabIndex={-1}>{page}</main>
        </div>
        <BottomBar here={here} />
      </div>
    </HrefCtx.Provider>
  )
}

/** Case, years, Check for new results and Excel: the same four, in the same order, on every page. On pages that show
 * reported years only, case and years are dimmed (still focusable) and say so. */
// the same words as Our forecast's "Copy or reset the cases"
const CASE_HINT = 'Central is our forecast. Cautious and hopeful start at central’s sales growth −/+3 points and margin −/+1.5 points.'

function Controls({ where, doc, setDoc, inert, check, excel }: {
  where: 'bar' | 'sheet'; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; inert: boolean; check: ReactNode; excel: ReactNode
}) {
  const id = useId()
  const pick = (s: Scenario) => { if (!inert) setDoc(d => ({ ...d, active: s })) }
  return (
    <div className={`ctl ${where}${inert ? ' inert' : ''}`}>
      <div className="ctl-g">
        <span className="ctl-l" id={`${id}-c`} title={CASE_HINT}>Case</span>
        <div className="seg" role="group" aria-labelledby={`${id}-c`} aria-describedby={`${id}-ch`}>
          {ORDER.map(s => (
            <button key={s} type="button" aria-pressed={doc.active === s} aria-disabled={inert || undefined}
              onClick={() => pick(s)} onKeyDown={e => groupKeys(e, ORDER, doc.active, pick)}>{NAMES[s]}</button>
          ))}
        </div>
      </div>
      <div className="ctl-g">
        <label className="ctl-l" htmlFor={`${id}-y`} title="How many years to forecast">Years forecast</label>
        <select id={`${id}-y`} className="sel" value={doc.n} aria-disabled={inert || undefined}
          onChange={e => { if (!inert) setDoc(d => ({ ...d, n: +e.target.value })) }}>
          {HORIZONS.map(h => <option key={h} value={h}>{h}</option>)}
        </select>
      </div>
      <p id={`${id}-ch`} className={where === 'sheet' ? 'small muted ctl-hint' : 'sr'}>{CASE_HINT}</p>
      {inert && <span className="ctl-note">Reported years only</span>}
      {check}
      {excel}
    </div>
  )
}

/** The effect of the edit you just made: the value before and now, against the price, saved, Undo; then every input
 * you set in this case, with Reset all to the rules. role=status, so a screen reader hears the new value. */
function EffectBar({ e, now, price, active, save, changes, onUndo, onReset }: {
  e: Effect; now: number | null; price: number | null; active: Scenario; save: SaveState; changes: string[]; onUndo: () => void; onReset: () => void
}) {
  const ch = e.from != null && now != null && e.from > 0 ? now / e.from - 1 : null
  const side = (x: number | null) => (x == null || price == null ? null : x >= price ? 'above' : 'below')
  const saved = save.error ? <span className="bad">Couldn’t save</span> : save.at && Date.parse(save.at) >= e.at - 1000 ? <>✓ Saved</> : <>Saving…</>
  const bar = useRef<HTMLDivElement>(null)
  // the bar is pinned to the window's bottom: lift the input you're editing above it instead of covering it
  useEffect(() => {
    const row = document.activeElement?.closest('.drow') ?? document.querySelector('.drow.open')
    const top = bar.current?.getBoundingClientRect().top
    const bottom = row?.getBoundingClientRect().bottom
    if (top != null && bottom != null && bottom > top - 8) window.scrollBy({ top: bottom - top + 16 })
  }, [e.at])
  return (
    <div className="eff-wrap"><div className="effect" ref={bar} role="status" aria-live="polite">
      <p className="eff-1">
        <span>Our {NAMES[active].toLowerCase()} value</span>{' '}
        {e.from != null && <s className="num">Rs {rs(e.from)}</s>} → <b className="num ours">{now != null ? `Rs ${rs(now)}` : 'no value'}</b>
        {ch != null && Math.abs(ch) >= 0.0005 && <span className="num"> {ch > 0 ? '+' : '−'}{fmt(Math.abs(ch), 'pct')}</span>}
        {price != null && now != null && <span className="eff-p"> · {side(e.from) === side(now) ? 'still ' : ''}{side(now)} the price of <span className="num mkt">Rs {rs(price)}</span>
          {' '}({gap(price, now)})</span>}
        <span className="eff-s"> · {saved} · </span><button type="button" className="btn small-btn" onClick={onUndo}>Undo</button>
      </p>
      {changes.length > 0 && <details className="eff-2"><summary>Your changes in this case ({changes.length})</summary>
        <p>{changes.join(' · ')} · <button type="button" className="link" onClick={onReset}>Reset all to the rules</button></p></details>}
    </div></div>
  )
}

/** Saved versions: one copy per day you changed it, plus copies kept on a replace or restore. */
function Versions({ versions, slug, open, name, onRestore, href }: {
  versions: ModelSummary[]; slug: string; open: string | null; name: string; onRestore: (id?: string) => void; href: Href
}) {
  const [ask, setAsk] = useState<ModelSummary | null>(null)
  const label = (x: ModelSummary) => { const ver = x.id.split('/')[1]; return x.saved_at ? `${when(x.saved_at)}${ver.length > 10 ? `, ${clock(x.saved_at).slice(-5)}` : ''}` : ver }
  return <>
    <PageHead label="Evidence · Saved versions" title="Saved versions" purpose={<>One saved copy per day you changed {name}, plus any copy kept when
      you replaced or restored it. Open one to read it; restore it if you want it back.</>}
      answer={versions.length <= 1 ? <>Only today’s version so far. A new one is kept each day you change {name}.</>
        : <>{versions.length} versions, the newest {versions[0].saved_at ? when(versions[0].saved_at) : 'today'}.</>} />
    {versions.length > 1 && <ul className="ver-list">{versions.map((x, i) => {
      const ver = x.id.split('/')[1], now = i === 0, here = (open ?? versions[0].id.split('/')[1]) === ver
      return <li key={x.id}>
        <span><b>{label(x)}</b><span className="small muted">{now ? ' · the newest, the one you edit' : ver.length > 10 ? ' · kept when it was replaced' : ''}{here ? ' · open now' : ''}</span>
          {x.values?.base != null && <span className="small muted"> · central value Rs {rs(x.values.base)}</span>}</span>
        <span className="next-act">{now ? <a className="btn" href={pathOf(slug, 'summary')}>Open</a> : <>
          <a className="btn" href={pathOf(slug, 'summary', '', ver)}>Open read-only</a>
          <button type="button" className="btn" onClick={() => setAsk(x)}>Restore this version</button></>}</span>
      </li>
    })}</ul>}
    <Confirm open={!!ask} title={ask ? `Restore the ${label(ask)} version?` : ''} yes="Restore it" no="Cancel"
      body="Today’s version is kept here, so you can go back." onYes={() => ask && onRestore(ask.id)} onClose={() => setAsk(null)} />
    <Next lead="See how the latest results compare with the forecast."><a className="btn" href={href('changes')}>What changed?</a></Next>
  </>
}
