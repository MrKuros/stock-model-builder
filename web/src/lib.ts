import type { KeyboardEvent } from 'react'

export type Row = Record<string, number | null>
export type Kind = 'pct' | 'days' | 'num'
export type Driver = [key: string, label: string, kind: Kind]
export type LineKind = Kind | 'x' // 'x' = multiple, e.g. 2.4x
export type LayoutLine = [label: string, key: string | null, kind: LineKind | 'chk' | 'head' | null]

/** One assumption over the projection: end null = flat, else a straight line from start (first year) to end (last). */
export interface Path { start: number; end: number | null }
export type Paths = Record<string, Path>
export const flat = (start: number): Path => ({ start, end: null })
export const flatAll = (d: Record<string, number>): Paths =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, flat(v)]))

export const SCENARIOS = ['base', 'bull', 'bear'] as const
export type Scenario = typeof SCENARIOS[number]
export type Scenarios = Record<Scenario, Paths>

/** Bull and bear start from base: growth ± 3 pp, EBITDA margin ± 1.5 pp, everything else equal. */
export const SHIFT: Record<string, number> = { growth: 0.03, ebitda_margin: 0.015 }
export function seed(base: Paths): Scenarios {
  const move = (sign: number): Paths => Object.fromEntries(Object.entries(base).map(([k, p]) => {
    const d = (SHIFT[k] ?? 0) * sign
    return [k, d ? { start: p.start + d, end: p.end == null ? null : p.end + d } : p]
  }))
  return { base, bull: move(1), bear: move(-1) }
}

/** Share price (Rs) and count (crore) from the export; null when Export left them out. */
export interface Market { price: number | null; shares: number | null; price_hist: (number | null)[]; shares_hist: (number | null)[] }
/** The export's Quarters block (model.QUARTERS keys: sales, op_profit, net_profit, ...), null where Export left a gap. */
export interface Quarters { dates: string[]; rows: Record<string, (number | null)[]> }
export interface Company { name: string; dates: string[]; hist: Row[]; market?: Market; quarters?: Quarters | null }
/** Trailing twelve months (model.ttm): the four quarters ending `end`, each row summed (null if one is missing). */
export interface Ttm { end: string; values: Row }
/** A reported figure that moved > 0.5% against the latest saved model of this company (server.restatements). */
export interface Restated { id: string; saved_at: string | null; changes: { year: string; line: string; old: number; new: number }[] }
/** DCF inputs (model.VALUATION). kd null = base scenario's interest rate; price/shares null = market data. */
export interface ValInputs {
  rf: number; erp: number; beta: number; kd: number | null; g: number; mid_year: boolean
  wacc_override: number | null; price: number | null; shares: number | null
}
/** One scenario's DCF (model.valuation). Nulls when WACC doesn't clear terminal growth, or no shares. */
export interface ScenarioValue {
  fcff: number[]; pv: number[] | null; pv_sum: number | null; tv: number | null; pv_tv: number | null
  ev: number | null; minority: number | null; equity: number | null; per_share: number | null; upside: number | null
  tv_share: number | null
  error: string | null // this scenario only, e.g. a negative final-year FCFF (no terminal value); the WACC error is global
  grid: (number | null)[][] // value per share: WACC + steps.wacc (rows) x g + steps.g (columns)
  grid_gm: (number | null)[][] // revenue growth + steps.growth (rows) x EBITDA margin + steps.margin, every year
  implied_growth?: number | null // reverse DCF: flat revenue growth at which value per share = price; null = none in range
  /** At today's price and at this value per share, on the last reported (last) and first projected (next) year. */
  multiples?: Record<'price_last' | 'price_next' | 'value_last' | 'value_next', Multiples>
}
export type Multiple = 'pe' | 'ev_ebitda' | 'pb'
export type Multiples = Record<Multiple, number | null> // null: no market cap, a value <= 0, or a denominator <= 0
export interface Valuation {
  price: number | null; shares: number | null; ke: number; kd: number; tax: number; kd_after_tax: number
  e: number; d: number; we: number; wacc: number; wacc_build: number; g: number; error: string | null
  nci: number // minorities' share of profit deducted from equity (base scenario, first projected year)
  borrowings: number; cash: number; investments: number; scenarios: Record<Scenario, ScenarioValue>
  /** Each reported year end's multiples (year-end price), with their median, low and high. Missing on an old server. */
  multiples?: { hist: Record<Multiple, (number | null)[]>; median: Multiples; min: Multiples; max: Multiples }
  /** Missing on a server not yet restarted after an update; the panel then hides the grids. */
  steps?: { wacc: number[]; g: number[]; growth: number[]; margin: number[]; implied?: [number, number] }
}
/** What the client holds and saves. The API takes it as is (it ignores excluded_years and saved_at). */
export interface ModelDoc {
  version: 5
  company: Company
  n: number
  active: Scenario
  scenarios: Scenarios
  excluded_years: string[]
  saved_at: string | null
  valuation: ValInputs
  // Phase 3 blocks (sources, AI proposals, approved notes); shapes in server.ModelDoc
  filings: unknown[]
  proposals: unknown[]
  notes: Record<string, unknown>
}
/** A reported year whose metric sits far from the company's own median (model.detect_oneoffs). */
export interface OneOff { year: string; metric: string; value: number; typical: number; note: string }
export interface Parsed {
  company: Company
  years: string[]
  ratios: Row[]
  defaults: Record<string, number>
  checks: string[]
  oneoffs: OneOff[]
  ttm?: Ttm | null // null: no quarters, or the last four aren't consecutive
  ttm_prev?: Ttm | null // the four quarters a year earlier, for TTM growth
  restated?: Restated | null // only on a fresh upload; null when no model of this company is saved
  valuation: ValInputs // defaults for a new document
  drivers: Driver[]
  layout: LayoutLine[]
}
/** One saved version in the local library (GET /api/models). */
export interface ModelSummary {
  id: string; company: string; active: Scenario; n: number; saved_at: string | null
  year: string; revenue: number | null // final projected year, active scenario
}
/** GET /api/models/{id}: the document plus what the dashboard derives from the company. */
export interface Opened { id?: string; doc?: ModelDoc; parsed: Parsed }
export interface Projection { years: string[]; scenarios: Record<Scenario, Row[]>; valuation: Valuation }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = typeof body?.detail === 'string' ? body.detail : `Server error (${res.status}). Try again.`
    throw new Error(detail)
  }
  return res.json()
}

