import type { ReactNode } from 'react'
import { Explain, FlagExplain, useAi } from './Sources'
import type { Upgrade } from './Model'
import { More, Next, PageHead, Sev } from './Shell'
import { useHref } from './route'
import { T } from './Term'
import {
  SEV_WORD, fmt, isAnnual, properName, sevCounts, fy, type Forensic, type ModelDoc, type OneOff, type OneOffNote, type Parsed, type Proposal,
  type Row, type Severity,
} from './lib'

const ORDER: Severity[] = ['high', 'medium', 'low', 'ok', 'not_checked']
/** The radar in reading order: worst first, then passed, then what couldn't run. */
export const bySeverity = (fs: Forensic[]) => [...fs].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
const cap = (t: string) => t[0].toUpperCase() + t.slice(1)
const lit = (f: Forensic) => f.severity === 'high' || f.severity === 'medium' || f.severity === 'low'

/** The checks in one line: "15 checks: 0 high, 0 medium, 2 low, 9 clear, 4 not tested (need AR)." From sevCounts only,
 * like every count in the app. */
export function riskWords(fs: Forensic[] | null | undefined): string {
  const c = sevCounts(fs)
  if (!fs?.length) return 'Forensic checks haven’t run on this model yet.'
  // the annual report unlocks only the checks that need it; the rest wait for more years
  const ar = fs.filter(f => f.severity === 'not_checked' && f.needs).length, short = c.not_checked - ar
  const why = [ar ? `${ar} need AR` : '', short ? `${short} short history` : ''].filter(Boolean)
  const nt = c.not_checked ? `, ${c.not_checked} not tested (${why.length > 1 ? why.join(', ') : why[0].replace(/^\d+ /, '')})` : ''
  return `${fs.length} checks: ${c.high} high, ${c.medium} medium, ${c.low} low, ${c.ok} clear${nt}.`
}

