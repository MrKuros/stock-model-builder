import type { FocusEvent, ReactNode } from 'react'

/** The one glossary: every abbreviation or term the app labels with, defined once. <T k="wacc" /> prints the label
 * and shows the definition on hover (title) and on focus by tab, click or tap (CSS, .gt:focus::after). */
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
  pbt: ['PBT', 'Profit before tax'],
  cwip: ['CWIP', 'Capital work in progress: capex not yet commissioned, so not yet depreciated'],
  cfo_pat: ['CFO/PAT', 'Cash from operations ÷ PAT: cash conversion of reported profit'],
  sens: ['Sensitivity', 'Fair value per share across a grid of two inputs, others at base'],
  // lenders (banks, NBFCs)
  nii: ['NII', 'Net interest income: interest earned − interest expended'],
  nim: ['NIM', 'Net interest margin: NII ÷ average total assets (here; banks often quote it on interest-earning assets)'],
  ppop: ['PPOP', 'Pre-provision operating profit: NII + other income − operating expenses'],
  cost_income: ['Cost-to-income', 'Operating expenses ÷ net total income (NII + fee and other income)'],
  credit_cost: ['Credit cost', 'Provisions and contingencies ÷ average advances'],
  adv_growth: ['Loan growth', 'YoY growth in advances (loans)'],
  gnpa: ['GNPA', 'Gross non-performing assets: loans 90+ days overdue, before provisions; % of gross advances'],
  nnpa: ['NNPA', 'Net NPA: gross NPAs less provisions held against them'],
  pcr: ['PCR', 'Provision coverage ratio: 1 − NNPA ÷ GNPA'],
  roa: ['RoA', 'Return on assets: PAT ÷ average total assets'],
  roe_l: ['RoE', 'Return on equity: PAT ÷ average net worth'],
  cet1: ['CET1', 'Common equity tier 1 ratio: core equity capital ÷ risk-weighted assets (RBI minimum 8% incl. buffer)'],
  rwa: ['RWA', 'Risk-weighted assets: assets weighted by credit, market and operational risk'],
  bvps: ['BVPS', 'Book value per share: net worth ÷ shares'],
  abv: ['ABV', 'Adjusted book value: net worth − net NPAs, per share'],
  pabv: ['P/ABV', 'Price ÷ adjusted book value per share'],
  ri: ['RI', 'Residual income: PAT − Ke × opening book; value = book + PV of residual income'],
  jpb: ['Justified P/B', '(RoE − g) ÷ (Ke − g): the P/B a steady RoE earns at cost of equity Ke and growth g'],
  implied_roe: ['Implied RoE', 'Steady-state RoE at which justified P/B equals P/B at CMP: g + P/B × (Ke − g)'],
  cd_ratio: ['CD ratio', 'Credit-deposit ratio: advances ÷ deposits'],
  cof: ['Cost of funds', 'Interest expended ÷ average deposits and borrowings'],
  yld: ['Yield', 'Interest earned ÷ average total assets'],
  // portfolio
  mv: ['Market value', 'Quantity × CMP'],
  weight: ['Weight', 'Holding’s market value ÷ portfolio market value (holdings with a CMP)'],
  upnl: ['P&L', 'Unrealised: market value − quantity × average cost'],
  lookthrough: ['Look-through', 'Weighted harmonic mean: Σ weight ÷ Σ (weight ÷ multiple), i.e. total market value ÷ the held share of each company’s earnings (or EBITDA, book); negative denominators left out'],
  top5: ['Top-5 weight', 'Combined weight of the five largest holdings'],
  hhi: ['HHI', 'Herfindahl–Hirschman index: Σ weight² × 10,000; 10,000 = one holding, 1,000 = ten equal holdings'],
  eff_n: ['Effective N', 'Effective number of holdings: 10,000 ÷ HHI (equal-weight equivalent)'],
  sector: ['Sector', 'NSE’s sector classification for the company'],
} as const satisfies Record<string, readonly [string, string]>
export type TermKey = keyof typeof GLOSSARY

/** The definition of a term, for a title="" elsewhere. */
export const def = (k: TermKey) => GLOSSARY[k][1]

/** A term in the right half of the screen opens its definition leftwards, so the box stays on screen. */
export const edge = (e: FocusEvent<HTMLElement>) =>
  e.currentTarget.toggleAttribute('data-end', e.currentTarget.getBoundingClientRect().left > window.innerWidth / 2)

/** A labelled term: the standard abbreviation, its definition on hover and on focus. */
export function T({ k, children }: { k: TermKey; children?: ReactNode }) {
  const d = GLOSSARY[k][1]
  return <abbr className="gt" title={d} data-def={d} tabIndex={0} onFocus={edge}>{children ?? GLOSSARY[k][0]}</abbr>
}
