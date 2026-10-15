import { useEffect, useRef, useState } from 'react'
import { money, shortYear } from './lib'

const H = 300, M = { top: 28, right: 8, bottom: 30, left: 64 }

function niceTicks(lo: number, hi: number) {
  const raw = (hi - lo || 1) / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)!
  const out: number[] = []
  const end = Math.ceil(hi / step) * step
  for (let t = Math.floor(lo / step) * step; t <= end + step * 1e-6; t += step) out.push(+t.toFixed(10))
  return out
}

interface Props { title: string; years: string[]; values: (number | null)[]; nHist: number }

export default function Chart({ title, years, values, nHist }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [])

  const nums = values.filter((v): v is number => v != null && Number.isFinite(v))
  const ticks = niceTicks(Math.min(0, ...nums), Math.max(0, ...nums))
  const [lo, hi] = [ticks[0], ticks[ticks.length - 1]]
  const innerW = w - M.left - M.right, innerH = H - M.top - M.bottom
  const band = innerW / years.length
  const bw = Math.min(44, band * 0.64)
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo || 1)) * innerH
  const x = (i: number) => M.left + i * band + band / 2
  const every = Math.ceil(38 / band) // year-label stride so labels never overlap
  const narrow = every > 1
  const labelled = new Set([...(narrow ? [] : [nHist - 1]), years.length - 1, ...(hover != null ? [hover] : [])])

  return (
    <div className="chart" ref={box}>
      <svg
        width={w}
        height={H}
        role="img"
        aria-label={`${title}: ${years.map((yr, i) => `${yr} ${money(values[i])}`).join(', ')}`}
        onPointerMove={e => {
          const r = e.currentTarget.getBoundingClientRect()
          const i = Math.floor((e.clientX - r.left - M.left) / band)
          setHover(i >= 0 && i < years.length ? i : null)
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <pattern id="pencil-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" className="hatch-bg" />
            <line x1="0" y1="0" x2="0" y2="5" className="hatch-line" />
          </pattern>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line className={t === 0 ? 'axis-zero' : 'grid'} x1={M.left} x2={w - M.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{money(t)}</text>
          </g>
        ))}
        {nHist < years.length && (
          <g>
            <line className="divider" x1={M.left + nHist * band} x2={M.left + nHist * band} y1={M.top - 18} y2={H - M.bottom} />
            <text className="divider-label" x={M.left + nHist * band + 6} y={M.top - 10}>Projected</text>
            {!narrow && <text className="divider-label ink" x={M.left + nHist * band - 6} y={M.top - 10} textAnchor="end">Reported</text>}
          </g>
        )}
        {values.map((v, i) => {
          if (v == null || !Number.isFinite(v)) return null
          const proj = i >= nHist
          const top = Math.min(y(v), y(0)), h = Math.max(1, Math.abs(y(v) - y(0)))
          return (
            <g key={years[i]} className={hover === i ? 'is-hover' : undefined}>
              <rect className={proj ? 'bar proj' : 'bar'} x={x(i) - bw / 2} y={top} width={bw} height={h}
                style={{ animationDelay: proj ? `${(i - nHist) * 60}ms` : undefined }} />
              {labelled.has(i) && (
                <text className={proj ? 'bar-label proj' : 'bar-label'} x={x(i)} y={v >= 0 ? top - 6 : top + h + 14} textAnchor="middle">
                  {money(v)}
                </text>
              )}
            </g>
          )
        })}
        {years.map((yr, i) => ((years.length - 1 - i) % every ? null : (
          <text key={yr} className={i >= nHist ? 'year proj' : 'year'} x={x(i)} y={H - 10} textAnchor="middle">{shortYear(yr)}</text>
        )))}
      </svg>
    </div>
  )
}