/** Each rule: its title when flagged, why it matters, and its name in the passed list. */
const PLAIN: Record<string, { title: string; why: string; gloss: string }> = {
  cash: { title: 'Weak cash conversion (3-yr)', why: 'Profit not converting into CFO can reflect aggressive revenue or cost recognition.', gloss: 'CFO/PAT, 3 years' },
  cash5: { title: 'Weak cash conversion (5-yr)', why: 'Profit not converting into CFO can reflect aggressive revenue or cost recognition.', gloss: 'CFO/PAT, 5 years' },
  dso: { title: 'Debtor days rising', why: 'Receivables growing faster than revenue can mean channel stuffing or weaker collections.', gloss: 'Debtor days' },
  dio: { title: 'Inventory days rising', why: 'Inventory build-up ties up working capital and risks write-downs.', gloss: 'Inventory days' },
  cwip: { title: 'High CWIP vs net block', why: 'Capex parked in CWIP isn’t depreciated, which can flatter EBIT.', gloss: 'CWIP ÷ net block' },
  other_income: { title: 'Other income high vs PBT', why: 'Non-operating income (treasury, one-offs) can drive PBT without the core business.', gloss: 'Other income ÷ PBT' },
  tax: { title: 'Volatile effective tax rate', why: 'An unstable ETR makes reported PAT a weak base for forecasting.', gloss: 'Effective tax rate swing' },
  debt: { title: 'High net debt/EBITDA', why: 'High leverage leaves little headroom if EBITDA falls.', gloss: 'Net debt/EBITDA' },
  cover: { title: 'Low interest cover', why: 'Thin EBIT/interest cover raises refinancing and covenant risk.', gloss: 'Interest cover (EBIT/interest)' },
  nwc: { title: 'Working capital outgrowing revenue', why: 'Net working capital growing faster than revenue absorbs operating cash flow.', gloss: 'NWC growth vs revenue growth' },
  mscore: { title: 'Beneish M-score above threshold', why: 'The eight ratios tend to move together when earnings are manipulated.', gloss: 'Beneish M-score' },
  contingent: { title: 'Large contingent liabilities', why: 'Disputed claims off the balance sheet can still crystallise.', gloss: 'Contingent liabilities ÷ net worth' },
  related: { title: 'Large related-party transactions', why: 'RPTs can transfer value away from minority shareholders.', gloss: 'Related-party transactions' },
  pledge: { title: 'Promoter pledge', why: 'Lenders can sell pledged shares in a falling market, adding pressure on the price.', gloss: 'Promoter pledge %' },
  auditor: { title: 'Audit qualification or auditor change', why: 'A modified opinion or abrupt auditor change can signal disagreement over the accounts.', gloss: 'Auditor’s opinion and auditor change' },
  // lenders (lender.forensic)
  gnpa: { title: 'Gross NPAs rising', why: 'Bad loans build before provisions catch up, so a rising GNPA leads credit cost and capital.', gloss: 'GNPA %' },
  pcr: { title: 'Provision coverage falling', why: 'Lower coverage flatters today’s profit and leaves more of the bad book to provide for later.', gloss: 'Provision coverage (PCR)' },
  credit_cost: { title: 'Credit cost spike', why: 'Provisions jumping over their run-rate are the P&L shadow of fresh slippages.', gloss: 'Credit cost vs run-rate' },
  nim: { title: 'NIM compression', why: 'A falling NIM squeezes the main earnings line; growth then has to come from volume or fees.', gloss: 'NIM trend' },
  spread: { title: 'Yield vs cost of funds narrowing', why: 'A narrowing spread behind a steady NIM is held up by funding mix or fees, which can reverse.', gloss: 'Yield − cost of funds' },
  cd_ratio: { title: 'Loans outrunning deposits', why: 'Growth past the deposit base leans on costlier wholesale funding that runs off faster.', gloss: 'Credit-deposit ratio' },
  capital: { title: 'Thin capital', why: 'Low CET1 limits growth and invites a dilutive raise.', gloss: 'CET1 ratio' },
  oi_share: { title: 'Profit leaning on other income', why: 'Treasury gains and one-offs inside other income reverse when rates rise.', gloss: 'Other income ÷ net total income' },
}
const plain = (f: Forensic) => {
  const p = PLAIN[f.key] ?? { title: f.title, why: '', gloss: f.title }
  // the other-income rule trips on its share of PBT or on a swing off trend (exceptional items): title it by the leg that fired
  return f.key === 'other_income' && lit(f) && !(f.value != null && f.threshold != null && f.value > f.threshold)
    ? { ...p, title: 'Other income off trend (exceptionals)', why: 'Other income includes exceptional items; a swing off its median distorts reported PAT growth.' } : p
}
/** Where a rule's numbers are in the statements, and the forecast input it links to. */
const NUMBERS: Record<string, [sub: string, row: string]> = {
  cash: ['cash-flow', 'cfo'], cash5: ['cash-flow', 'cfo'], dso: ['balance-sheet', 'receivables'], dio: ['balance-sheet', 'inventory'],
  cwip: ['balance-sheet', 'cwip'], other_income: ['profit-and-loss', 'other_income'], tax: ['profit-and-loss', 'tax'],
  debt: ['balance-sheet', 'borrowings'], cover: ['ratios', 'int_cover'], nwc: ['balance-sheet', 'receivables'], mscore: ['ratios', 'roce'],
}
const L_NUMBERS: Record<string, [sub: string, row: string]> = {
  gnpa: ['ratios', 'gnpa_pct'], pcr: ['ratios', 'pcr'], credit_cost: ['ratios', 'credit_cost'], nim: ['ratios', 'nim'], spread: ['ratios', 'cof'],
  cd_ratio: ['ratios', 'cd_ratio'], capital: ['ratios', 'cet1'], oi_share: ['profit-and-loss', 'other_income'],
}
const L_INPUT: Record<string, [key: string, words: string]> = {
  credit_cost: ['credit_cost', 'credit cost'], nim: ['nim', 'NIM'], spread: ['nim', 'NIM'], capital: ['cet1_min', 'CET1 floor'],
  oi_share: ['oi_pct', 'fee and other income'], gnpa: ['credit_cost', 'credit cost'], pcr: ['credit_cost', 'credit cost'],
}
const INPUT: Record<string, [key: string, words: string]> = {
  dso: ['dso', 'debtor days'], dio: ['dio', 'inventory days'], other_income: ['oi_pct', 'other income'], tax: ['tax_rate', 'tax rate'],
}
const div = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? a / b : null)
/** The series a rule reads, one value per reported year, for its small chart (null: no chart). */
function seriesOf(key: string, hist: Row[], ratios: Row[], lender = false): { v: (number | null)[]; show: (x: number) => string } | null {
  const pct = (x: number) => fmt(x, 'pct')
  if (lender) switch (key) {
    case 'gnpa': return { v: hist.map(h => h.gnpa_pct ?? null), show: pct }
    case 'pcr': return { v: hist.map(h => h.pcr ?? null), show: pct }
    case 'capital': return { v: hist.map(h => h.cet1 ?? null), show: pct }
    case 'credit_cost': case 'nim': case 'cd_ratio': return { v: ratios.map(r => r[key] ?? null), show: pct }
    case 'spread': return { v: ratios.map(r => (r.yield != null && r.cof != null ? r.yield - r.cof : null)), show: pct }
    case 'oi_share': return { v: hist.map(h => div(h.other_income, h.total_income)), show: pct }
    default: return null
  }
  switch (key) {
    case 'dso': case 'dio': return { v: ratios.map(r => r[key] ?? null), show: x => `${Math.round(x)} days` }
    case 'cash': case 'cash5': return { v: hist.map(h => (h.pat && h.pat > 0 ? div(h.cfo, h.pat) : null)), show: x => `${x.toFixed(2)}x` }
    case 'cwip': return { v: hist.map(h => div(h.cwip, h.net_block)), show: pct }
    case 'other_income': return { v: hist.map(h => div(h.other_income, h.revenue)), show: pct }
    case 'tax': return { v: hist.map(h => div(h.tax, h.pbt)), show: pct }
    case 'debt': return { v: hist.map(h => h.nd_ebitda ?? null), show: x => `${x.toFixed(1)}x` }
    case 'cover': return { v: hist.map(h => h.int_cover ?? null), show: x => `${x.toFixed(0)}x` }
  }
  return null
}

