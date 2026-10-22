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
/** The rule defaults as paths: flat, except a fast grower's growth and capex, which fade to `ends` (model.default_ends). */
export const defaultPaths = (d: Record<string, number>, ends?: Record<string, number>): Paths =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { start: v, end: ends?.[k] ?? null }]))

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

/** Bull and bear no longer sit at base ± the seed shifts (base was edited after them, or they were edited). */
export const drifted = (s: Scenarios) => {
  const next = seed(s.base)
  return (['bull', 'bear'] as const).some(k => JSON.stringify(s[k]) !== JSON.stringify(next[k]))
}
/** Bull and bear again from base (after a confirm when they hold edits); they take base's sources too. */
export function copyBase(setDoc: (f: (d: ModelDoc) => ModelDoc) => void, scenarios: Scenarios) {
  if (drifted(scenarios) && !window.confirm('Replace your bull and bear assumptions with base ± 3 pp growth and ± 1.5 pp EBITDA margin?')) return
  setDoc(d => ({ ...d, scenarios: seed(d.scenarios.base),
    assumption_sources: { ...d.assumption_sources, bull: { ...d.assumption_sources.base }, bear: { ...d.assumption_sources.base } } }))
}
/** The scenario names, as on the Excel sheets. */
export const NAMES: Record<Scenario, string> = { base: 'Base', bull: 'Bull', bear: 'Bear' }

