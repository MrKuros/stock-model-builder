import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { PAGES, RAIL, STATEMENTS, navigate, pathOf, type Page } from './route'
import { SEV_WORD, gap, noNegZero, rs, verdict, type Kind, type ModelSummary, type Scenario, type Severity } from './lib'

const THEME = 'financial-model:theme'
const KEYS = 'financial-model:keys'
/** The single-key shortcuts can be turned off (they get in the way of speech input); on unless turned off here. */
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
/** Open the go-to box ('goto', the / key) or the company switcher ('switch'), or the keys list, from anywhere. */
export const openFinder = (mode: 'goto' | 'switch') => window.dispatchEvent(new CustomEvent('app:find', { detail: mode }))
export const openKeys = () => window.dispatchEvent(new Event('app:keys'))

const MARK = <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="14" width="6" height="14" fill="currentColor" />
  <rect x="13" y="8" width="6" height="20" fill="currentColor" />
  <rect x="22" y="3" width="6" height="25" fill="none" stroke="var(--ours)" strokeWidth="2.4" /></svg>
export const Brand = ({ short }: { short?: boolean }) =>
  <a className="brand" href="/" aria-label={short ? 'Stock Model Builder: coverage' : undefined}>{MARK}<span>Stock Model Builder</span></a>

const THEME_ICON = <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
  <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" /></svg>
export const ThemeButton = () => (
  <button className="tbtn" type="button" onClick={toggleTheme} aria-label="Switch light or dark theme">{THEME_ICON}<span>Theme</span></button>
)
export const DL = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3 3-3M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
export const CHECK = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8A5.5 5.5 0 1 1 11.8 4M12 1.5V4.5H9" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
const ICON: Record<string, ReactNode> = {
  summary: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12M2 8h8M2 13h10" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>,
  valuation: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 11h13" stroke="currentColor" strokeWidth="1.3" /><rect x="4" y="7.5" width="6" height="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M12.5 4v9" stroke="currentColor" strokeWidth="1.8" /></svg>,
  risks: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 6.5v3.5M8 11.5v1" stroke="currentColor" strokeWidth="1.6" /></svg>,
  forecast: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12l4-4 3 2 5-6" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="14" cy="4" r="1.6" fill="currentColor" /></svg>,
  all: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h2M2 8h2M2 12.5h2M6 3.5h8M6 8h8M6 12.5h8" stroke="currentColor" strokeWidth="1.6" /></svg>,
  companies: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="9" width="3" height="5" fill="currentColor" /><rect x="6.5" y="6" width="3" height="8" fill="currentColor" /><rect x="11" y="2.5" width="3" height="11.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>,
  watching: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>,
  add: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.8" /></svg>,
}

/** The newest saved version of each company (the library lists every version, newest first). */
export const latestOf = (models: ModelSummary[] | null) => {
  const seen = new Set<string>()
  return (models ?? []).filter(m => !seen.has(m.company) && !!seen.add(m.company))
}
export const slugOf = (id: string) => id.split('/')[0]

// ---------- small pieces every page uses ----------

const LO = -2, HI = 2 // log2(value / price): a quarter of the price to four times it
/** The bear-bull fair-value range against CMP on one log scale shared by every row: CMP is always the middle line,
 * a value to the right is above CMP (upside), to the left below it (downside). */
