import type { ReactNode } from 'react'
import { Explain, FlagExplain, useAi } from './Sources'
import type { Upgrade } from './Model'
import { More, Next, PageHead, Sev } from './Shell'
import { useHref } from './route'
import { subjectOf } from './Note'
import {
  SEV_WORD, fmt, isAnnual, properName, sevCounts, shortYear, type Forensic, type ModelDoc, type OneOff, type OneOffNote, type Parsed, type Proposal,
  type Row, type Severity,
} from './lib'

const ORDER: Severity[] = ['high', 'medium', 'low', 'ok', 'not_checked']
/** The radar in reading order: worst first, then passed, then what couldn't run. */
export const bySeverity = (fs: Forensic[]) => [...fs].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen']
const w = (n: number) => WORDS[n] ?? String(n)
const cap = (t: string) => t[0].toUpperCase() + t.slice(1)
const lit = (f: Forensic) => f.severity === 'high' || f.severity === 'medium' || f.severity === 'low'

/** The checks in one sentence: "Nothing serious. Two things are worth a look, nine checks passed, and four can't run
 * until the annual report is read." From sevCounts only, like every count in the app. */
export function riskWords(fs: Forensic[] | null | undefined): string {
  const c = sevCounts(fs)
  if (!fs?.length) return 'The checks haven’t run on this model yet.'
  const first = c.high ? `${cap(w(c.high))} serious warning sign${c.high > 1 ? 's' : ''}.` : 'Nothing serious.'
  // the annual report unlocks only the checks that need it; the rest wait for more years
  const ar = fs.filter(f => f.severity === 'not_checked' && f.needs).length, short = c.not_checked - ar
  const rest = [
    c.medium ? `${w(c.medium)} ${c.medium > 1 ? 'things are' : 'thing is'} worth a look` : '',
    c.low ? `${w(c.low)} minor ${c.low > 1 ? 'signs' : 'sign'}` : '',
    c.ok ? `${w(c.ok)} check${c.ok > 1 ? 's' : ''} passed` : '',
    ar ? `${w(ar)} can’t run until the annual report is read` : '',
    short ? `${w(short)} can’t run on the years this file has` : '',
  ].filter(Boolean)
  const list = rest.length > 1 ? `${rest.slice(0, -1).join(', ')} and ${rest[rest.length - 1]}` : rest[0] ?? ''
  return list ? `${first} ${cap(list)}.` : first
}

