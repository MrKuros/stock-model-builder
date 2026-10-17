import { useEffect, useRef, useState, type ReactNode } from 'react'
import { withFlagNotes, withNotes } from './Sources'
import Note, { shortName } from './Note'
import ModelView, { UPGRADED, type Upgrade } from './Model'
import Evidence from './Evidence'
import Fundamentals from './Fundamentals'
import StatementsPage from './Statements'
import ValuationPage from './Valuation'
import { BottomNav, DL, MobileTop, Side, type Here } from './Shell'
import { HrefCtx, PAGES, STATEMENTS, pathOf, type Href, type Route } from './route'
import type { SaveState } from './App'
import {
  api, clock, flat, groupKeys, money, postJson, rs, when, SCENARIOS,
  type ModelDoc, type ModelSummary, type Parsed, type Projection, type Proposal, type Scenario,
} from './lib'

const NAMES: Record<Scenario, string> = { base: 'Base', bull: 'Bull', bear: 'Bear' }
const ORDER: Scenario[] = ['bear', 'base', 'bull']
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
}

/** One company: the shell (sidebar, context bar, bottom nav) and its six pages. Stays mounted while you move between
 * pages, so the projection and every input are kept; /api/project runs again only when an input changes. */
export default function Workspace({ route, models, parsed, doc, setDoc: setDocRaw, setDefaults, setParsed, save, notice, onRetry }: Props) {
  const { company, years: histYears, drivers } = parsed
  const { n, scenarios, valuation, filings, notes, flag_notes, assumption_sources, excluded_years } = doc
  const slug = route.slug!
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
  const nHist = histYears.length

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
    if (at) setRetried(at)
  }

  const proj = projection?.scenarios.base.length === n ? projection : null // null while a new horizon loads
  const v = proj?.valuation ?? null
  const m = company.market
  const price = valuation.price ?? m?.price ?? null
  const shares = valuation.shares ?? m?.shares ?? null
  const fromDocs = Object.values(doc.assumption_sources.base ?? {}).filter(x => x !== 'manual' && x !== 'history').length
  const ai = Object.values(notes).some(x => (x as { ai?: boolean })?.ai) || doc.note != null || doc.flag_notes.length > 0
  const short = shortName(company.name)
  const hasQuarters = !!company.quarters?.dates.length
  const here: Here = {
    slug, version: route.version, page: route.page, sub: route.sub, name: company.name, short, models, hasQuarters,
    range: { price: v?.price ?? price, bear: v?.scenarios.bear.per_share ?? null, base: v?.scenarios.base.per_share ?? null, bull: v?.scenarios.bull.per_share ?? null },
  }
  const href: Href = (page, anchor = '', sub = '') => pathOf(slug, page, sub, route.version, anchor)

  // ---- page change: title, place (Back returns to it), anchor, focus on the heading ----
  const label = PAGES.find(p => p[0] === route.page)![1]
  const stmt = route.page === 'statements' ? STATEMENTS.find(s => s[0] === route.sub)?.[1] : null
  useEffect(() => { document.title = `${short} · ${label}${stmt ? ` · ${stmt}` : ''} · Stock Model Builder` }, [short, label, stmt])
  const shown = useRef<string | null>(null)
  const done = useRef<Route | null>(null) // each navigation is placed once, not again when the projection refreshes
  const ready = proj != null
  useEffect(() => {
    if (done.current === route || ((route.anchor || route.y != null) && !ready)) return // a place below the fold waits for the numbers
    done.current = route
    const where = `${route.page}/${route.sub}`
    const moved = shown.current != null && shown.current !== where
    shown.current = where
    if (route.y != null) { window.scrollTo(0, route.y); return }
    if (!route.anchor) {
      window.scrollTo(0, 0)
      if (moved) document.getElementById('page-h')?.focus({ preventScroll: true })
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
  let page: ReactNode
  switch (route.page) {
    case 'fundamentals': page = <Fundamentals parsed={parsed} />; break
    case 'statements': page = <StatementsPage parsed={parsed} doc={doc} projection={proj} sub={route.sub} />; break
    case 'forecast': page = <ModelView {...common} anchor={route.anchor} upgrades={upgrades} onApply={applyUpgrades} />; break
    case 'valuation': page = <ValuationPage {...common} />; break
    case 'checks': page = <Evidence {...common} upgrades={upgrades} onApply={applyUpgrades} onProposals={onProposals}
      toggleYear={toggleYear} pendingYear={pendingYear} defaultsNote={defaultsNote} />; break
    default: page = <Note {...common} />
  }

  return (
    <HrefCtx.Provider value={href}>
      <div className="app">
        <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to the page</a>
        <Side here={here} />
        <div className="col">
          <MobileTop here={here} />
          <header className="ctx" aria-label={`${company.name}: case, years and status`}>
            <div className="ctx-in">
              <p className="facts">
                <b>{company.name}</b>
                {price != null
                  ? <span>Price <span className="num mkt">Rs {rs(price)}</span>{valuation.price != null ? ' (typed)' : ''}</span>
                  : <a href={href('valuation', 'v-price')}>No share price: type one</a>}
                {price != null && shares != null && <span className="wide">Market cap <span className="num">Rs {money(price * shares)} cr</span></span>}
                <span className="wide">Rs crore · reported {histYears[0]}–{histYears[nHist - 1]}</span>
              </p>
              <div className="controls">
                <div className="seg" role="radiogroup" aria-label="Case: bear is cautious, base is central, bull is hopeful">
                  {ORDER.map(s => (
                    <button key={s} type="button" role="radio" aria-checked={doc.active === s} tabIndex={doc.active === s ? 0 : -1}
                      onClick={() => setDoc(d => ({ ...d, active: s }))}
                      onKeyDown={e => groupKeys(e, ORDER, doc.active, s => setDoc(d => ({ ...d, active: s })))}>{NAMES[s]}</button>
                  ))}
                </div>
                <label className="sr" htmlFor="horizon">Years to forecast</label>
                <select id="horizon" className="sel" value={n} onChange={e => setDoc(d => ({ ...d, n: +e.target.value }))}>
                  {HORIZONS.map(h => <option key={h} value={h}>{h} years</option>)}
                </select>
                <button type="button" className="btn" onClick={exportXlsx} disabled={!proj || exporting}
                  aria-label={exporting ? 'Exporting to Excel' : 'Download as Excel, with live formulas'}>
                  {DL}<span className="t-l">{exporting ? 'Exporting…' : 'Excel'}</span></button>
              </div>
              <p className="status" aria-live="polite">
                {save.error
                  ? <span className="bad" role="alert">Not saved: {save.error}{' '}<button type="button" className="link" onClick={retry}>Try again</button></span>
                  : save.at && <span className="saved">{retried === save.at ? 'Saved' : `Saved ${clock(save.at)}`}</span>}
                <span className={doc.reviewed_at ? 'reviewed' : 'draft'}>
                  {doc.reviewed_at ? `Reviewed by you ${when(doc.reviewed_at)}` : 'Draft: you haven’t reviewed it'}</span>
                <button type="button" className="link"
                  onClick={() => setDocRaw(d => ({ ...d, reviewed_at: d.reviewed_at ? null : new Date().toISOString() }))}>
                  {doc.reviewed_at ? 'Mark as draft' : 'Mark as reviewed'}</button>
                <span className="src">Numbers: rules{filings.length ? ', filings' : ''}{fromDocs ? `, ${fromDocs} input${fromDocs > 1 ? 's' : ''} from documents` : ''} · Words: {ai ? 'AI-written, cited' : 'none by AI yet'}</span>
                {error && <span className="bad" role="alert">{error}</span>}
                {notice && <span className="note">{notice}</span>}
              </p>
            </div>
          </header>
          <main id="main" className="page" tabIndex={-1}>{page}</main>
        </div>
        <BottomNav here={here} />
      </div>
    </HrefCtx.Provider>
  )
}