export function Scale({ price, bear, base, bull, size = 'row', ghost }: {
  price: number | null | undefined; bear?: number | null; base: number | null | undefined; bull?: number | null; size?: 'row' | 'mini'; ghost?: number | null
}) {
  if (base == null || price == null || !(price > 0)) return <span className={`scale ${size} none`} aria-hidden="true" />
  const at = (v: number) => Math.min(100, Math.max(0, ((Math.log2(Math.max(v, 1e-9) / price) - LO) / (HI - LO)) * 100))
  const off = base <= 0 || at(base) <= 0 ? 'lo' : at(base) >= 100 ? 'hi' : ''
  const label = `Base FV Rs ${rs(base)}${bear != null && bull != null ? ` (bear Rs ${rs(bear)}, bull Rs ${rs(bull)})` : ''}`
    + ` vs CMP Rs ${rs(price)}: ${gap(price, base)}`
  return (
    <span className={`scale ${size}`} role="img" aria-label={label} title={label}>
      <i className="ax" />
      {bear != null && bull != null && <i className="bd" style={{ left: `${at(bear)}%`, width: `${Math.max(at(bull) - at(bear), 0.8)}%` }} />}
      {ghost != null && ghost > 0 && <i className="gh" style={{ left: `${at(ghost)}%` }} />}
      <i className={`bs${off ? ` off ${off}` : ''}`} style={{ left: `${at(base)}%` }} />
      <i className="px" />
    </span>
  )
}
/** The axis above a column of scales. */
export const ScaleHead = () => (
  <span className="scale-head" aria-hidden="true">
    <span className="sh-words"><span>← FV below CMP: downside</span><span>FV above CMP: upside →</span></span>
    <span className="sh-ticks"><span style={{ left: '0%' }}>¼×</span><span style={{ left: '25%' }}>½×</span>
      <span className="p" style={{ left: '50%' }}>CMP</span><span style={{ left: '75%' }}>2×</span><span style={{ left: '100%' }}>4×</span></span>
  </span>
)
/** What the marks on a scale mean, in one line above the list (the head itself hides on narrow screens). */
export const ScaleKey = () => (
  <p className="sh-key"><span><i className="k-bd" /> bear–bull FV range</span><span><i className="k-bs" /> base FV</span>
    <span><i className="k-px" /> CMP</span><span>Log scale, FV ÷ CMP: right of centre = upside</span></p>
)

/** "Above bull FV · 22% downside to base FV": the verdict word and the gap to base FV, the same everywhere. */
export function Verdict({ price, values, words = true, to = 'base' }: { price: number | null | undefined; values: Partial<Record<Scenario, number | null>> | null | undefined; words?: boolean; to?: string }) {
  const v = verdict(price, values), g = words ? gap(price, values?.base) : null
  return <span className={`vd ${v.kind}`}>{v.word}{g && v.kind !== 'fix' ? ` · ${g} to ${to} FV` : ''}</span>
}
/** A severity: always a word, the colour only repeats it. */
export const Sev = ({ level }: { level: Severity }) => <span className={`sev ${level}`}>{SEV_WORD[level]}</span>
/** Where a number comes from, in words: rules (blue), yours (yellow highlighter), AI (purple), the market (ochre). */
export const Src = ({ kind, children }: { kind: 'rule' | 'you' | 'ai' | 'market'; children: ReactNode }) => <span className={`srcw ${kind}`}>{children}</span>

const toText = (v: number, kind: Kind) => noNegZero(kind === 'pct' ? (v * 100).toFixed(1) : String(Math.round(v)))
const STEP: Record<Kind, number> = { pct: 0.005, days: 1, num: 10 }
/** A bordered − [value] unit + box: type (Enter or leaving the box commits, Esc restores) or step with the buttons. */
export function Stepper({ id, label, kind, value, onChange, you }: {
  id: string; label: string; kind: Kind; value: number; onChange: (v: number) => void; you?: boolean
}) {
  const [draft, setDraft] = useState(toText(value, kind))
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setDraft(toText(value, kind)) }, [value, kind])
  const commit = () => {
    if (!editing.current) return
    editing.current = false
    const t = (kind === 'pct' ? draft : draft.replace(/,/g, '')).trim().replace(/%$/, '')
    const n = /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? parseFloat(t) : NaN
    if (Number.isFinite(n)) onChange(kind === 'pct' ? n / 100 : n)
    else setDraft(toText(value, kind))
  }
  const step = (s: number) => onChange(Math.round((value + s * STEP[kind]) * 1e6) / 1e6)
  return (
    <span className={`stepper${you ? ' you' : ''}`}>
      <button type="button" onClick={() => step(-1)} aria-label={`${label}: lower`}>−</button>
      <input id={id} inputMode="decimal" value={draft} aria-label={label}
        onFocus={e => { editing.current = true; e.currentTarget.select() }} onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { editing.current = false; setDraft(toText(value, kind)); e.currentTarget.blur() }
        }} />
      <span className="unit" aria-hidden="true">{kind === 'pct' ? '%' : kind === 'days' ? 'days' : 'cr'}</span>
      <button type="button" onClick={() => step(1)} aria-label={`${label}: higher`}>+</button>
    </span>
  )
}

