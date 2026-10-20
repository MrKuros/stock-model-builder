import type { ReactNode } from 'react'

/** The one glossary: every abbreviation or term the app labels with, defined once. <T k="wacc" /> prints the label
 * and shows the definition on hover (title) and on keyboard focus (CSS, .gt:focus-visible::after). */
export const GLOSSARY = {
  cmp: ['CMP', 'Current market price per share (NSE last traded, or the price you typed)'],
  fv: ['FV', 'Fair value per share: DCF equity value ÷ shares outstanding'],
  fair_value: ['Fair value', 'DCF equity value per share: PV of FCFF + PV of terminal value − net debt − minorities, ÷ shares'],
  bear: ['Bear', 'Base case with revenue growth −3 pp and EBITDA margin −1.5 pp (unless edited)'],
  base: ['Base', 'The central forecast: rule defaults from history, plus your edits'],
  bull: ['Bull', 'Base case with revenue growth +3 pp and EBITDA margin +1.5 pp (unless edited)'],
  updown: ['Upside/(downside)', 'Fair value ÷ CMP − 1'],
  mcap: ['Market cap', 'CMP × shares outstanding'],
  ev: ['EV', 'Enterprise value: market cap + debt (incl. leases) − cash − investments; in the DCF, PV of FCFF + PV of TV'],
  net_debt: ['Net debt/(cash)', 'Borrowings incl. lease liabilities − cash − investments'],
  wacc: ['WACC', 'Weighted average cost of capital: cost of equity and post-tax cost of debt weighted by market values; the FCFF discount rate'],
  ke: ['Ke', 'Cost of equity (CAPM): risk-free rate + beta × equity risk premium'],
  kd: ['Kd', 'Pre-tax cost of debt'],
  rf: ['Rf', 'Risk-free rate: 10-year G-sec yield'],
  erp: ['ERP', 'Equity risk premium over the risk-free rate'],
  beta: ['Beta', 'Sensitivity of the stock to the market; 1.0 = market (default, not regressed)'],
  tg: ['TG', 'Terminal growth: FCFF growth a year in perpetuity after the explicit forecast (Gordon growth)'],
  tv: ['TV', 'Terminal value: final-year FCFF × (1 + g) ÷ (WACC − g)'],
  tv_share: ['TV share', 'PV of terminal value as a share of EV'],
  fcff: ['FCFF', 'Free cash flow to firm: EBIT × (1 − tax) + D&A − capex − Δ working capital'],
  dcf: ['DCF', 'Discounted cash flow: FCFF over the forecast plus terminal value, discounted at WACC'],
  rdcf: ['Reverse DCF', 'Solves for the flat revenue growth (others at base) at which DCF fair value equals CMP'],
  implied: ['Implied growth', 'Flat revenue growth a year at which base-case fair value equals CMP'],
  growth: ['Revenue growth', 'YoY growth in revenue from operations'],
  ebitda: ['EBITDA', 'Earnings before interest, tax, depreciation and amortisation (operating profit)'],
  ebitda_margin: ['EBITDA margin', 'EBITDA ÷ revenue'],
  pat: ['PAT', 'Profit after tax'],
  eps: ['EPS', 'Earnings per share: PAT attributable to owners ÷ shares'],
  capex: ['Capex % of sales', 'Capital expenditure ÷ revenue'],
  wc: ['Working-capital days', 'Debtor + inventory − creditor days'],
  dso: ['Debtor days', 'Trade receivables ÷ revenue × 365'],
  dio: ['Inventory days', 'Inventory ÷ COGS (or revenue) × 365'],
  dpo: ['Creditor days', 'Trade payables ÷ COGS (or revenue) × 365'],
  roce: ['ROCE', 'Return on capital employed: EBIT ÷ average capital employed (equity + debt)'],
  roe: ['ROE', 'Return on equity: PAT ÷ average shareholders’ equity'],
  pe: ['P/E', 'Price ÷ EPS, or market cap ÷ PAT'],
  ev_ebitda: ['EV/EBITDA', 'Enterprise value ÷ EBITDA'],
  pb: ['P/B', 'Price ÷ book value per share'],
  cagr: ['CAGR', 'Compound annual growth rate'],
  yoy: ['YoY', 'Year on year'],
  ttm: ['TTM', 'Trailing twelve months: the last four reported quarters'],
  pp: ['pp', 'Percentage points'],
  bps: ['bps', 'Basis points: 100 bps = 1 pp'],
  cr: ['Rs cr', 'Rupees crore: 1 crore = 10 million'],
  mscore: ['Beneish M-score', 'Eight-ratio earnings-manipulation score; above −1.78 is a red flag'],
  cfo_pat: ['CFO/PAT', 'Cash from operations ÷ PAT: cash conversion of reported profit'],
  sens: ['Sensitivity', 'Fair value per share across a grid of two inputs, others at base'],
} as const satisfies Record<string, readonly [string, string]>
export type TermKey = keyof typeof GLOSSARY

/** The definition of a term, for a title="" elsewhere. */
export const def = (k: TermKey) => GLOSSARY[k][1]

/** A labelled term: the standard abbreviation, its definition on hover and on focus. */
export function T({ k, children }: { k: TermKey; children?: ReactNode }) {
  const d = GLOSSARY[k][1]
  return <abbr className="gt" title={d} data-def={d} tabIndex={0}>{children ?? GLOSSARY[k][0]}</abbr>
}
