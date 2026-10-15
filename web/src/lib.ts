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

export interface Company { name: string; dates: string[]; hist: Row[] }
/** What the client holds and saves. The API takes it as is (it ignores excluded_years and saved_at). */
export interface ModelDoc {
  version: 3
  company: Company
  n: number
  active: Scenario
  scenarios: Scenarios
  excluded_years: string[]
  saved_at: string | null
}
export interface Parsed {
  company: Company
  years: string[]
  ratios: Row[]
  defaults: Record<string, number>
  checks: string[]
  drivers: Driver[]
  layout: LayoutLine[]
}
export interface Projection { years: string[]; scenarios: Record<Scenario, Row[]> }

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

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

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