/** Share price (Rs) and count (crore) from the export; null when the export left them out. */
export interface Market { price: number | null; shares: number | null; price_hist: (number | null)[]; shares_hist: (number | null)[]; face_value?: number | null }
/** The export's Quarters block (model.QUARTERS keys: sales, op_profit, net_profit, ...), null where the export left a gap. */
export interface Quarters { dates: string[]; rows: Record<string, (number | null)[]> }
/** A document NSE lists for the company (5.1): a call transcript, presentation or annual report, linked, not kept. */
export interface SourceDoc { date: string | null; kind: DocKind; title: string; url: string }
/** Where a company added by ticker came from (server.fetch_company): words and dates only, no number reads it. */
export interface Source {
  symbol: string; exchange: 'NSE' | 'BSE'; bse_code?: string; basis: 'consolidated' | 'standalone'; industry?: string | null
  fetched_at: string; price_at: string | null
  years: Record<string, string> // FY2024 -> "NSE filing" | "Excel export" | "Excel export (restated)" (your one-click choice)
  missing: string[] // "FY2019 to FY2022: why"
  from: string | null // who filled the years filings lack: "your Excel export", "this model"...
  mismatches: { year: string; line: string; filing: number; export: number }[] // over 1%, on years both have
  notes: string[]; documents: SourceDoc[]
  // years a later filing restated (model.merge): both numbers, and whether you switched to the restated one
  restated?: { year: string; line: string; filed: number; restated: number; used: boolean }[]
}
export interface Company { name: string; dates: string[]; hist: Row[]; market?: Market; quarters?: Quarters | null; source?: Source | null; pl_only?: PlYear[] | null }
/** An older year whose filing has a P&L but no balance sheet (model.pl_only): Statements and the revenue track record only. */
export type PlYear = Row & { year: string; end: string }
/** Trailing twelve months (model.ttm): the four quarters ending `end`, each row summed (null if one is missing). */
export interface Ttm { end: string; values: Row }
/** A reported figure that moved > 0.5% against the latest saved model of this company (server.restatements). */
export interface Restated {
  id: string; saved_at: string | null; changes: { year: string; line: string; old: number; new: number }[]
  // the saved model's filings (read again against this file), proposals, notes and reports, carried into the new one
  carry?: { filings: Filing[]; proposals: Proposal[]; notes: Record<string, unknown>; reports: Report[] }
}
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
  error: string | null // this scenario only: a negative final-year FCFF, or shares worth nothing; the WACC error is global
  /** Set when the last forecast year burns cash: the last-year capex (at most) or operating margin (at least) that
   * stops the burn, null where none would. */
  fix?: { capex_pct: number | null; ebitda_margin: number | null } | null
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
  borrowings: number // incl. lease liabilities
  lease?: number; cash: number; investments: number; scenarios: Record<Scenario, ScenarioValue>
  /** Each reported year end's multiples (year-end price), with their median, low and high. Missing on an old server. */
  multiples?: { hist: Record<Multiple, (number | null)[]>; median: Multiples; min: Multiples; max: Multiples }
  /** The research note's numbers for the base case (model.valuation note=True); null with a WACC error. */
  note?: NoteNumbers | null
  /** Missing on a server not yet restarted after an update; the panel then hides the grids. */
  steps?: { wacc: number[]; g: number[]; growth: number[]; margin: number[]; implied?: [number, number] }
}
/** One driver moved down / up one step, others at base (model.drivers_impact): value per share either way. */
export interface Impact { key: string; label: string; step: number; down: number | null; up: number | null; swing: number | null }
/** The flat level of a driver at which base value = price (model.breakevens); value null = none in range. */
export interface BreakEven { value: number | null; range: [number, number] | null }
export interface NoteNumbers {
  impact: Impact[]
  breakevens: Partial<Record<'growth' | 'ebitda_margin' | 'wacc' | 'g', BreakEven>> // empty without a price
  growth_scale: [number, number | null][] // flat revenue growth -> value per share, other inputs at base
}
/** A cell of the note's rule-check strip (model.rule_checks); severity as on the forensic radar. */
export interface RuleCheck { id: string; name: string; status: 'red' | 'amber' | 'clear' | 'filing'; severity?: Severity; fact: string; rule: string }
export type Severity = 'high' | 'medium' | 'low' | 'ok' | 'not_checked'
/** One forensic rule (model.forensic): rules only; `needs` = a filing that would let it run. */
export interface Forensic {
  key: string; title: string; severity: Severity; value: number | null; threshold: number | null; years: string[]
  fact: string; detail: string; rule: string; needs: string | null
  parts?: Record<string, number> // the M-score's eight ratios
  approx?: string[] // ... and how each one the export lacks is approximated
}
/** An approved explanation of a forensic flag, doc.flag_notes: words only, AI-written, cited or from the numbers. */
export interface FlagNote {
  key: string; year: string; proposal: string; summary: string; file: string | null; page: number | null
  quote: string | null; from_numbers: boolean; ai: true
}
/** A measure's last reported year against the median of the three years before (model.key_numbers). */
export interface KeyNumber { key: string; label: string; kind: 'pct' | 'x' | 'days'; year: string; last: number | null; typical: number | null }
export interface Cagr { from: string; to: string; value: number }
/** A rule check on a filing or proposal; pass null = a note (nothing to compare with). */
export interface Check { name: string; pass: boolean | null; detail: string }
/** An attached XBRL results filing (model.parse_xbrl via POST /api/xbrl), facts in Rs crore (EPS in Rs). */
export interface Filing {
  id: string; file: string; kind: 'quarter' | 'half' | 'annual' | 'other'; company: string | null
  period_start: string | null; period_end: string | null; consolidated: boolean | null
  facts: Record<string, number>; unmapped: { tag: string; value: number; unit?: string; context: string }[]; checks: Check[]
}
/** Something read by AI that could change a number: shown with its source and checks, used only once approved. */
export interface Proposal {
  id: string; kind: 'mapping' | 'oneoff_note' | 'ar_note' | 'flag_note' | 'assumption'; field: string; value: unknown; unit: string | null
  period: string | null; source: { file: string | null; page?: number | null; quote?: string | null; tag?: string | null }
  reasoning: string; checks: Check[]; status: 'proposed' | 'approved' | 'rejected'; ai: boolean
  filing?: string // a mapping: the id of the filing whose unmapped tag it maps
  report?: string | null // a one-off or annual-report note: the report it was read from (null: from the numbers only)
  from_numbers?: boolean
  pages?: number[] // an annual-report note: the PDF pages rules picked and sent
  reply?: unknown // an annual-report note or assumption: the model's reply as given, re-checked by rules on approval
  from_history?: boolean // an assumption the documents don't speak to: the rule default, no AI number
  outside?: string | null // an assumption outside the company's history: the reason given (checked against the quote)
  round?: string // an assumption: when its draft was made; the review table shows the latest round
}
/** proposal.value of a drafted assumption: a {start, end} path per scenario, in the engine's units. */
export type Drafted = Record<Scenario, Path>
/** Where each scenario's driver came from: an accepted proposal's id, "history" (the rule default) or "manual". */
export type AssumptionSources = Partial<Record<Scenario, Record<string, string>>>
/** One value of an annual-report note, in Rs crore (converted by rules), with where it was read. */
export interface ArRow { label: string; amount: number | null; raw: unknown; page: number; quote: string; unit?: string } // unit: operating numbers, as printed
/** An annual-report note's value (proposal.value for kind ar_note): rows, their sum, and what it's compared with. */
export interface ArValue {
  rows: ArRow[]; total: number; against: { label: string; value: number } | null
  // the auditor topic: words checked against the quotes (rows carry the quotes, amounts null)
  auditor?: string; opinion?: 'unmodified' | 'qualified' | 'adverse' | 'disclaimer'; changed?: boolean
}
/** An approved annual-report note, notes[`ar:${topic}:${year}`]. AI-read, rule-checked, approved by you. */
export interface ArNote extends ArValue { proposal: string; topic: string; year: string; file: string | null; ai: true }
/** POST /api/notes/plan: the pages rules pick per topic and the exact prompt size, before anything is sent. */
export interface NotesPlan { topics: Record<string, { title: string; pages: number[]; chars: number }>; chars: number }
/** An attached PDF (POST /api/report); its page text stays on the server. Notes, one-offs and flags read only annual
 * reports; transcripts and presentations are read to draft assumptions (4.2). Missing kind = annual (saved before 4.2). */
