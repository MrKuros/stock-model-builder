/** Real path URLs: / (your companies), /c/<slug>/<page>[/<statement>][?v=<date>][#<anchor>]. Every link is an <a href>;
 * clicks on same-origin links are taken here (pushState), so a page switch keeps the open model and its projection. */
import { createContext, useContext } from 'react'

export type Page = 'overview' | 'fundamentals' | 'statements' | 'forecast' | 'valuation' | 'checks'
/** id and nav label; the number keys 1-6 follow this order */
export const PAGES: [Page, string][] = [
  ['overview', 'Overview'], ['fundamentals', 'Fundamentals'], ['statements', 'Statements'],
  ['forecast', 'Forecast'], ['valuation', 'Valuation'], ['checks', 'Checks'],
]
/** Statement sub-pages: url, tab label, the LAYOUT section it shows */
export const STATEMENTS = [
  ['profit-and-loss', 'Profit & loss', 'PROFIT & LOSS'], ['balance-sheet', 'Balance sheet', 'BALANCE SHEET'],
  ['cash-flow', 'Cash flow', 'CASH FLOW'], ['ratios', 'Ratios', 'RATIOS'], ['quarters', 'Quarters', 'QUARTERS'],
] as const
/** Sections of the long pages: the sidebar's index and the phone's chips */
export const SECTIONS: Partial<Record<Page, [string, string][]>> = {
  fundamentals: [['growth', 'Growth'], ['charts', 'Charts'], ['ratios', 'Key ratios']],
  forecast: [['inputs', 'Inputs'], ['draft', 'From documents'], ['projection', 'Projection']],
  valuation: [['inputs', 'Inputs'], ['worth', 'Value by case'], ['hinges', 'What moves it'], ['gap', 'Close the gap'],
    ['sure', 'How sure'], ['multiples', 'Multiples']],
  checks: [['flags', 'Warning signs'], ['unusual', 'Unusual years'], ['documents', 'Documents'], ['audit', 'Audit trail']],
}

/** Set once the first page of this load is placed: every later page (another company, Back, the list) moves focus
 * to its heading; the first one leaves focus where the browser put it. */
export const placed = { once: false }

export interface Route { slug: string | null; page: Page; sub: string; version: string | null; anchor: string; y: number | null }

export function readRoute(): Route {
  const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const version = new URLSearchParams(location.search).get('v')
  const anchor = decodeURIComponent(location.hash.slice(1))
  const y = typeof history.state?.y === 'number' ? history.state.y : null
  if (parts[0] !== 'c' || !parts[1]) return { slug: null, page: 'overview', sub: '', version: null, anchor, y }
  const page = (PAGES.some(p => p[0] === parts[2]) ? parts[2] : 'overview') as Page
  const sub = page === 'statements' ? (STATEMENTS.some(s => s[0] === parts[3]) ? parts[3] : STATEMENTS[0][0]) : ''
  return { slug: parts[1], page, sub, version: version && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : null, anchor, y }
}

export function pathOf(slug: string, page: Page = 'overview', sub = '', version: string | null = null, anchor = '') {
  const s = page === 'statements' ? `/${sub || STATEMENTS[0][0]}` : ''
  return `/c/${encodeURIComponent(slug)}/${page}${s}${version ? `?v=${version}` : ''}${anchor ? `#${anchor}` : ''}`
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

/** The open company's links: href('valuation', 'hinges') -> /c/tcs/valuation#hinges */
export type Href = (page: Page, anchor?: string, sub?: string) => string
export const HrefCtx = createContext<Href>(() => '/')
export const useHref = () => useContext(HrefCtx)