export const postJson = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
})

/** saved_at (the machine's local time) as "15 Oct 2026". */
export const when = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
/** "12:41" today, else "14 Oct 12:41". */
export function clock(iso: string): string {
  const d = new Date(iso)
  const t = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === new Date().toDateString() ? t : `${d.getDate()} ${d.toLocaleDateString('en-IN', { month: 'short' })} ${t}`
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** A share price or share count to 2 decimals, Indian grouping. */
export const dec2 = (v: number) => inr2.format(v)

/** Rs crore, Indian digit grouping, accounting-style negatives. */
export function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '–'
  const r = Math.round(v)
  if (r === 0) return '0'
  const s = inr.format(Math.abs(r))
  return r < 0 ? `(${s})` : s
}

export function fmt(v: number | null | undefined, kind: LineKind): string {
  if (v == null || !Number.isFinite(v)) return '–'
  if (kind === 'x') return `${noNegZero(v.toFixed(1))}x`
  if (kind === 'pct') return `${noNegZero((v * 100).toFixed(1))}%`
  if (kind === 'days') return `${Math.round(v)}`
  return money(v)
}

/** "FY2027E" -> "FY27E" for tight axes */
export const shortYear = (y: string) => y.replace(/^FY\d\d(\d\d)/, 'FY$1')

/** "-0.0" -> "0.0": tiny negatives shouldn't show a sign */
export const noNegZero = (s: string) => (/^-0(\.0+)?$/.test(s) ? s.slice(1) : s)

/** Arrow/Home/End keys for a role="tablist" or radio-like group with roving tabindex. */
export function groupKeys<T>(e: KeyboardEvent<HTMLElement>, ids: T[], cur: T, select: (t: T) => void) {
  const i = ids.indexOf(cur)
  const step: Record<string, number> = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: ids.length - 1 }
  if (!(e.key in step)) return
  e.preventDefault()
  const j = (step[e.key] + ids.length) % ids.length
  select(ids[j])
  ;(e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus()
}
