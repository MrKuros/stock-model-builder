import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PAGES, SECTIONS, STATEMENTS, navigate, pathOf, type Page } from './route'
import { AddBox } from './Fetch'
import { rs, when, type ModelSummary } from './lib'

const THEME = 'financial-model:theme'
const KEYS = 'financial-model:keys'
/** The single-key page shortcuts can be turned off (they get in the way of speech input); on unless turned off here. */
export function keysOn() {
  try { return localStorage.getItem(KEYS) !== 'off' } catch { return true }
}
const GROUND = { light: '#e6e9e5', dark: '#0e1211' }
/** Light / dark: the system's unless picked here; the pick is kept per browser (index.html applies it before paint). */
export function toggleTheme() {
  const r = document.documentElement
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  const t = dark ? 'light' : 'dark'
  r.dataset.theme = t
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', GROUND[t]))
  try { localStorage.setItem(THEME, t) } catch { /* private mode */ }
}

const MARK = <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="14" width="6" height="14" fill="currentColor" />
  <rect x="13" y="8" width="6" height="20" fill="currentColor" />
  <rect x="22" y="3" width="6" height="25" fill="none" stroke="var(--ours)" strokeWidth="2.4" /></svg>
export const Brand = ({ short }: { short?: boolean }) =>
  <a className="brand" href="/" aria-label={short ? 'Stock Model Builder: all companies' : undefined}>{MARK}<span>Stock Model Builder</span></a>

const THEME_ICON = <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
  <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" /></svg>
export const ThemeButton = ({ label = true }: { label?: boolean }) => (
  <button className="tbtn" type="button" onClick={toggleTheme} aria-label="Switch light or dark theme">
    {THEME_ICON}{label && <span className="t-l">Theme</span>}
  </button>
)
export const DL = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3 3-3M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>

const ICONS: Record<Page | 'companies', ReactNode> = {
  companies: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" strokeWidth="1.6" /></svg>,
  overview: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12M2 8h8M2 13h10" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>,
  fundamentals: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 14V9M6.2 14V6M9.9 14V7.5M13.6 14V3" fill="none" stroke="currentColor" strokeWidth="2" /></svg>,
  statements: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2 6.2h12M2 9.8h12M6 2.5v11" stroke="currentColor" strokeWidth="1.2" /></svg>,
  forecast: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12l4-4 3 2 5-6" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="14" cy="4" r="1.6" fill="currentColor" /></svg>,
  valuation: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 11h13" stroke="currentColor" strokeWidth="1.3" /><rect x="4" y="7.5" width="6" height="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M12.5 4v9" stroke="currentColor" strokeWidth="1.8" /></svg>,
  checks: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.8" /></svg>,
}

/** Price (ochre) against bear-bull (blue band) and base (blue tick) on one small scale. */
export function MiniRange({ price, bear, base, bull }: { price: number | null; bear: number | null; base: number | null; bull: number | null }) {
  const pts = [price, bear, base, bull].filter((x): x is number => x != null)
  if (base == null || pts.length < 2) return <span className="mini" aria-hidden="true" />
  const lo = Math.min(...pts), hi = Math.max(...pts), pad = (hi - lo || 1) * 0.08
  const x = (n: number) => `${((n - lo + pad) / (hi - lo + 2 * pad)) * 100}%`
  const label = `Bear Rs ${bear == null ? '–' : rs(bear)}, base Rs ${rs(base)}, bull Rs ${bull == null ? '–' : rs(bull)}` +
    (price != null ? `, price Rs ${rs(price)}` : '')
  return (
    <span className="mini" role="img" aria-label={label}>
      <i className="ax" />
      {bear != null && bull != null && <i className="bd" style={{ left: x(bear), width: `calc(${x(bull)} - ${x(bear)})` }} />}
      <i className="bs" style={{ left: x(base) }} />
      {price != null && <i className={`px${price > (lo + hi) / 2 ? ' r' : ''}`} style={{ left: x(price) }}><span>{rs(price)}</span></i>}
    </span>
  )
}
/** Where the price sits against our range, in words. */
export function rangeWords(price: number | null, bear: number | null, base: number | null, bull: number | null): ReactNode {
  if (base == null) return 'No value yet'
  if (price == null) return <>Base <span className="num ours">Rs {rs(base)}</span>, no price</>
  const where = bull != null && price > bull ? 'above our range' : bear != null && price < bear ? 'below our range' : 'inside our range'
  return <>Base value <b className="num ours">Rs {rs(base)}</b> · price <b className="num mkt">{rs(price)}</b> sits {where}{bear != null && bull != null && <> <span className="num ours">{rs(bear)}–{rs(bull)}</span></>}</>
}