/** Each rule in plain words: a title for when it's lit, why it matters, and a gloss for the passed list (term in brackets). */
const PLAIN: Record<string, { title: string; why: string; gloss: string }> = {
  cash: { title: 'Profit isn’t turning into cash', why: 'Profit that never arrives as cash can be an accounting choice rather than money in the bank.', gloss: 'Cash from operations against profit, three years (cash conversion)' },
  cash5: { title: 'Profit isn’t turning into cash', why: 'Profit that never arrives as cash can be an accounting choice rather than money in the bank.', gloss: 'Cash from operations against profit, five years (cash conversion)' },
  dso: { title: 'Customers are paying more slowly', why: 'Sales booked but not collected can flatter revenue, or mean customers are struggling to pay.', gloss: 'How long customers take to pay (receivable days)' },
  dio: { title: 'Stock is piling up', why: 'Unsold stock ties up cash and may have to be written down later.', gloss: 'How long stock sits before it’s sold (inventory days)' },
  cwip: { title: 'Money is stuck in unfinished projects', why: 'Spending parked as work in progress isn’t depreciated yet, so profit can look better than it is.', gloss: 'Projects not yet running (capital work in progress)' },
  other_income: { title: 'Other income is out of line', why: 'Income from outside the main business (interest, one-offs) can move profit without the business changing.', gloss: 'Income from outside the main business against profit before tax (other income)' },
  tax: { title: 'The tax rate jumps around', why: 'An unsteady tax rate makes this year’s profit a poor guide to next year’s.', gloss: 'How steady the tax rate is (tax-rate swing)' },
  debt: { title: 'Debt is high against operating profit', why: 'Heavy borrowing leaves less room if profits fall.', gloss: 'Debt against a year of operating profit (net debt ÷ EBITDA)' },
  cover: { title: 'Interest eats into operating profit', why: 'Thin cover means one bad year could make the interest hard to pay.', gloss: 'Times operating profit pays the interest (interest cover)' },
  nwc: { title: 'More money is tied up in running the business', why: 'Working capital growing faster than sales soaks up cash.', gloss: 'Money tied up day to day (working capital)' },
  mscore: { title: 'The earnings-quality score looks off', why: 'The score combines eight ratios that often move together when profits are inflated by accounting.', gloss: 'Earnings-quality score (Beneish M-score, a test for profits inflated by accounting)' },
  contingent: { title: 'Large possible bills off the balance sheet', why: 'Claims the company disputes can still have to be paid.', gloss: 'Possible bills not on the balance sheet (contingent liabilities)' },
  related: { title: 'Large dealings with group companies', why: 'Money moving to insiders can leave less for other shareholders.', gloss: 'Dealings with group companies and insiders (related parties)' },
  pledge: { title: 'Promoters have pledged shares', why: 'A lender can sell pledged shares if the price falls, pushing it down further.', gloss: 'Promoter shares pledged against loans (promoter pledge)' },
  auditor: { title: 'The auditor raised something', why: 'A qualified opinion or a sudden change of auditor can mean a disagreement over the accounts.', gloss: 'What the auditor said, and whether the auditor changed' },
}
const plain = (f: Forensic) => PLAIN[f.key] ?? { title: f.title, why: '', gloss: f.title }
/** Where a rule's numbers are in the statements, and the forecast input it links to. */
const NUMBERS: Record<string, [sub: string, row: string]> = {
  cash: ['cash-flow', 'cfo'], cash5: ['cash-flow', 'cfo'], dso: ['balance-sheet', 'receivables'], dio: ['balance-sheet', 'inventory'],
  cwip: ['balance-sheet', 'cwip'], other_income: ['profit-and-loss', 'other_income'], tax: ['profit-and-loss', 'tax'],
  debt: ['balance-sheet', 'borrowings'], cover: ['ratios', 'int_cover'], nwc: ['balance-sheet', 'receivables'], mscore: ['ratios', 'roce'],
}
const INPUT: Record<string, [key: string, words: string]> = {
  dso: ['dso', 'receivable days'], dio: ['dio', 'inventory days'], other_income: ['oi_pct', 'other income'], tax: ['tax_rate', 'the tax rate'],
}
const div = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? a / b : null)
/** The series a rule reads, one value per reported year, for its small chart (null: no chart). */
function seriesOf(key: string, hist: Row[], ratios: Row[]): { v: (number | null)[]; show: (x: number) => string } | null {
  const pct = (x: number) => fmt(x, 'pct')
  switch (key) {
    case 'dso': case 'dio': return { v: ratios.map(r => r[key] ?? null), show: x => `${Math.round(x)} days` }
    case 'cash': case 'cash5': return { v: hist.map(h => (h.pat && h.pat > 0 ? div(h.cfo, h.pat) : null)), show: x => `${x.toFixed(2)}×` }
    case 'cwip': return { v: hist.map(h => div(h.cwip, h.net_block)), show: pct }
    case 'other_income': return { v: hist.map(h => div(h.other_income, h.revenue)), show: pct }
    case 'tax': return { v: hist.map(h => div(h.tax, h.pbt)), show: pct }
    case 'debt': return { v: hist.map(h => h.nd_ebitda ?? null), show: x => `${x.toFixed(1)}×` }
    case 'cover': return { v: hist.map(h => h.int_cover ?? null), show: x => `${x.toFixed(0)}×` }
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
      <figcaption className="small dim"><span>{shortYear(years[0])}</span><span>{shortYear(years[years.length - 1])}</span></figcaption>
    </figure>
  )
}

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void
  upgrades: Upgrade[]; onApply: () => void; onKeep: () => void; onProposals: (f: (ps: Proposal[]) => Proposal[]) => void
  toggleYear: (year: string) => void; pendingYear: string | null
}