/** Every page opens the same way: kicker, the title, what the page is for, the answer line. */
export function PageHead({ label, title, purpose, answer, next }: { label?: ReactNode; title: ReactNode; purpose: ReactNode; answer?: ReactNode; next?: ReactNode }) {
  return (
    <div className="p-head">
      <div>
        {label && <p className="label">{label}</p>}
        <h1 id="page-h" tabIndex={-1}>{title}</h1>
        <p className="purpose">{purpose}</p>
        {answer && <p className="answer">{answer}</p>}
      </div>
      {next && <div className="next">{next}</div>}
    </div>
  )
}
/** The single action box that ends a page. */
export const Next = ({ lead, children }: { lead: ReactNode; children: ReactNode }) => (
  <aside className="next-box" aria-label="What to do next"><p>{lead}</p><div className="next-act">{children}</div></aside>
)
/** One labelled click for the rest: the summary says what is inside and how many. */
export const More = ({ title, n, id, open, children }: { title: ReactNode; n?: number; id?: string; open?: boolean; children: ReactNode }) => (
  <details className="fold" id={id} open={open}><summary>{title}{n != null ? ` (${n})` : ''}</summary>{children}</details>
)

/** A native modal <dialog> that follows `open`; Esc and the backdrop close it. */
function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  const props = {
    ref, onClose, onCancel: () => onClose(),
    onClick: (e: React.MouseEvent<HTMLDialogElement>) => { if (e.target === e.currentTarget) onClose() }, // the backdrop
  }
  return props
}
/** Ask before something that can't be undone. The safe answer has the focus. */
export function Confirm({ open, title, body, yes, no = 'Keep it', onYes, onClose }: {
  open: boolean; title: string; body: ReactNode; yes: string; no?: string; onYes: () => void; onClose: () => void
}) {
  const p = useModal(open, onClose)
  const id = useId()
  return (
    <dialog {...p} className="dlg" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      <div className="dlg-body">{body}</div>
      <div className="dlg-act">
        {/* the safe answer comes first, so the dialog opens on it; CSS shows it second */}
        <button type="button" className="btn safe" onClick={onClose}>{no}</button>
        <button type="button" className="danger" onClick={() => { onClose(); onYes() }}>{yes}</button>
      </div>
    </dialog>
  )
}
/** A sheet (phones: from the bottom, full height for All pages) or a small dialog on desktop. */
export function Sheet({ open, title, onClose, full, children }: { open: boolean; title: string; onClose: () => void; full?: boolean; children: ReactNode }) {
  const p = useModal(open, onClose)
  const id = useId()
  return (
    <dialog {...p} className={`dlg sheet${full ? ' full' : ''}`} aria-labelledby={`${id}-h`}>
      <div className="sheet-h"><h2 id={`${id}-h`}>{title}</h2><button type="button" className="tbtn" onClick={onClose}>Close</button></div>
      {open && children}
    </dialog>
  )
}

