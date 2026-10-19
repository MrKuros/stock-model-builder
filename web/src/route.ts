/** Real path URLs: / (your companies), /add, /c/<slug>/<page>[/<statement>][?v=<version>][#<anchor>]. Every link is an
 * <a href>; clicks on same-origin links are taken here (pushState), so a page switch keeps the open model. */
import { createContext, useContext } from 'react'

export type Page = 'summary' | 'value' | 'priced-in' | 'risks' | 'changes' | 'peers' | 'forecast' | 'note' | 'business'
  | 'statements' | 'documents' | 'versions'
/** Page names from before the redesign; links and addresses using them land on their new page (moved()). */
type OldPage = 'overview' | 'fundamentals' | 'valuation' | 'checks'

/** The rail: three groups, each page with its label (the title of its page, a question where it answers one). */
export const RAIL: [string, [Page, string][]][] = [
  ['Answers', [['summary', 'Summary'], ['value', 'Is it cheap?'], ['priced-in', 'What does the price assume?'],
    ['risks', 'What could go wrong?'], ['changes', 'What changed?'], ['peers', 'How does it compare?']]],
  ['Work on it', [['forecast', 'Our forecast'], ['note', 'Research note']]],
  ['Evidence', [['business', 'How the business is doing'], ['statements', 'Statements'], ['documents', 'Documents and sources'],
    ['versions', 'Saved versions']]],
]
export const PAGES: [Page, string][] = RAIL.flatMap(g => g[1])
/** The number keys 1-6: the Answers pages. */
export const ANSWERS = RAIL[0][1].map(p => p[0])
/** Pages that show reported years only: the case and years controls do nothing there (dimmed, still focusable). */
export const REPORTED: Page[] = ['business', 'risks', 'documents', 'versions', 'peers']

/** Statement sub-pages: url, tab label, the LAYOUT section it shows */
export const STATEMENTS = [
  ['profit-and-loss', 'Profit & loss', 'PROFIT & LOSS'], ['balance-sheet', 'Balance sheet', 'BALANCE SHEET'],
  ['cash-flow', 'Cash flow', 'CASH FLOW'], ['ratios', 'Ratios', 'RATIOS'], ['quarters', 'Quarters', 'QUARTERS'],
] as const

/** Set once the first page of this load is placed: every later page (another company, Back, the list) moves focus
 * to its heading; the first one leaves focus where the browser put it. */
export const placed = { once: false }

/** A version id: a day, or a copy kept on a replace or restore at that day's time (server.MODEL_ID). */
export const VERSION = /^\d{4}-\d{2}-\d{2}(-\d{4})?$/

/** An old page (and its anchor) as the new page and anchor; a new page is itself. */
export function moved(page: string, anchor = ''): [Page, string] {
  switch (page as Page | OldPage) {
    case 'overview': return anchor === 'changed' ? ['changes', ''] : ['summary', anchor]
    case 'fundamentals': return ['business', anchor]
    case 'valuation': return anchor === 'hinges' || anchor === 'gap' ? ['priced-in', ''] : anchor === 'peers' ? ['peers', ''] : ['value', anchor]
    case 'checks': return anchor === 'documents' ? ['documents', 'add'] : anchor === 'audit' || anchor.startsWith('src-') ? ['documents', anchor.startsWith('src-') ? 'reading' : anchor] : ['risks', anchor === 'flags' ? 'signs' : anchor]
    case 'forecast': return anchor === 'tracking' ? ['changes', 'by-input'] : ['forecast', anchor]
  }
  return PAGES.some(p => p[0] === page) ? [page as Page, anchor] : ['summary', '']
}

export interface Route {
  slug: string | null; page: Page; sub: string; version: string | null; anchor: string; y: number | null
  top: 'home' | 'add' | 'none' | null // a top-level page (no company), 'none' = no page at this address
}

/** The address as a route; an old address comes back with `redirect` set to its new one. */
export function readRoute(): Route & { redirect?: string } {
  const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const q = new URLSearchParams(location.search)
  const v = q.get('v')
  const anchor = decodeURIComponent(location.hash.slice(1))
  const y = typeof history.state?.y === 'number' ? history.state.y : null
  const base = { slug: null, page: 'summary' as Page, sub: '', version: null, anchor, y }
  if (!parts.length) {
    if (q.has('upload')) return { ...base, top: 'add', anchor: 'upload', redirect: '/add#upload' }
    return { ...base, top: 'home' }
  }
  if (parts[0] === 'add' && parts.length === 1) return { ...base, top: 'add' }
  if (parts[0] !== 'c' || !parts[1]) return { ...base, top: 'none' }
  const [page, a] = moved(parts[2] ?? 'summary', anchor)
  const sub = page === 'statements' ? (STATEMENTS.some(s => s[0] === parts[3]) ? parts[3] : STATEMENTS[0][0]) : ''
  const version = v && VERSION.test(v) ? v : null
  const r: Route = { slug: parts[1], page, sub, version, anchor: a, y, top: null }
  const url = pathOf(r.slug!, page, sub, version, a)
  return url === location.pathname + location.search + location.hash ? r : { ...r, redirect: url }
}

export function pathOf(slug: string, page: Page | OldPage = 'summary', sub = '', version: string | null = null, anchor = '') {
  const [p, a] = moved(page, anchor)
  const s = p === 'statements' ? `/${sub || STATEMENTS[0][0]}` : ''
  return `/c/${encodeURIComponent(slug)}/${p}${s}${version ? `?v=${version}` : ''}${a ? `#${a}` : ''}`
}

/** Go to a URL inside the app: remembers where you were on this entry (Back returns there), then tells App. */
export function navigate(url: string, replace = false) {
  try { history.replaceState({ ...history.state, y: window.scrollY }, '') } catch { /* ignore */ }
  if (replace) history.replaceState({ y: null }, '', url)
  else history.pushState({ y: null }, '', url)
  window.dispatchEvent(new Event('app:navigate'))
}

/** Same-origin <a> clicks become in-app navigation; ctrl/cmd/shift/middle click, target and download stay with the browser. */
export function onLinkClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = (e.target as Element | null)?.closest?.('a')
  if (!a || !a.href || a.target || a.hasAttribute('download')) return
  const u = new URL(a.href)
  if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return
  e.preventDefault()
  navigate(u.pathname + u.search + u.hash)
}

/** The open company's links: href('value', 'bridge') -> /c/tcs/value#bridge. Old page names still work (moved()). */
export type Href = (page: Page | OldPage, anchor?: string, sub?: string) => string
export const HrefCtx = createContext<Href>(() => '/')
export const useHref = () => useContext(HrefCtx)