export type DocKind = 'annual' | 'transcript' | 'presentation'
export interface Report { id: string; file: string; year: string; pages: number; kind?: DocKind }
export const DOC_KINDS: Record<DocKind, string> = { annual: 'Annual report', transcript: 'Earnings-call transcript', presentation: 'Investor presentation' }
export const isAnnual = (r: Report) => (r.kind ?? 'annual') === 'annual'
/** An approved one-off explanation, notes[`oneoff:${year}`]: words only, AI-written, never a number. */
export interface OneOffNote {
  proposal: string; summary: string; file: string | null; page: number | null; quote: string | null
  from_numbers: boolean; ai: true
}
/** POST /api/mappings/approve | reject: the decided proposal and the filings re-read by rules with mappings.json. */
export interface Decided { proposal: Proposal; filings: Filing[]; missing: string[] }
/** A company rules found on NSE as a possible peer (server.peer_candidates): same sector, close in size; or one you added. */
export interface PeerCandidate {
  symbol: string; name: string; why: string; sector?: string; industry?: string | null; basic_industry?: string | null
  price?: number | null; shares?: number | null; mcap?: number | null; size?: number | null; hand?: boolean
}
/** One AI pick with the rule checks it passed or failed (ai.peer_checks). */
export interface PeerPick { symbol: string; name: string; reason: string; basis: string; checks: Check[]; pass: boolean }
/** POST /api/peers/pick: the AI's picks as a proposal; nothing is used until you approve the set. */
export interface PeerProposal { id: string; kind: 'peers'; picks: PeerPick[]; checks: Check[]; basis: 'segments' | 'classification'; made_at: string; ai: true }
/** One peer's measures (model.peer_metrics) as rules read them when you compared, or why they couldn't be read. */
export interface PeerRow {
  symbol: string | null; name: string; year?: string | null; price?: number | null; at?: string | null; source?: string | null
  metrics?: Record<string, number | null> | null; error?: string | null
}
/** doc.peers (5.2): candidates, the AI's proposal, the set you approved and each peer's numbers. */
export interface PeersDoc {
  symbol: string | null; candidates: PeerCandidate[]; proposal: PeerProposal | null; chosen: string[]
  approved_at: string | null; rows: PeerRow[]
}
/** /api/project's peers (model.peer_table): the company against its peers at this model's price; ranks 1 = best. */
export interface PeerTable {
  own: PeerRow; peers: PeerRow[]; median: Record<string, number | null>; rank: Record<string, number | null>
  of: Record<string, number>; columns: [key: string, label: string, kind: 'num' | 'pct' | 'x', way: 1 | -1][]
}
/** What the client holds and saves. The API takes it as is (it ignores excluded_years and saved_at). */
export interface ModelDoc {
  version: 6
  company: Company
  n: number
  active: Scenario
  scenarios: Scenarios
  excluded_years: string[]
  saved_at: string | null
  valuation: ValInputs
  // Phase 3 blocks (sources, AI proposals, approved notes); shapes in server.ModelDoc
  filings: Filing[]
  proposals: Proposal[]
  notes: Record<string, unknown>
  reports: Report[]
  // Phase 4 blocks (version 6): written by 4.2-4.4
  note: ThesisNote | null // 4.4: the note's words, AI-written and checked by rules