export interface MenuItem { label: string; href?: string; onClick?: () => void; danger?: boolean }
/** The ⋯ menu: arrow keys move, Esc closes and returns focus to the button. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [open])
  const close = (refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus() }
  const keys = (e: React.KeyboardEvent) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  return (
    <span className="menu" ref={box} onKeyDown={open ? keys : undefined}>
      <button ref={btn} type="button" className="kebab" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg></button>
      {open && <span className="menu-list" role="menu" id={id} aria-label={label}>
        {items.map(it => it.href
          ? <a key={it.label} role="menuitem" href={it.href} onClick={() => setOpen(false)}>{it.label}</a>
          : <button key={it.label} type="button" role="menuitem" className={it.danger ? 'is-danger' : undefined}
              onClick={() => { close(true); it.onClick?.() }}>{it.label}</button>)}
      </span>}
    </span>
  )
}

// ---------- the company shell ----------

export interface RailNote { text: string; tone?: 'warn' | 'new' }
export interface Here {
  slug: string; version: string | null; page: Page; sub: string; name: string; short: string; models: ModelSummary[] | null
  hasQuarters: boolean; notes: Partial<Record<Page, RailNote>>
  lender?: boolean // a bank or NBFC: Reverse DCF reads Implied RoE, and there is no cash-flow statement
}

/** The pages in three groups with a quiet count or status each: the rail, and the phone's All pages sheet. */
function RailList({ here }: { here: Here }) {
  const href = (p: Page, sub = '') => pathOf(here.slug, p, sub, here.version)
  return (
    <nav className="rail-nav" aria-label={`Pages for ${here.short}`}>
      {RAIL.map(([group, pages]) => (
        <div key={group} className="rail-g">
          <p className="rail-gh">{group}</p>
          <ul>{pages.map(([p, label]) => {
            const n = here.notes[p]
            return <li key={p}>
              <a href={href(p, p === 'statements' && here.page === 'statements' ? here.sub : '')}
                aria-current={here.page === p ? (p === 'statements' ? 'true' : 'page') : undefined}>
                <span>{here.lender && p === 'reverse-dcf' ? 'Implied RoE' : label}</span>{n && <span className={`rn${n.tone ? ` ${n.tone}` : ''}`}>{n.text}</span>}</a>
              {p === 'statements' && here.page === 'statements' && <ul className="rail-sub">
                {STATEMENTS.filter(s => (s[0] !== 'quarters' || here.hasQuarters || here.sub === 'quarters') && !(here.lender && s[0] === 'cash-flow')).map(s => (
                  <li key={s[0]}><a href={href('statements', s[0])} aria-current={here.sub === s[0] ? 'page' : undefined}>{s[1]}</a></li>))}
              </ul>}
            </li>
          })}</ul>
        </div>
      ))}
    </nav>
  )
}

/** Desktop rail: brand, back to the list, the pages, and the quiet status foot. */
export function Rail({ here, foot }: { here: Here; foot: ReactNode }) {
  return (
    <div className="side">
      <Brand />
      <a className="back" href="/">← Coverage</a>
      <RailList here={here} />
      <div className="side-foot">{foot}<KeysFoot /></div>
    </div>
  )
}
const KeysFoot = () => (
  <div className="row"><ThemeButton /><button type="button" className="tbtn" onClick={openKeys} aria-label="Keyboard keys">Keys <kbd>?</kbd></button></div>
)

/** Rail on Coverage and Add company. */
export function HomeRail({ here, count, foot }: { here: 'home' | 'add'; count: number | null; foot?: ReactNode }) {
  return (
    <div className="side">
      <Brand />
      <nav className="rail-nav" aria-label="Library">
        <div className="rail-g">
          <p className="rail-gh">Library</p>
          <ul>
            <li><a href="/" aria-current={here === 'home' ? 'page' : undefined}><span>Coverage</span>{count != null && <span className="rn">{count}</span>}</a></li>
            <li><a href="/#watching"><span>Watchlist</span></a></li>
            <li><a href="/add" aria-current={here === 'add' ? 'page' : undefined}><span>Add company</span></a></li>
          </ul>
        </div>
      </nav>
      <div className="side-foot">{foot}<KeysFoot /></div>
    </div>
  )
}