/** Bars, one a year; the years the rule flagged in the severity's colour, the rest grey. */
function MiniBars({ years, v, show, flagged, sev, title }: { years: string[]; v: (number | null)[]; show: (x: number) => string; flagged: string[]; sev: Severity; title: string }) {
  const xs = v.filter((x): x is number => x != null && Number.isFinite(x))
  if (xs.length < 2) return null
  const hi = Math.max(0, ...xs), lo = Math.min(0, ...xs), H = 64, W = 220, bw = W / v.length
  const y = (x: number) => 4 + (1 - (x - lo) / (hi - lo || 1)) * (H - 8)
  return (
    <figure className="minibars">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} by year: ${years.map((yr, i) => `${yr} ${v[i] == null ? 'none' : show(v[i]!)}${flagged.includes(yr) ? ' (flagged)' : ''}`).join(', ')}`}>
        {v.map((x, i) => x == null ? null : <rect key={i} x={i * bw + bw * 0.15} width={bw * 0.7} y={Math.min(y(x), y(0))}
          height={Math.max(1, Math.abs(y(x) - y(0)))} className={flagged.includes(years[i]) ? `on ${sev}` : undefined} />)}
      </svg>
      <figcaption className="small dim"><span>{fy(years[0])}</span><span>{fy(years[years.length - 1])}</span></figcaption>
    </figure>
  )
}

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void
  upgrades: Upgrade[]; onApply: () => void; onKeep: () => void; onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
  toggleYear: (year: string) => void; pendingYear: string | null
}

/** Risks & forensics: the fixed rules' red flags as cards, what isn't tested and why, what's clear, and outlier
 * years (never counted as flags). AI can explain a flag; it never changes a number. */
export default function RisksPage({ parsed, doc, setDoc, upgrades, onApply, onKeep, onProposals, toggleYear, pendingYear }: Props) {
  const href = useHref()
  const ai = useAi()
  const { company, years } = parsed
  const hist = parsed.hist ?? company.hist
  const short = properName(company.name).replace(/\s+(ltd\.?|limited)$/i, '').trim()
  const flags = bySeverity(parsed.forensic ?? [])
  const c = sevCounts(parsed.forensic)
  const signs = flags.filter(lit), passed = flags.filter(f => f.severity === 'ok'), waiting = flags.filter(f => f.severity === 'not_checked')
  const annual = doc.reports.filter(isAnnual).sort((a, b) => b.year.localeCompare(a.year))
  const ar = annual[0]
  const off = !!ai && !ai.available
  const arNotes = Object.keys(doc.notes).filter(k => k.startsWith('ar:'))
  const onReports = (f: (rs: ModelDoc['reports']) => ModelDoc['reports']) => setDoc(d => ({ ...d, reports: f(d.reports) }))
  const oneoffYears = Object.entries(parsed.oneoffs.reduce<Record<string, OneOff[]>>((g, o) => ({ ...g, [o.year]: [...(g[o.year] ?? []), o] }), {}))
  const used = years.filter(y => !doc.excluded_years.includes(y)).slice(-3) // mirrors default_assumptions(years=3)
  const needAr = waiting.filter(f => f.needs)
  const lender = parsed.kind === 'lender' || company.kind === 'lender'

  // the real blocker for the checks that wait on the annual report
  const blocker: { text: ReactNode; act: ReactNode } = !ar
    ? { text: <>No annual report attached.</>, act: <a className="btn" href={href('documents', 'add')}>Attach annual report</a> }
    : off ? { text: <>{ar.year} annual report attached, but AI reading is off, so it hasn’t been read.</>,
      act: <><a className="btn" href={href('documents', 'ai')}>Enable AI reading</a> <a className="btn" href={href('documents', 'reading')}>See the report</a></> }
    : arNotes.length ? { text: <>{ar.year} annual report read; the notes these checks need weren’t found or aren’t approved yet.</>,
      act: <a className="btn" href={href('documents', 'reading')}>Review what AI read</a> }
    : { text: <>{ar.year} annual report attached, not read yet.</>, act: <a className="btn" href={href('documents', 'reading')}>Read with AI</a> }

  const card = (f: Forensic) => {
    const p = plain(f), s = seriesOf(f.key, hist, parsed.ratios, lender), num = (lender ? L_NUMBERS : NUMBERS)[f.key], inp = (lender ? L_INPUT : INPUT)[f.key]
    return (
      <li key={f.key} id={`a-${f.key}`} tabIndex={-1} className={`risk-card s-${f.severity}`} aria-labelledby={`rk-${f.key}`}>
        <div className="rk-main">
          <p className="rk-head"><Sev level={f.severity} /> <b id={`rk-${f.key}`}>{p.title}</b></p>
          <p className="rk-fact serif">{fy(f.detail)}</p>
          {p.why && <p className="rk-why"><b>Why it matters:</b> {p.why}</p>}
          <details className="rk-rule"><summary>Rule and threshold</summary>
            <p className="small">{f.rule}.{f.years.length > 0 && <> Years: {f.years.map(fy).join(', ')}.</>} Reading: <span className="num">{fy(f.fact)}</span>.</p>
            {f.parts && <MParts f={f} />}
          </details>
          <div className="rk-act">
            {num && <a className="btn" href={href('statements', num[1], num[0])}>Statement line</a>}
            {inp && <a className="btn" href={href('forecast', inp[0])}>{cap(inp[1])} in Forecast</a>}
          </div>
          {!lender && <FlagExplain flag={f} company={company} filings={doc.filings} notes={doc.notes} reports={annual}
            proposals={doc.proposals} note={doc.flag_notes.find(x => x.key === f.key)} ai={ai} onProposals={onProposals} />}
        </div>
        {s && <MiniBars years={years} v={s.v} show={s.show} flagged={f.years} sev={f.severity} title={p.title} />}
      </li>
    )
  }

  return (
    <>
      <PageHead label="Analysis" title="Risks & forensics"
        purpose={lender ? <>Fixed lender rules on {short}’s reported numbers: asset quality (<T k="gnpa" />, <T k="pcr" />), credit cost spikes,
          <T k="nim" /> and the yield–cost-of-funds spread, the <T k="cd_ratio" />, <T k="cet1" /> capital and the earnings mix; related parties
          from the annual report.</>
          : <>Fifteen fixed forensic rules on {short}’s reported financials: cash conversion (<T k="cfo_pat" />), working capital,
          <T k="cwip" />, other income vs <T k="pbt" />, leverage, <T k="mscore" />, disclosures. AI can explain a flag from the annual report;
          it never changes a number.</>}
        answer={riskWords(parsed.forensic)} />

      <nav className="sev-chips" aria-label="Forensic checks by severity">
        {(['high', 'medium', 'low', 'ok', 'not_checked'] as Severity[]).map(s => (
          <a key={s} className={`sev-chip sc-${s}`} href={`#${s === 'ok' ? 'passed' : s === 'not_checked' ? 'waiting' : 'signs'}`}>
            <b className="num">{c[s]}</b><span>{SEV_WORD[s]}</span></a>))}
      </nav>

      {off && <p className="notice-in">AI reading is off: {needAr.length ? `${needAr.length} disclosure check${needAr.length > 1 ? 's' : ''} and ` : ''}flag
        explanations wait for it. The {flags.length - needAr.length} checks on reported numbers still run.{' '}
        <a href={href('documents', 'ai')}>Enable it</a></p>}

      {upgrades.length > 0 && <div className="banner" role="status">
        <p>Rule defaults moved: {upgrades.map((u, i) => <span key={u.key}>{i > 0 && ' · '}{u.label.toLowerCase()} {fmt(u.from, u.kind)} → {fmt(u.to, u.kind)}</span>)}.</p>
        <div className="banner-act"><button type="button" className="btn" onClick={onApply}>Use new defaults</button>
          <button type="button" className="link" onClick={onKeep}>Keep mine</button></div>
      </div>}

      <section className="blk" id="signs" tabIndex={-1} aria-labelledby="signs-h">
        <h2 id="signs-h">Red flags <span className="cnt">{c.signs}</span></h2>
        {signs.length ? <ol className="risk-cards">{signs.map(card)}</ol>
          : <p className="empty-state">No red flags: no reported year crosses a threshold.</p>}
      </section>

      {waiting.length > 0 && <section className="blk" id="waiting" tabIndex={-1} aria-labelledby="waiting-h">
        <h2 id="waiting-h">Not tested <span className="cnt">{waiting.length}</span></h2>
        <p className="why">{(needAr.length ? needAr : waiting).map(f => plain(f).gloss).join(', ').replace(/, (?=[^,]*$)/, ' and ')}: {needAr.length ? 'disclosed only in the annual report’s notes.' : 'not enough reported years.'}</p>
        {needAr.length > 0 && <div className="wait-box"><p className="serif">{blocker.text}</p><div className="rk-act">{blocker.act}</div></div>}
        {waiting.length > needAr.length && <p className="small-note">{waiting.filter(f => !f.needs).map(f => plain(f).gloss).join(', ')}: not enough reported years for the rule.</p>}
      </section>}

      {passed.length > 0 && <div id="passed" tabIndex={-1}><More title={<span><b>Clear</b> · {passed.map(f => plain(f).gloss).slice(0, 4).join(', ')}{passed.length > 4 ? '…' : ''}</span>} n={passed.length}>
        <ul className="passed">{passed.map(f => <li key={f.key} id={`a-${f.key}`} tabIndex={-1}><Sev level="ok" /> <span>{plain(f).gloss}</span> <span className="num dim">{fy(f.fact)}</span></li>)}</ul>
      </More></div>}

      {!lender && <section className="blk" id="unusual" tabIndex={-1} aria-labelledby="odd-h">
        <h2 id="odd-h">Outlier years (not flags) <span className="cnt">{oneoffYears.length}</span></h2>
        <p className="why">Years far from {short}’s own median (robust z-score on median and MAD). Not counted as red flags. Exclude one
          from the rule defaults, or have AI explain it from that year’s report.</p>
        {oneoffYears.length ? <ul className="odd-years">{oneoffYears.map(([year, items]) => {
          const out = doc.excluded_years.includes(year), inRules = used.includes(year)
          return (
            <li key={year}>
              <h3>{fy(items.map(o => o.note).join('. '))}</h3>
              <p className="small">In rule defaults: <b>{out ? 'no, excluded' : inRules ? 'yes' : 'no, outside the 3-year window'}</b>.</p>
              {/* an older year changes no rule figure, so it gets no button; one you left out can still go back */}
              {(inRules || out) && <div className="rk-act">
                <button type="button" className="btn" aria-pressed={out} aria-busy={pendingYear === year} aria-disabled={pendingYear != null || undefined}
                  onClick={() => toggleYear(year)}>{pendingYear === year ? 'Working…' : out ? `Include ${year}` : `Exclude ${year}`}</button>
              </div>}
              <Explain year={year} company={company} filings={doc.filings} notes={doc.notes} ai={ai} proposals={doc.proposals}
                report={annual.find(r => r.year === year)} note={doc.notes[`oneoff:${year}`] as OneOffNote | undefined}
                onProposals={onProposals} onReports={onReports} />
            </li>
          )
        })}</ul> : <p className="small-note">No outlier year in other income, tax rate, capex or EBITDA margin.</p>}
      </section>}

      <More title="Methodology">
        <p className="small">Each rule runs on the reported years with the same thresholds for every company. Severity is <b>High</b>,
          <b> Medium</b> or <b>Low</b> by distance past the threshold; <b>Clear</b> means within it; <b>Not tested</b> means the rule needs
          an annual-report disclosure or more years.</p>
        <ul className="small rules-list">{flags.map(f => <li key={f.key}><b>{plain(f).gloss}.</b> {f.rule}.</li>)}</ul>
        {flags.find(f => f.parts) && <MParts f={flags.find(f => f.parts)!} />}
      </More>

      <Next lead={needAr.length && !ar ? 'Disclosure checks need the annual report.' : lender ? 'What these mean for the value.' : 'The research note discusses these flags.'}>
        {needAr.length && !ar ? <a className="primary" href={href('documents', 'add')}>Attach annual report</a>
          : lender ? <a className="primary" href={href('valuation')}>Valuation</a> : <a className="primary" href={href('note')}>Research note</a>}
      </Next>
    </>
  )
}

const M_PARTS: [string, string][] = [['DSRI', 'Days sales in receivables index'], ['GMI', 'Gross margin index'], ['AQI', 'Asset quality index'],
  ['SGI', 'Sales growth index'], ['DEPI', 'Depreciation index'], ['SGAI', 'SG&A index'], ['LVGI', 'Leverage index'],
  ['TATA', 'Accruals / total assets']]
/** The Beneish M-score's eight ratios, and what this file lacks and is approximated. */
function MParts({ f }: { f: Forensic }) {
  return <>
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Beneish M-score components"><table className="keys">
      <caption className="small">Beneish M-score components</caption>
      <tbody>{M_PARTS.map(([k, label]) => <tr key={k}><th scope="row">{label} <span className="dim">{k}</span></th>
        <td className="num">{f.parts![k] != null ? f.parts![k].toFixed(2) : '–'}</td></tr>)}</tbody>
    </table></div>
    {f.approx && <ul className="small-note">{f.approx.map(a => <li key={a}>{cap(a)}.</li>)}</ul>}
  </>
}
