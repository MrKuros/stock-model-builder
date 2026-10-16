# Stock Model Builder

Turn an Indian listed company's reported financials into a three-statement forecast you can steer, then export it as an Excel model with live formulas.

Reported years are drawn in **ink**. Your assumptions are drawn in **blue pencil**: each driver is a strip showing its own history, and you drag a pencil line to set the future.

![Workspace: Milky Mist Dairy Food Ltd with a revenue-growth fade and base/bull/bear scenarios](docs/screenshots/desk-light.png)

<table>
<tr>
<td><img src="docs/screenshots/landing.png" alt="Landing page" /></td>
<td><img src="docs/screenshots/desk-dark.png" alt="Workspace in dark mode" /></td>
</tr>
</table>

## What it does

- **Import:** reads a [Export.in](https://www.export.in) "Export to Excel" workbook: up to 10 years of P&L, balance sheet and cash flow, in ₹ crore.
- **Data checks:** checks the books before modelling: assets equal liabilities, lines add up to their totals, PBT less tax matches net profit, and year-end changes are flagged. Banks, NBFCs and insurers are detected and rejected with a clear message, because they need a different model.
- **Defaults from history:** revenue CAGR, three-year ratio-of-sums margins and working-capital days, and a median for lumpy items like capex and other income.
- **Three-statement projection:** P&L, balance sheet and cash flow stay linked. Cash is the balancing item, and the model borrows automatically when cash would go negative. Depreciation and interest run on opening balances, so there are no circular references.
- **Steering:** drag, type or use arrow keys on 14 drivers. "Fade" moves a driver from one value to another over the forecast.
- **Scenarios:** base, bull and bear, shown as overlays on the chart and compared in a single sentence.
- **Return ratios:** ROE, ROCE, asset turnover, net debt/EBITDA and interest cover, for history and projection.
- **One-off detection:** unusual years (tax, capex, other income, margin) are flagged with robust statistics (median and MAD). You can leave them out of the defaults.
- **DCF valuation:** free cash flow to firm discounted at a WACC you build (risk-free rate, equity risk premium, beta, cost of debt), Gordon terminal value, and a bridge to value per share. A price ruler puts today's price (ink) next to the bear, base and bull values (pencil). The Excel export has a Valuation sheet with live formulas.
- **Sensitivity and reverse DCF:** value per share across WACC × terminal growth (live formulas in Excel) and revenue growth × EBITDA margin (values, since each cell is a full re-projection), and the flat revenue growth today's price implies.
- **Multiples cross-check:** P/E, EV/EBITDA and P/B at today's price and at each scenario's value, against the company's own year-end multiples, with a flag when one sits outside its historical range.
- **Quarters and TTM:** the last ten quarters (sales, operating profit and margin, net profit, year-on-year growth) next to the last reported year and the trailing twelve months, and a sentence on TTM growth. The Excel export adds a Quarters sheet whose TTM column is live SUM formulas.
- **Restatement check:** importing a newer file for a company you've already modelled lists any overlapping reported year whose revenue, EBITDA, net profit, total assets or borrowings moved by more than 0.5%.
- **Model library:** models autosave to `models/` locally, and you can reopen any of them from the start page.
- **Excel export:** every projected statement cell is a live formula. Inputs are blue, and a scenario selector switches the whole workbook between base, bull and bear.

## How the numbers stay trustworthy

- **One engine:** `model.py` computes everything the dashboard shows.
- **The Excel export is checked against that engine.** The test suite recalculates the exported workbook in LibreOffice and compares every projected cell, in all three scenarios, with the Python results.
- **The checks are real:** they were run on 15 real Export exports (TCS, JSW Steel, Tata Motors, Bharti Airtel, Coal India, Sun Pharma, Adani Ports, and others). All lenders are correctly rejected.
- **A pre-commit hook** runs the tests and the TypeScript type check before every commit.

## Run it

Requires [uv](https://docs.astral.sh/uv/) and Node.js 20+. LibreOffice is optional; it's only used by the Excel check in the tests.

```bash
./run.sh          # installs dependencies, builds the UI, serves http://127.0.0.1:8000
./run.sh dev      # hot reload (Vite on :5173, API on :8000)
./run.sh test     # engine tests + Excel parity check
```

Then open the app, drop in a Export.in export, or click **Explore with a sample company**.

## Stack

| Part | Tech |
|---|---|
| Engine | Python, openpyxl |
| API | FastAPI (stateless; the client sends the model back with each request) |
| UI | React 18 + TypeScript + Vite, with hand-drawn SVG charts and no UI or chart libraries |
| Tests | Plain-assert self-check, plus LibreOffice headless for Excel recalculation |

```
model.py          parse, checks, defaults, projection, ratios, one-offs, valuation, Excel export
server.py         API + local model library
test_model.py     self-check incl. Excel parity
web/src/          App, DriverStrip (assumption strips), Chart, Statements, Valuation
```

## Design notes

- **Ink and pencil** comes from how analysts mark up statements: actuals in ink, estimates in pencil.
- **Fonts:** Bricolage Grotesque (display), Instrument Sans (UI), IBM Plex Mono (numbers).
- **Numbers** use Indian digit grouping (1,23,456), with negatives in brackets.
- **Accessibility:** light and dark themes, works down to 390 px, keyboard-accessible sliders and tabs, and reduced motion is respected.

## Limitations

- Input is Export.in exports only. BSE/NSE XBRL filings are planned.
- Export's export has no COGS or payables split, so working capital is measured in days of revenue, and capex is inferred from the change in net block.
- Financial companies (banks, NBFCs, insurers) aren't supported yet.
- It's a modelling tool, not investment advice. The forecasts are only as good as the assumptions you give it.

## Roadmap

1. ~~Daily driver: scenarios, fades, ratios, one-offs, model library~~ ✓
2. ~~Valuation: DCF (FCFF), sensitivity tables, reverse DCF, multiples~~ ✓
3. Richer data: BSE/NSE XBRL, annual-report notes (segments, debt maturity), quarterly/TTM
4. Analyst toolkit: forecast-vs-actual tracking, anomaly radar, peer comparison, watchlist