/** Phones: back to the list, the switcher and the ⋯ menu on top. */
export function PhoneTop({ short, menu }: { short?: string; menu: MenuItem[] }) {
  return (
    <div className="mtop">
      {short != null
        ? <><a className="m-back" href="/" aria-label="Coverage: all companies">‹ All</a>
          <button type="button" className="m-switch" onClick={() => openFinder('switch')} aria-label={`Company: ${short}. Switch company`}>
            <b>{short}</b> <span aria-hidden="true">▾</span></button></>
        : <><Brand short /><b className="mtop-name">Stock Model Builder</b></>}
      <Menu label="More: theme and keys" items={[...menu, { label: 'Switch light or dark theme', onClick: toggleTheme }, { label: 'Keyboard keys', onClick: openKeys }]} />
    </div>
  )
}
/** Phones: the four pages most used and All pages (the rail as a sheet); on the list pages, Coverage, Watchlist, Add. */
export function BottomBar({ here }: { here: Here | 'home' | 'add' }) {
  const [all, setAll] = useState(false)
  if (typeof here === 'string') return (
    <nav className="bnav" aria-label="Library">
      <a href="/" aria-current={here === 'home' ? 'page' : undefined}>{ICON.companies}Coverage</a>
      <a href="/#watching">{ICON.watching}Watchlist</a>
      <a href="/add" aria-current={here === 'add' ? 'page' : undefined}>{ICON.add}Add</a>
    </nav>
  )
  const link = (p: Page, label: string) => (
    <a href={pathOf(here.slug, p, '', here.version)} aria-current={here.page === p ? 'page' : undefined}>{ICON[p]}{label}</a>)
  return (
    <>
      <nav className="bnav" aria-label={`Pages for ${here.short}`}>
        {link('summary', 'Summary')}{link('valuation', 'Valuation')}{link('risks', 'Risks')}{link('forecast', 'Forecast')}
        <button type="button" onClick={() => setAll(true)} aria-haspopup="dialog">{ICON.all}All pages</button>
      </nav>
      <Sheet open={all} title={`${here.short}: all pages`} onClose={() => setAll(false)} full>
        <div onClick={e => { if ((e.target as Element).closest('a')) setAll(false) }}><RailList here={here} /></div>
        <a className="back" href="/" onClick={() => setAll(false)}>← Coverage</a>
      </Sheet>
    </>
  )
}

// ---------- go-to box and company switcher (one listbox), and the keys list ----------

const ALIASES: Partial<Record<Page, string>> = {
  summary: 'overview home answers', valuation: 'value valuation fair dcf wacc sensitivity multiples', 'reverse-dcf': 'priced in reverse implied expectations',
  risks: 'risks checks red flags forensic beneish', tracking: 'changes results tracking new quarterly', peers: 'peers compare relative',
  forecast: 'forecast inputs assumptions drivers model', note: 'note research thesis', financials: 'business fundamentals financials growth cagr',
  statements: 'statements p&l balance cash ratios quarters', documents: 'documents sources filings audit', versions: 'versions history saved',
}
interface Item { key: string; label: string; find: string; href: string; extra?: ReactNode; side?: ReactNode }