  assumption_sources: AssumptionSources // 4.2
  flag_notes: FlagNote[] // 4.3: approved explanations of forensic flags
  reviewed_at: string | null // "Mark as reviewed"; cleared when the model changes
  peers?: PeersDoc | null // 5.2, optional: documents saved before it have none
  track?: TrackRecord[] // 5.3, optional: the base forecast as it stood each time new annual results came in
}
/** server.track_record: what the base case said before new results replaced the company (rules only). */
export interface TrackRecord {
  last: string; dates: string[]; years: string[]; drivers: Record<string, number[]>; lines: Record<string, (number | null)[]>
  made_at: string | null; recorded_at: string; new_years: string[]; values: Record<Scenario, number | null>
  price: number | null; implied: number | null; growth: number; flags: { id: string; name: string }[]; note: boolean; kept: string[]
}
export interface TrackDriver { key: string; label: string; forecast: number; actual: number; diff: number; err: number | null; hit: boolean; tol: number }
export interface TrackLine { key: string; label: string; forecast: number; actual: number; err: number | null }
export interface TrackProposal { key: string; label: string; year: string; forecast: number; actual: number; current: number; proposed: number | null; unusual?: true } // proposed null: an unusual year, nothing proposed
/** /api/project's tracking: each saved forecast against the years now reported, the hit rate per input, the rules
 * proposals the latest results raise, and the value range etc. before (was) and now. */
export interface Tracking {
  records: { last: string; made_at: string | null; years: { year: string; drivers: TrackDriver[]; lines: TrackLine[] }[] }[]
  hit_rate: { key: string; label: string; hits: number; scored: number }[]
  proposals: TrackProposal[]
  was: Pick<TrackRecord, 'last' | 'made_at' | 'recorded_at' | 'new_years' | 'values' | 'price' | 'implied' | 'flags' | 'note'>
  now: { values: Record<Scenario, number | null>; price: number | null; implied: number | null; flags: { id: string; name: string }[] }
}
/** model.quarter_track: the quarters filed in the first forecast year against the base case's run-rate for it. */
export type QStatus = 'ahead' | 'in_line' | 'behind'
export interface QuarterLine { key: 'revenue' | 'ebitda_margin' | 'pat'; label: string; ytd: number | null; need: number | null; fy: number | null
  gap: number | null; yoy: number | null; fy_growth: number | null; status: QStatus | null }
export interface QuarterTrack { year: string; through: string; quarter: string; period: string; quarters: number
  basis: 'seasonal' | 'straight'; lines: QuarterLine[]; status: QStatus | null }
/** What a sentence of the note rests on: a computed fact's key, a citation id ("C1"), or a quote the model gave. */
export type NoteRef = string | { file: string; page: number; quote: string }
/** An approved quote the note writer was given (server._thesis_facts): what it backs, where it is. */
export interface Cited { what: string; file: string; page: number; quote: string; report: string | null }
/** POST /api/note/write: the note's words with the facts and quotes they were written from. Words only: nothing reads
 * them back into a number. inputs_hash against /api/project's tells when the inputs have moved since (stale). */