/** What could go wrong?: the fixed rules' warning signs as cards, what waits and why, what passed, and years that
 * stand out (never counted as warnings). AI can explain a sign; it never changes a number. */
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

  // the real blocker for the checks that wait on the annual report
  const blocker: { text: ReactNode; act: ReactNode } = !ar
    ? { text: <>No annual report attached.</>, act: <a className="btn" href={href('documents', 'add')}>Attach the annual report</a> }
    : off ? { text: <>The {ar.year} annual report is attached, but AI reading is off, so nothing has read it.</>,
      act: <><a className="btn" href={href('documents', 'ai')}>How to turn on AI reading</a> <a className="btn" href={href('documents', 'reading')}>See the report</a></> }
    : arNotes.length ? { text: <>The {ar.year} annual report has been read, but the notes these checks need weren’t found or aren’t approved yet.</>,
      act: <a className="btn" href={href('documents', 'reading')}>Review what AI read</a> }
    : { text: <>The {ar.year} annual report is attached but hasn’t been read yet.</>, act: <a className="btn" href={href('documents', 'reading')}>Read it with AI</a> }

  const card = (f: Forensic) => {
    const p = plain(f), s = seriesOf(f.key, hist, parsed.ratios), num = NUMBERS[f.key], inp = INPUT[f.key]
    return (
      <li key={f.key} id={`a-${f.key}`} tabIndex={-1} className={`risk-card s-${f.severity}`} aria-labelledby={`rk-${f.key}`}>
        <div className="rk-main">
          <p className="rk-head"><Sev level={f.severity} /> <b id={`rk-${f.key}`}>{p.title}</b></p>
          <p className="rk-fact serif">{f.detail}</p>
          {p.why && <p className="rk-why"><b>Why it matters:</b> {p.why}</p>}
          <details className="rk-rule"><summary>What the rule checked</summary>
            <p className="small">{f.rule}.{f.years.length > 0 && <> Years: {f.years.join(', ')}.</>} The number it found: <span className="num">{f.fact}</span>.</p>
            {f.parts && <MParts f={f} />}
          </details>
          <div className="rk-act">
            {num && <a className="btn" href={href('statements', num[1], num[0])}>See the numbers</a>}
            {inp && <a className="btn" href={href('forecast', inp[0])}>See {inp[1]} in the forecast</a>}
          </div>
          <FlagExplain flag={f} company={company} filings={doc.filings} notes={doc.notes} reports={annual}
            proposals={doc.proposals} note={doc.flag_notes.find(x => x.key === f.key)} ai={ai} onProposals={onProposals} />
        </div>
        {s && <MiniBars years={years} v={s.v} show={s.show} flagged={f.years} sev={f.severity} title={p.title} />}
      </li>
    )
  }

  return (
    <>
      <PageHead label="Answers" title={`What could go wrong at ${subjectOf(company)}?`}
        purpose={<>Fifteen fixed rules look for the usual signs of trouble in what {short} reported. Each sign says what was found, why
          it matters and what the rule checked. AI can explain a sign from the annual report; it never changes a number.</>}
        answer={riskWords(parsed.forensic)} />

      <nav className="sev-chips" aria-label="Checks by severity">
        {(['high', 'medium', 'low', 'ok', 'not_checked'] as Severity[]).map(s => (
          <a key={s} className={`sev-chip sc-${s}`} href={`#${s === 'ok' ? 'passed' : s === 'not_checked' ? 'waiting' : 'signs'}`}>
            <b className="num">{c[s]}</b><span>{SEV_WORD[s]}</span></a>))}
      </nav>

      {off && <p className="notice-in">AI reading is off, so {needAr.length ? `${w(needAr.length)} check${needAr.length > 1 ? 's' : ''} and ` : ''}the
        explanations wait for it. All {flags.length - needAr.length} rule checks that need only the numbers still run.{' '}
        <a href={href('documents', 'ai')}>How to turn it on</a></p>}

      {upgrades.length > 0 && <div className="banner" role="status">
        <p>The rules’ figures moved: {upgrades.map((u, i) => <span key={u.key}>{i > 0 && ' · '}{u.label.toLowerCase()} {fmt(u.from, u.kind)} → {fmt(u.to, u.kind)}</span>)}.</p>
        <div className="banner-act"><button type="button" className="btn" onClick={onApply}>Use the new figures</button>
          <button type="button" className="link" onClick={onKeep}>Keep mine</button></div>
      </div>}

      <section className="blk" id="signs" tabIndex={-1} aria-labelledby="signs-h">
        <h2 id="signs-h">Warning signs <span className="cnt">{c.signs}</span></h2>
        {signs.length ? <ol className="risk-cards">{signs.map(card)}</ol>
          : <p className="empty-state">No rule found a warning sign: nothing in the reported years crosses a threshold.</p>}
      </section>

      {waiting.length > 0 && <section className="blk" id="waiting" tabIndex={-1} aria-labelledby="waiting-h">
        <h2 id="waiting-h">Not checked yet <span className="cnt">{waiting.length}</span></h2>
        <p className="why">{cap(waiting.map(f => f.title.toLowerCase()).join(', ').replace(/, (?=[^,]*$)/, ' and '))}: {needAr.length ? 'these are only in the annual report’s notes.' : 'this file lacks the years they need.'}</p>
        {needAr.length > 0 && <div className="wait-box"><p className="serif">{blocker.text}</p><div className="rk-act">{blocker.act}</div></div>}
        {waiting.length > needAr.length && <p className="small-note">{waiting.filter(f => !f.needs).map(f => plain(f).title).join(', ')}: this file doesn’t have the years the rule needs.</p>}
      </section>}

      {passed.length > 0 && <div id="passed" tabIndex={-1}><More title={<span><b>Passed</b> · {passed.map(f => plain(f).gloss.replace(/ \(.*\)$/, '').toLowerCase()).slice(0, 4).join(', ')}{passed.length > 4 ? '…' : ''}</span>} n={passed.length}>
        <ul className="passed">{passed.map(f => <li key={f.key} id={`a-${f.key}`} tabIndex={-1}><Sev level="ok" /> <span>{plain(f).gloss}</span> <span className="num dim">{f.fact}</span></li>)}</ul>
      </More></div>}

      <section className="blk" id="unusual" tabIndex={-1} aria-labelledby="odd-h">
        <h2 id="odd-h">Not warnings: years that stand out <span className="cnt">{oneoffYears.length}</span></h2>
        <p className="why">These years look unlike the rest of {short}’s history. They are not counted as warning signs. You can leave one out
          of the rules’ figures, or have AI explain it from that year’s report.</p>
        {oneoffYears.length ? <ul className="odd-years">{oneoffYears.map(([year, items]) => {
          const out = doc.excluded_years.includes(year), inRules = used.includes(year)
          return (
            <li key={year}>
              <h3>{items.map(o => o.note).join('. ')}</h3>
              <p className="small">In the rules’ figures: <b>{out ? 'no, you left it out' : inRules ? 'yes' : 'no, older than the three years the rules use'}</b>.</p>
              {/* an older year changes no rule figure, so it gets no button; one you left out can still go back */}
              {(inRules || out) && <div className="rk-act">
                <button type="button" className="btn" aria-pressed={out} aria-busy={pendingYear === year} aria-disabled={pendingYear != null || undefined}
                  onClick={() => toggleYear(year)}>{pendingYear === year ? 'Working…' : out ? `Put ${year} back in` : `Leave ${year} out`}</button>
              </div>}
              <Explain year={year} company={company} filings={doc.filings} notes={doc.notes} ai={ai} proposals={doc.proposals}
                report={annual.find(r => r.year === year)} note={doc.notes[`oneoff:${year}`] as OneOffNote | undefined}
                onProposals={onProposals} onReports={onReports} />
            </li>
          )
        })}</ul> : <p className="small-note">No year sits far from {short}’s own history on other income, tax rate, capex or operating margin.</p>}
      </section>

      <More title="How each rule works">
        <p className="small">Every rule runs on the reported years with the same thresholds for every company. A sign is <b>Serious</b>,
          <b> Worth a look</b> or <b>Minor</b> by how far past its threshold the number is; <b>Passed</b> means it stayed inside; <b>Not checked
          yet</b> means the rule needs a figure only the annual report prints.</p>
        <ul className="small rules-list">{flags.map(f => <li key={f.key}><b>{plain(f).gloss}.</b> {f.rule}.</li>)}</ul>
        {flags.find(f => f.parts) && <MParts f={flags.find(f => f.parts)!} />}
      </More>

      <Next lead={needAr.length && !ar ? 'Some checks wait for the annual report.' : 'The research note puts these signs in words.'}>
        {needAr.length && !ar ? <a className="primary" href={href('documents', 'add')}>Attach the annual report</a>
          : <a className="primary" href={href('note')}>Read the research note</a>}
      </Next>
    </>
  )
}

const M_PARTS: [string, string][] = [['DSRI', 'Receivable days index'], ['GMI', 'Gross margin index'], ['AQI', 'Asset quality index'],
  ['SGI', 'Sales growth index'], ['DEPI', 'Depreciation index'], ['SGAI', 'SG&A index'], ['LVGI', 'Leverage index'],
  ['TATA', 'Accruals / total assets']]
/** The earnings-quality score's eight ratios, and what this file lacks and is approximated. */
function MParts({ f }: { f: Forensic }) {
  return <>
    <div className="table-wrap" tabIndex={0} role="region" aria-label="The eight ratios of the earnings-quality score"><table className="keys">
      <caption className="small">The eight ratios of the earnings-quality score</caption>
      <tbody>{M_PARTS.map(([k, label]) => <tr key={k}><th scope="row">{label} <span className="dim">{k}</span></th>
        <td className="num">{f.parts![k] != null ? f.parts![k].toFixed(2) : '–'}</td></tr>)}</tbody>
    </table></div>
    {f.approx && <ul className="small-note">{f.approx.map(a => <li key={a}>{cap(a)}.</li>)}</ul>}
  </>
}