/** `/`: go to any company or any page of the open one; the switcher: any company, keeping the page you're on. */
export function Finder({ mode, onClose, models, here }: {
  mode: 'goto' | 'switch' | null; onClose: () => void; models: ModelSummary[] | null
  here: { slug: string; short: string; name: string; page: Page; sub: string } | null
}) {
  const p = useModal(mode != null, onClose)
  const id = useId()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  useEffect(() => { if (mode) { setQ(''); setActive(0) } }, [mode])
  const pages: Item[] = here && mode === 'goto' ? PAGES.map(([pg, label]) => ({
    key: `p-${pg}`, label: `${here.short} · ${label}`, find: `${here.short} ${here.name} ${label} ${ALIASES[pg] ?? ''}`, href: pathOf(here.slug, pg),
  })) : []
  const cos: Item[] = latestOf(models).map(m => ({
    key: m.id, label: m.company, find: `${m.company} ${m.symbol ?? ''}`,
    href: pathOf(slugOf(m.id), here?.page ?? 'summary', here?.page === 'statements' ? here.sub : ''),
    extra: <span className="fi-sub">{m.symbol ?? 'from an Excel export'}{here?.slug === slugOf(m.id) ? ' · open now' : ''}</span>,
    side: <><Verdict price={m.price} values={m.values} words={false} /><Scale price={m.price} bear={m.values?.bear} base={m.values?.base} bull={m.values?.bull} size="mini" /></>,
  }))
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (it: Item) => toks.every(t => it.find.toLowerCase().includes(t))
  const items = [...(toks.length ? pages.filter(hit) : []), ...cos.filter(hit),
    { key: 'add', label: '+ Add company', find: '', href: '/add' }]
  const go = (it: Item | undefined) => { if (!it) return; onClose(); navigate(it.href) }
  const opt = (i: number) => `${id}-o${i}`
  return (
    <dialog {...p} className="dlg finder" aria-label={mode === 'switch' ? 'Switch company' : 'Go to a company or page'}>
      <label className="sr" htmlFor={`${id}-q`}>{mode === 'switch' ? 'Find a company' : 'Go to a company or page'}</label>
      <input id={`${id}-q`} className="fi-q" type="text" role="combobox" autoComplete="off" spellCheck={false} value={q} autoFocus
        placeholder={mode === 'switch' ? 'Find a company' : here ? `A company, or a page of ${here.short} (e.g. “${here.short.toLowerCase()} dcf”)` : 'A company'}
        aria-expanded="true" aria-controls={`${id}-l`} aria-autocomplete="list" aria-activedescendant={opt(Math.min(active, items.length - 1))}
        onChange={e => { setQ(e.target.value); setActive(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length) }
          else if (e.key === 'Enter') { e.preventDefault(); go(items[Math.min(active, items.length - 1)]) }
        }} />
      <ul className="fi-list" role="listbox" id={`${id}-l`} aria-label="Matches">
        {items.map((it, i) => (
          <li key={it.key} id={opt(i)} role="option" aria-selected={i === active} className={`${i === active ? 'on' : ''}${it.key === 'add' ? ' fi-add' : ''}`}
            onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => go(it)}>
            <span className="fi-main"><b>{it.label}</b>{it.extra}</span>{it.side && <span className="fi-side">{it.side}</span>}
          </li>))}
      </ul>
      <p className="fi-hint small muted">↑ ↓ to pick · Enter to open · Esc to close</p>
    </dialog>
  )
}

export function KeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [on, setOn] = useState(keysOn)
  const flip = () => {
    try { localStorage.setItem(KEYS, on ? 'off' : 'on') } catch { /* private mode: stays as it is */ }
    setOn(keysOn())
  }
  return (
    <Sheet open={open} title="Keyboard keys" onClose={onClose}>
      <dl className="keylist">
        <dt><kbd>/</kbd></dt><dd>Go to a company or a page</dd>
        <dt><kbd>1</kbd>–<kbd>6</kbd></dt><dd>The six analysis pages: Summary, Valuation, Reverse DCF, Risks & forensics, Results tracking, Peers</dd>
        <dt><kbd>?</kbd></dt><dd>This list</dd>
        <dt><kbd>Esc</kbd></dt><dd>Close a menu, sheet or box</dd>
      </dl>
      <p className="small muted">Keys never act while you type in a box.</p>
      <p><button type="button" className="btn" aria-pressed={!on} onClick={flip}>{on ? 'Turn keys off' : 'Keys are off: turn them on'}</button></p>
    </Sheet>
  )
}
