import { useState } from 'react'
import { fmt, groupKeys, type LayoutLine, type LineKind, type Row } from './lib'

const TOTALS = new Set(['ebitda', 'pat', 'total_liab', 'total_assets', 'net_cf', 'fcf', 'fcff'])
const TABS = [['PROFIT & LOSS', 'Profit & loss'], ['BALANCE SHEET', 'Balance sheet'], ['CASH FLOW', 'Cash flow'],
  ['RATIOS', 'Ratios']] as const

interface Props { layout: LayoutLine[]; years: string[]; rows: Row[]; nHist: number }

export default function Statements({ layout, years, rows, nHist }: Props) {
  const [tab, setTab] = useState<string>(TABS[0][0])
  const lines: [string, string, LineKind][] = []
  let section = ''
  for (const [label, key, kind] of layout) {
    if (kind === 'head') section = label
    else if (key && section === tab) lines.push([label, key, kind as LineKind])
  }

  return (
    <section className="statements" aria-label="Financial statements">
      <div className="tabs" role="tablist" aria-label="Statement">
        {TABS.map(([id, name], i) => (
          <button key={id} id={`stmt-tab-${i}`} role="tab" type="button" aria-selected={tab === id} className="tab"
            aria-controls="stmt-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
            onKeyDown={e => groupKeys(e, TABS.map(t => t[0] as string), tab, setTab)}>
            {name}
          </button>
        ))}
      </div>
      <div className="table-wrap" id="stmt-panel" role="tabpanel" tabIndex={0}
        aria-labelledby={`stmt-tab-${TABS.findIndex(t => t[0] === tab)}`}>
        <table>
          <thead>
            <tr>
              <th scope="col">{tab === 'RATIOS' ? 'Ratio' : 'Rs crore'}</th>
              {years.map((y, i) => <th scope="col" key={y} className={i >= nHist ? 'proj' : undefined}>{y}</th>)}
            </tr>
          </thead>
          <tbody>
            {lines.map(([label, key, kind]) => (
              <tr key={key} className={TOTALS.has(key) ? 'total' : undefined}>
                <th scope="row">{label}</th>
                {rows.map((r, i) => (
                  <td key={years[i]} className={i >= nHist ? 'proj' : undefined}>{fmt(r[key], kind)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tab === 'RATIOS' && (
        <p className="muted small">
          ROE = net profit / average equity. ROCE = EBIT / average (equity + borrowings), EBIT = profit before tax +
          interest. Asset turnover = revenue / average total assets. Averages use opening and closing balances; the
          first year uses closing. Net debt = borrowings − cash − investments. – means not meaningful (zero or
          negative denominator).
        </p>
      )}
    </section>
  )
}