export interface ThesisNote {
  headline: string; thesis: { head: string; text: string; refs: NoteRef[] }[]; priced_in: string
  risks: { text: string; refs: NoteRef[] }[]; bull_trigger: string; bear_trigger: string; what_to_watch: string[]
  facts: Record<string, string>; cites: Record<string, Cited>; checks: Check[]; rounds: number
  status: 'written' | 'rejected'; inputs_hash: string; written_at: string; ai: true
}
/** A reported year whose metric sits far from the company's own median (model.detect_oneoffs). */
export interface OneOff { year: string; metric: string; value: number; typical: number; note: string }
/** Where the upgraded drivers' history comes from (model.upgrade): attached annual filings, else the export. */
export interface Sources {
  basis: 'cogs' | 'revenue' // inventory and payable days run on this
  drivers: Record<string, string> // driver key (and 'lease') -> a short sentence, e.g. "Trade payables from XBRL FY2024, on COGS"
  notes: string[] // filings that weren't used, and why
  used: Record<'payables' | 'lease' | 'capex', string[]> & { capex_ar?: string[] } // year labels; capex_ar: approved annual-report capex
  // a business that left the group, taken out of the last reported year before growth (yours or an approved note)
  // assets_out / debt_out: its net block and borrowings, taken out of the opening balance sheet (net assets leave reserves)
  moved_out?: { revenue_out: number; ebitda_out: number; assets_out?: number; debt_out?: number; year: string; reason: string; from: 'you' | 'annual report' }
}
/** notes['adj:moved_out']: a business sold or moved to a JV, typed by you with a reason (wins over an approved note). */
export interface MovedOut { year: string; revenue: number; ebitda: number | null; assets?: number | null; debt?: number | null; reason: string }
export interface Parsed {
  company: Company
  hist?: Row[] // company.hist with the filings' payables, leases and cash-flow capex (missing on an old server)
  sources?: Sources
  years: string[]
  ratios: Row[]
  defaults: Record<string, number>
  default_ends?: Record<string, number> // a fast grower's fades (growth, capex end values); {} otherwise
  checks: string[]
  share_gap?: { gap: number; now: number; then: number; text: string } | null // shares up since the last balance sheet
  oneoffs: OneOff[]
  ttm?: Ttm | null // null: no quarters, or the last four aren't consecutive
  ttm_prev?: Ttm | null // the four quarters a year earlier, for TTM growth
  restated?: Restated | null // only on a fresh upload; null when no model of this company is saved
  fetched?: { filings: Filing[] } // added by ticker: the annual results filings its years were read from
  rule_checks?: RuleCheck[] // red, amber, clear, then needs-a-filing (missing on an old server)
  forensic?: Forensic[] // the full radar, fixed order (missing on an old server)
  key_numbers?: KeyNumber[]
  cagrs?: Record<'3' | '5', Cagr[]> // every rolling 3- and 5-year revenue CAGR
  valuation: ValInputs // defaults for a new document
  drivers: Driver[]
  layout: LayoutLine[]
}
/** One saved version in the local library (GET /api/models). */
export interface ModelSummary {
  id: string; company: string; active: Scenario; n: number; saved_at: string | null
  year: string; revenue: number | null // final projected year, active scenario
  // the coverage row (server._coverage); missing on an old server
  price?: number | null; values?: Record<Scenario, number | null>; implied?: number | null; growth?: number
  why?: string | null; flags?: number; reviewed_at?: string | null
  symbol?: string | null // NSE symbol when it was added by ticker
  new_results?: string[] | null // 5.3: years reported since you last marked it reviewed
  // 5.4: price is today's NSE price from the cache when there is one (values recomputed at it), price_saved the model's own
  price_saved?: number | null; price_at?: string | null; price_live?: boolean; results_to?: string
  // quarters filed this year against the base case's run-rate: gaps by line (revenue, PAT a share; margin in pp)
  quarter?: (Pick<QuarterTrack, 'year' | 'quarter' | 'period' | 'status'> & Record<QuarterLine['key'], number | null>) | null
}
/** GET /api/auto: the scheduled checks (prices and new results, once a day while the app runs) and their last run. */
export interface AutoState {
  enabled: boolean; running: boolean; next_at: string | null
  last: { started_at: string; done_at: string; prices: { checked: number | null; missed: number | null; stopped: boolean | null }
    new: { id: string; company: string; saved_at: string; text: string }[]; failed: number } | null
}
/** GET /api/watch: tickers watched without a model, and the daily [date, price, bear, base, bull] per company slug. */
export interface Watched { symbol: string; name: string; added_at: string; price: number | null; at: string | null; industry: string | null }
export interface WatchList { watch: Watched[]; history: Record<string, [string, number, number | null, number, number | null][]> }
/** GET /api/models/{id}: the document plus what the dashboard derives from the company. */
export interface Opened { id?: string; doc?: ModelDoc; parsed: Parsed }
export interface Projection {
  years: string[]; scenarios: Record<Scenario, Row[]>; valuation: Valuation
  inputs_hash?: string // what the numbers come from (server.inputs_hash); a note with another hash is stale
  peers?: PeerTable | null // null until peers are compared
  tracking?: Tracking | null // null until new results have come in after a forecast
  quarter?: QuarterTrack | null // null until a quarter of the first forecast year is filed
}

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

/** Rs per share: whole rupees from 100 up, paise below (a Rs 12 stock needs them). */
export const rs = (v: number) => (Math.abs(v) >= 100 ? money(v) : dec2(v))
/** A share as a percentage, one decimal: 0.1663 -> "16.6%". */
export const pc = (v: number | null | undefined) => fmt(v, 'pct')

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
  if (kind === 'x') return `${noNegZero(v.toFixed(1)).replace('-', '−')}x` // a typographic minus, as in the text
  if (kind === 'pct') return `${noNegZero((v * 100).toFixed(1)).replace('-', '−')}%`
  if (kind === 'days') return `${Math.round(v)}`
  return money(v)
}