/** The newest saved version of each company (the library lists every day). */
export const latestOf = (models: ModelSummary[] | null) => {
  const seen = new Set<string>()
  return (models ?? []).filter(m => !seen.has(m.company) && !!seen.add(m.company))
}
export const slugOf = (id: string) => id.split('/')[0]

export interface Here {
  slug: string; version: string | null; page: Page; sub: string; name: string; short: string
  range: { price: number | null; bear: number | null; base: number | null; bull: number | null }
  hasQuarters: boolean; models: ModelSummary[] | null
}

/** The company switcher: a native <details>; every company is a real link to the same page of that company. */
function Switcher({ here, compact }: { here: Here; compact?: boolean }) {
  const others = latestOf(here.models)
  const box = useRef<HTMLDetailsElement>(null)
  useEffect(() => { // a menu closes on Escape, a click outside it, or a pick inside it
    const close = (refocus: boolean) => {
      const d = box.current
      if (!d?.open) return
      d.open = false
      if (refocus) d.querySelector('summary')?.focus()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && box.current?.open) { e.preventDefault(); close(true) } }
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) close(false) }
    const pick = (e: MouseEvent) => { if ((e.target as Element).closest?.('.sw-list a')) close(false) }
    const d = box.current
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', down)
    d?.addEventListener('click', pick)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down); d?.removeEventListener('click', pick) }
  }, [])
  const list = (
    <nav className="sw-list" aria-label="Your companies">
      {others.map(m => {
        const s = slugOf(m.id)
        return <a key={m.id} href={pathOf(s, here.page, here.sub)} aria-current={s === here.slug ? 'true' : undefined}>
          <span>{m.company}</span><span>{m.saved_at ? when(m.saved_at) : ''}</span></a>
      })}
    </nav>
  )
  const menu = (
    <div className="sw-menu">
      {list}
      <div className="sw-add">
        <AddBox models={here.models} compact onAdd={sym => navigate(`/?add=${encodeURIComponent(sym)}`)}
          upload={<a href="/?upload=1">Upload an Excel export instead</a>} />
      </div>
    </div>
  )
  if (compact) return (
    <details className="m-switch" ref={box}>
      <summary aria-label={`Company: ${here.name}. Switch or add a company`}><b>{here.short}</b><span>Switch ▾</span></summary>
      {menu}
    </details>
  )
  return (
    <details className="switch" ref={box}>
      <summary aria-label={`Company: ${here.name}. Switch or add a company`}>
        <span className="sw-top"><span className="sw-name">{here.short}</span><span className="sw-chev">Switch ▾</span></span>
        {!here.name.startsWith(here.short) && <span className="sw-full">{here.name}</span>}
        <MiniRange {...here.range} />
        <span className="sw-cap">{rangeWords(here.range.price, here.range.bear, here.range.base, here.range.bull)}</span>
      </summary>
      {menu}
    </details>
  )
}

const pageLinks = (here: Here) => PAGES.map(([p, label], i) => ({
  p, label, key: i + 1, href: pathOf(here.slug, p, p === 'statements' ? (here.page === 'statements' ? here.sub : '') : '', here.version),
}))