/** Broker year notation, anywhere in a string: "FY2027E" -> "FY27E", "FY2018–23" -> "FY18–23". Display only: the engine's
 * labels stay long (Excel parity, document keys). */
export const fy = (y: string) => y.replace(/\bFY20(\d\d)/g, 'FY$1')
/** A quarter-end date as an Indian fiscal quarter: "2026-09-30" -> "Q2FY27" (April–March year). */
export const qfy = (iso: string) => {
  const d = new Date(iso), m = d.getMonth()
  return `Q${[4, 4, 4, 1, 1, 1, 2, 2, 2, 3, 3, 3][m]}FY${String((m > 2 ? d.getFullYear() + 1 : d.getFullYear()) % 100).padStart(2, '0')}`
}

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

/** Fair value against CMP, one way everywhere: value / price - 1, "79% upside" or "22% downside". */
export function gap(price: number | null | undefined, value: number | null | undefined): string | null {
  if (price == null || value == null || !(price > 0) || !(value > 0)) return null // zero or below is no value
  const g = value / price - 1
  return `${noNegZero((Math.abs(g) * 100).toFixed(0))}% ${g >= 0 ? 'upside' : 'downside'}`
}

/** Market cap and EV at CMP, Rs cr (EV = market cap + borrowings incl. leases − cash − investments); null without CMP or shares. */
export function capOf(v: Valuation | null | undefined): { mcap: number; ev: number } | null {
  if (!v || v.price == null || v.shares == null) return null
  const mcap = v.price * v.shares
  return { mcap, ev: mcap + v.borrowings - v.cash - v.investments }
}

export type VerdictKind = 'cheap' | 'range' | 'dear' | 'fix' | 'none'
/** Where CMP sits against the bear and bull fair values. ponytail: thresholds are bear/bull only; add a
 * margin-of-safety setting if asked. */
export function verdict(price: number | null | undefined, v: Partial<Record<Scenario, number | null>> | null | undefined): { kind: VerdictKind; word: string } {
  if (v?.base == null || v.base <= 0) return { kind: 'fix', word: 'Needs a fix' } // zero or below is no value
  if (price == null) return { kind: 'none', word: 'No price yet' }
  const bear = v.bear != null && v.bear > 0 ? v.bear : null, bull = v.bull != null && v.bull > 0 ? v.bull : null
  if (bear != null && price < bear) return { kind: 'cheap', word: 'Below bear FV' }
  if (bull != null && price > bull) return { kind: 'dear', word: 'Above bull FV' }
  // a range needs both ends: a bear or bull case without a value is a case to fix, never "within"
  if (bear == null || bull == null) return { kind: 'fix', word: 'Needs a fix' }
  return { kind: 'range', word: 'Within FV range' }
}

/** The one severity scale (engine level -> word). Unusual years and data notes are never part of it. */
export const SEV_WORD: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low', ok: 'Clear', not_checked: 'Not tested' }
/** Every red-flag count in the app comes from here. signs = high + medium + low. */
export function sevCounts(fs: Forensic[] | null | undefined) {
  const c: Record<Severity, number> = { high: 0, medium: 0, low: 0, ok: 0, not_checked: 0 }
  for (const f of fs ?? []) c[f.severity]++
  return { ...c, signs: c.high + c.medium + c.low }
}

const SMALL = new Set(['AND', 'OF', 'THE', 'FOR', 'IN'])
/** A name filed in capitals in title case ("TATA CONSUMER PRODUCTS LIMITED" -> "Tata Consumer Products Limited");
 * words of up to three letters stay as they are (JSW, TCS, ITC). Mixed-case names are left alone.
 * ponytail: on screen only, the saved name is unchanged; a four-letter acronym (NTPC) reads "Ntpc" until a list is needed */
export const properName = (n: string) => (/[a-z]/.test(n) ? n : n.replace(/[A-Z][A-Z&.'-]*/g, (w, i) =>
  SMALL.has(w) && i > 0 ? w.toLowerCase() : w === 'LTD' || w === 'LTD.' ? w[0] + w.slice(1).toLowerCase() : w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()))

/** Where a year's numbers came from, in the words the UI may show: anything not on this list reads "an Excel export", so
 * no data vendor's name can reach the screen. */
export function sourceLabel(s: string | null | undefined): string {
  const t = (s ?? '').toLowerCase()
  if (t.includes('nse')) return 'NSE filings'
  if (t.includes('bse')) return 'BSE filings'
  if (t.includes('annual report')) return 'the company’s annual report'
  return 'an Excel export'
}