/** Desktop: brand, switcher, the six pages (the open one lists its sections), theme and the key hint at the foot. */
export function Side({ here }: { here: Here | null }) {
  const subs: [string, string][] = !here ? [] : here.page === 'statements'
    ? STATEMENTS.filter(s => s[0] !== 'quarters' || here.hasQuarters || here.sub === 'quarters').map(s => [pathOf(here.slug, 'statements', s[0], here.version), s[1]])
    : (SECTIONS[here.page] ?? []).map(([id, t]) => [`#${id}`, t])
  return (
    <div className="side">
      <Brand />
      {here ? <>
        <Switcher here={here} />
        <nav className="nav" aria-label={`Pages for ${here.short}`}>
          {pageLinks(here).map(l => (
            <div key={l.p}>
              <a href={l.href} aria-current={here.page === l.p ? (l.p === 'statements' ? 'true' : 'page') : undefined} aria-keyshortcuts={String(l.key)}>
                {ICONS[l.p]}<span>{l.label}</span><kbd aria-hidden="true">{l.key}</kbd></a>
              {here.page === l.p && subs.length > 0 && <div className="sub">
                {subs.map(([h, t]) => <a key={h} href={h} aria-current={here.page === 'statements' && h.split('?')[0].endsWith(`/${here.sub}`) ? 'page' : undefined}>{t}</a>)}
              </div>}
            </div>
          ))}
        </nav>
      </> : (
        <nav className="nav" aria-label="Main">
          <a href="/" aria-current="page">{ICONS.companies}<span>Companies</span></a>
        </nav>
      )}
      <div className="side-foot">
        <div className="row">{here ? <a className="tbtn" href="/">All companies</a> : <span />}<ThemeButton /></div>
        {here && <KeyHint />}
      </div>
    </div>
  )
}

function KeyHint() {
  const [on, setOn] = useState(keysOn)
  const flip = () => {
    try { localStorage.setItem(KEYS, on ? 'off' : 'on') } catch { /* private mode: stays as it is */ }
    setOn(keysOn())
  }
  return <span>{on ? <>Press <kbd>1</kbd>–<kbd>6</kbd> to switch pages · </> : 'Page keys are off · '}
    <button type="button" className="link" onClick={flip}>{on ? 'Turn off' : 'Turn on'}</button></span>
}

/** Phones: brand mark, the company switcher and theme on top; the six pages along the bottom. */
export function MobileTop({ here }: { here: Here | null }) {
  return (
    <div className="mtop">
      <Brand short />
      {here ? <Switcher here={here} compact /> : <b className="mtop-name">Stock Model Builder</b>}
      <ThemeButton label={false} />
    </div>
  )
}
export function BottomNav({ here }: { here: Here }) {
  return (
    <nav className="bnav" aria-label={`Pages for ${here.short}`}>
      {pageLinks(here).map(l => <a key={l.p} href={l.href} aria-current={here.page === l.p ? 'page' : undefined}>{ICONS[l.p]}{l.label}</a>)}
    </nav>
  )
}

/** A long page's sections as chips (phones; the sidebar lists them on desktop). */
export function Toc({ page, extra = [] }: { page: Page; extra?: [string, string][] }) {
  const s = SECTIONS[page] && [...extra, ...SECTIONS[page]!]
  if (!s) return null
  return <nav className="toc" aria-label="On this page">{s.map(([id, t]) => <a key={id} href={`#${id}`}>{t}</a>)}</nav>
}

/** Every page opens the same way: what it is (label), a heading that answers it, one sentence on what to do, the next action. */
export function PageHead({ label, title, purpose, next }: { label: ReactNode; title: ReactNode; purpose: ReactNode; next?: ReactNode }) {
  return (
    <div className="p-head">
      <div>
        <p className="label">{label}</p>
        <h1 id="page-h" tabIndex={-1}>{title}</h1>
        <p className="purpose">{purpose}</p>
      </div>
      {next && <div className="next">{next}</div>}
    </div>
  )
}
