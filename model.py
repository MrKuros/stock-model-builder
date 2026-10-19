"""A 10-year financials Excel export -> three-statement projection model (all figures in Rs crore)."""
import calendar
import io
import math
import re
import statistics
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

import openpyxl
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

# The export's "Data Sheet" row label -> our key. Labels matched case-insensitively.
# Repeated labels get a "#2" suffix ("Total" appears twice in the balance sheet).
PL = {"Sales": "revenue", "Other Income": "other_income", "Depreciation": "dep", "Interest": "interest",
      "Profit before tax": "pbt", "Tax": "tax", "Net profit": "pat", "Dividend Amount": "dividend"}
BS = {"Equity Share Capital": "share_cap", "Reserves": "reserves", "Borrowings": "borrowings",
      "Other Liabilities": "other_liab", "Total": "total_liab", "Net Block": "net_block",
      "Capital Work in Progress": "cwip", "Investments": "investments", "Other Assets": "other_assets",
      "Total#2": "total_assets", "Receivables": "receivables", "Inventory": "inventory", "Cash & Bank": "cash"}
CF = {"Cash from Operating Activity": "cfo", "Cash from Investing Activity": "cfi",
      "Cash from Financing Activity": "cff"}
# COGS = raw material cost (materials + purchases of stock in trade) - change in inventory: the export's own P&L sheet
# subtracts "Change in Inventory" (stock built up), so this equals the filings' materials + purchases + changes in
# inventories (JSW Steel FY2021: 32,856 - 348 = 32,508 both ways). None when the export has no Raw Material Cost.
COGS = {"Raw Material Cost": "rm", "Change in Inventory": "inv_change"}
OPTIONAL = {"Dividend Amount", "Cash from Operating Activity", "Cash from Investing Activity",
            "Cash from Financing Activity", *COGS}
COGS_MIN = 0.10  # working-capital days run on COGS only when it's at least this share of revenue (see on_cogs())
# The export's "Quarters" block (last ten quarters) -> company["quarters"]["rows"] keys. All are flows, so TTM sums them.
QUARTERS = {"Sales": "sales", "Expenses": "expenses", "Operating Profit": "op_profit", "Other Income": "other_income",
            "Depreciation": "depreciation", "Interest": "interest", "Profit before tax": "pbt", "Tax": "tax",
            "Net profit": "net_profit"}
SECTION_HEADS = (("PROFIT & LOSS", "pl"), ("QUARTERS", "q"), ("BALANCE SHEET", "bs"),
                 ("CASH FLOW", "cf"), ("PRICE", None), ("DERIVED", None))
EXPORT = "Excel export"  # where a year came from when no filing gave it (Company.source years)
TOL = 1.0  # Rs crore; the export rounds to 2 decimals per line

# key, label, kind. Historical values are the actual ratios; projected values are the inputs.
DRIVERS = [
    ("growth", "Revenue growth", "pct"),
    ("ebitda_margin", "EBITDA margin", "pct"),
    ("oi_pct", "Other income % revenue (history incl. exceptionals)", "pct"),
    ("dep_pct", "Depreciation % opening net block", "pct"),
    ("int_rate", "Interest % opening borrowings", "pct"),
    ("tax_rate", "Tax rate", "pct"),
    ("mi_pct", "Minority & associates % of post-tax profit", "pct"),
    ("payout", "Dividend payout", "pct"),
    ("capex_pct", "Capex % revenue", "pct"),
    ("dso", "Receivable days", "days"),
    ("cogs_pct", "COGS % revenue", "pct"),
    ("dio", "Inventory days", "days"),  # on COGS or on revenue, see on_cogs()
    ("dpo", "Payable days", "days"),  # same base as inventory days
    ("oca_pct", "Other current assets % revenue", "pct"),
    ("ol_pct", "Other liabilities % revenue", "pct"),
    ("debt_change", "Planned borrowing change per year", "num"),
]

# Scenario order is also the Excel selector value (1, 2, 3). The UI seeds bull/bear from base
# (growth +/- 3 pp, EBITDA margin +/- 1.5 pp, all else equal); the engine just takes three assumption sets.
SCENARIOS = ("base", "bull", "bear")

LAYOUT = [  # (label, key, kind); kind "head" = section title, None key = blank row
    ("ASSUMPTIONS", None, "head"),
    *[(label, key, kind) for key, label, kind in DRIVERS],
    ("", None, None),
    ("PROFIT & LOSS", None, "head"),
    ("Revenue", "revenue", "num"), ("Cost of goods sold (memo)", "cogs", "num"), ("EBITDA", "ebitda", "num"), ("Other income", "other_income", "num"),
    ("Depreciation", "dep", "num"), ("Interest", "interest", "num"), ("Profit before tax", "pbt", "num"),
    ("Tax", "tax", "num"), ("Net profit", "pat", "num"), ("Dividend", "dividend", "num"),
    ("", None, None),
    ("BALANCE SHEET", None, "head"),
    ("Equity share capital", "share_cap", "num"), ("Reserves", "reserves", "num"),
    ("Borrowings", "borrowings", "num"), ("Lease liabilities", "lease", "num"), ("Trade payables", "payables", "num"),
    ("Other liabilities", "other_liab", "num"),
    ("Total liabilities", "total_liab", "num"),
    ("Net block", "net_block", "num"), ("Capital WIP", "cwip", "num"), ("Investments", "investments", "num"),
    ("Receivables", "receivables", "num"), ("Inventory", "inventory", "num"),
    ("Other current assets", "other_ca", "num"), ("Cash & bank", "cash", "num"),
    ("Total assets", "total_assets", "num"),
    ("", None, None),
    ("CASH FLOW", None, "head"),
    ("Cash from operations", "cfo", "num"), ("Cash from investing", "cfi", "num"),
    ("Cash from financing", "cff", "num"), ("Net cash flow", "net_cf", "num"),
    ("Capex", "capex", "num"), ("Free cash flow", "fcf", "num"),
    ("Borrowed to cover cash shortfall", "revolver", "num"),
    ("Operating EBIT (excl. other income)", "ebit", "num"), ("Operating EBIT after tax", "nopat", "num"),
    ("Net working capital", "nwc", "num"), ("Free cash flow to firm", "fcff", "num"),
    ("", None, None),
    ("RATIOS", None, "head"),
    ("Return on equity", "roe", "pct"), ("Return on capital employed", "roce", "pct"),
    ("Asset turnover", "asset_turnover", "x"), ("Net debt / EBITDA", "nd_ebitda", "x"),
    ("Interest cover", "int_cover", "x"),
    ("", None, None),
    ("CHECKS (should be 0)", None, "head"),
    ("Assets - liabilities", "chk_bs", "chk"), ("Cash roll-forward", "chk_cash", "chk"),
]


# ---------- parsing ----------

def _sections(ws):
    sec, out = None, {}
    for row in ws.iter_rows(values_only=True):
        label = row[0].strip() if row and isinstance(row[0], str) else None
        if not label:
            continue
        head = next((key for h, key in SECTION_HEADS if label.upper().startswith(h)), False)
        if head is not False:
            sec = head
            if sec:
                out.setdefault(sec, {})
            continue
        if sec:
            k, n = label.lower(), 2
            while k in out[sec]:
                k, n = f"{label.lower()}#{n}", n + 1
            out[sec][k] = row[1:]
    return out


def _cell(row, i, section, label, d):
    v = row[i] if i < len(row) else None  # read_only rows can be ragged when the sheet has no <dimension>
    if isinstance(v, str):
        v = v.replace(",", "").strip()
        v = None if v in ("", "-") else v
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{section} '{label}' {d:%b %Y}: not a number: {v!r}") from None


def _by_date(rows, mapping, section, blank=0.0):
    if rows is None:
        raise ValueError(f"No '{section}' section found. Is this an Excel export?")
    dates = rows.get("report date")
    if not dates:
        raise ValueError(f"{section}: no 'Report Date' row")
    missing = [l for l in mapping if l.lower() not in rows and l not in OPTIONAL]
    if missing:
        raise ValueError(f"{section}: missing rows {missing}. Banks/NBFCs/insurers use a different "
                         f"layout and are not supported yet. Rows found: {list(rows)}")
    out = {}
    for i, d in enumerate(dates):
        if isinstance(d, datetime):
            out[d] = {key: blank if v is None else v for label, key in mapping.items()
                      for v in [_cell(rows.get(label.lower(), ()), i, section, label, d)]}
    return out


def parse_export(file):
    """file: path or file-like of a 10-year financials Excel export (a 'Data Sheet' tab)."""
    try:
        wb = openpyxl.load_workbook(file, data_only=True, read_only=True)
    except Exception as e:
        raise ValueError(f"Could not open this file as an .xlsx workbook ({e}). "
                         "Upload a 10-year financials Excel export with a 'Data Sheet' tab.") from e
    if "Data Sheet" not in wb.sheetnames:
        raise ValueError("No 'Data Sheet' tab. Upload a 10-year financials Excel export that has one.")
    ws = wb["Data Sheet"]
    name = next((r[1] for r in ws.iter_rows(max_row=5, values_only=True)
                 if isinstance(r[0], str) and r[0].strip().upper() == "COMPANY NAME"), None) or "Company"
    s = _sections(ws)
    pl, bs = _by_date(s.get("pl"), PL, "PROFIT & LOSS"), _by_date(s.get("bs"), BS, "BALANCE SHEET")
    cf = _by_date(s.get("cf"), CF, "CASH FLOW", blank=None) if s.get("cf") else {}
    cg = _by_date(s["pl"], COGS, "PROFIT & LOSS", blank=None) if "raw material cost" in s["pl"] else {}
    if not any(v["revenue"] for v in pl.values()):
        raise ValueError("'Sales' row has no values. If the file was edited by a script, open it in Excel "
                         "and save it again so formula results are stored.")
    dates = sorted(d for d in pl if d in bs and pl[d]["revenue"] and bs[d]["total_liab"])
    if len(dates) < 2:
        raise ValueError("Need at least 2 years with both P&L and balance sheet data.")

    rows = []
    for d in dates:
        h = {**pl[d], **bs[d], **cf.get(d, dict.fromkeys(("cfo", "cfi", "cff")))}
        c = cg.get(d) or {}
        h["cogs"] = None if c.get("rm") is None else c["rm"] - (c["inv_change"] or 0.0)
        rows.append(h)
    hist = _derive(rows)
    _not_lender(hist)
    return {"name": str(name), "dates": dates, "hist": hist, "market": _market(ws, s["pl"]["report date"], dates),
            "quarters": _quarters(s.get("q"))}


def _derive(rows):
    """Reported lines per year (oldest first) -> history rows with the derived lines: EBITDA, other current assets,
    net cash flow, capex from the net block, free cash flow and the return ratios."""
    hist = []
    for h in rows:
        h = dict(h)
        h["ebitda"] = h["pbt"] + h["interest"] + h["dep"] - h["other_income"]
        h["other_ca"] = h["other_assets"] - h["receivables"] - h["inventory"] - h["cash"]
        h["net_cf"] = None if None in (h["cfo"], h["cfi"], h["cff"]) else h["cfo"] + h["cfi"] + h["cff"]
        p = hist[-1] if hist else None
        h["capex"] = h["net_block"] - p["net_block"] + h["cwip"] - p["cwip"] + h["dep"] if p else None
        h["fcf"] = h["cfo"] - h["capex"] if p and h["cfo"] is not None else None
        h.update(returns(h, p))
        hist.append(h)
    return hist


class Lender(ValueError):
    """A bank, NBFC or insurer: this model doesn't fit it, whatever the source, so an Excel export won't help either."""


def _not_lender(hist):
    """Lender (a ValueError) for a bank, NBFC or insurer, which this model doesn't fit."""
    # ponytail: heuristic, tuned on 15 real exports: lenders' loan books sit in Other Assets at 2.7-9.4x revenue;
    # non-financials stay under ~1.6x (ADANIPORTS: infra loans/advances ~1.2x). Revisit if a real lender slips under 2x.
    rev = [h for h in hist if h["revenue"]]
    if not rev:
        raise ValueError("No year has revenue from operations.")
    wc = statistics.median((h["receivables"] + h["inventory"]) / h["revenue"] for h in rev)
    ir = statistics.median(h["interest"] / h["revenue"] for h in rev)
    oca = statistics.median(h["other_ca"] / h["revenue"] for h in rev)
    if all(not h["receivables"] and not h["inventory"] for h in hist) or (ir > 0.3 and wc < 0.05) or oca > 2.0:
        raise Lender("Looks like a bank/NBFC/insurer (loan book or interest dominates, no receivables/inventory). "
                     "Financial companies are not supported yet.")


def _quarters(rows):
    """{"dates", "rows": {key: [float|None per quarter]}} from the Quarters block, or None when the export has none
    (Milky Mist). Operating profit uses the annual EBITDA rule (PBT + interest + depreciation - other income), so the
    TTM column lines up with the reported years; the export's own row is the fallback when a line is missing."""
    cols = [(i, d) for i, d in enumerate((rows or {}).get("report date") or ()) if isinstance(d, datetime)]

    def num(label, i, d):
        try:
            return _cell(rows.get(label.lower(), ()), i, "Quarters", label, d)
        except ValueError:
            return None  # ponytail: quarters are optional extras; a text cell blanks that quarter, never fails the parse
    q = {key: [num(label, i, d) for i, d in cols] for label, key in QUARTERS.items()}
    for j in range(len(cols)):
        parts = [q[k][j] for k in ("pbt", "interest", "depreciation", "other_income")]
        if None not in parts:
            q["op_profit"][j] = parts[0] + parts[1] + parts[2] - parts[3]
        elif q["op_profit"][j] is None and None not in (q["sales"][j], q["expenses"][j]):
            q["op_profit"][j] = q["sales"][j] - q["expenses"][j]
    keep = [j for j in range(len(cols)) if q["sales"][j] is not None]
    if not keep:
        return None
    return {"dates": [cols[j][1] for j in keep], "rows": {k: [v[j] for j in keep] for k, v in q.items()}}


def ttm(q, back=0):
    """Trailing twelve months ending `back` quarters before the latest: each row summed over four quarters, None
    where one is missing. None when there are fewer than four, or they aren't consecutive (80-100 days apart).
    Mirrored by the TTM column on the Quarters sheet (back=0)."""
    d = (q or {}).get("dates") or []
    hi = len(d) - back
    if hi < 4 or not all(80 <= (b - a).days <= 100 for a, b in zip(d[hi - 4:hi], d[hi - 3:hi])):
        return None
    return {"end": d[hi - 1], "values": {k: None if None in v[hi - 4:hi] else sum(v[hi - 4:hi])
                                         for k, v in q["rows"].items()}}


def _pos(v):
    """A positive finite number, else None (formulas without a cached value come back as None)."""
    try:
        v = float(str(v).replace(",", "")) if isinstance(v, str) else v
    except ValueError:
        return None
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0 else None


def _market(ws, cols, dates):
    """Share price and count (shares in crore) from META, the PRICE row and DERIVED; any of it may be missing."""
    rows = {}
    for r in ws.iter_rows(values_only=True):
        if r and isinstance(r[0], str):
            rows.setdefault(r[0].strip().rstrip(":").strip().lower(), r[1:])
    first = lambda label: _pos((rows.get(label) or (None,))[0])  # noqa: E731
    at = {d: i for i, d in enumerate(cols) if isinstance(d, datetime)}  # PRICE / DERIVED share the annual columns
    hist = lambda label: [_pos(rows[label][at[d]]) if label in rows and at[d] < len(rows[label]) else None  # noqa: E731
                          for d in dates]
    price, mcap = first("current price"), first("market capitalization")
    shares_hist = hist("adjusted equity shares in cr")
    shares = mcap / price if price and mcap else next((v for v in reversed(shares_hist) if v), None)
    return {"price": price, "shares": shares, "price_hist": hist("price"), "shares_hist": shares_hist,
            "face_value": first("face value")}


def data_checks(co):
    """Sanity checks on the parsed historicals; returns list of warning strings."""
    issues = []
    for d, h in zip(co["dates"], co["hist"]):
        for what, diff in (
            ("assets - liabilities", h["total_assets"] - h["total_liab"]),
            ("liability lines vs Total", h["share_cap"] + h["reserves"] + h["borrowings"] + h["other_liab"] - h["total_liab"]),
            ("asset lines vs Total", h["net_block"] + h["cwip"] + h["investments"] + h["other_assets"] - h["total_assets"]),
            ("PBT - tax vs net profit (minority share / associates / exceptionals, normal for consolidated)",
             h["pbt"] - h["tax"] - h["pat"]),
        ):
            if abs(diff) > (max(TOL, 0.05 * abs(h["pat"])) if what.startswith("PBT") else TOL):
                issues.append(f"{fy(d)}: {what} off by {diff:,.1f} cr")
        if h["other_ca"] < -TOL:
            issues.append(f"{fy(d)}: receivables + inventory + cash exceed Other Assets")
    d, h = co["dates"], co["hist"][-1]
    issues += [f"{fy(b)}: period is {(b - a).days} days (year-end change?), its growth/ratios are distorted"
               for a, b in zip(d, d[1:]) if not 330 <= (b - a).days <= 400]
    gap = (h["net_block"] + h["cwip"] + h["investments"] + h["other_assets"]
           - h["share_cap"] - h["reserves"] - h["borrowings"] - h["other_liab"])
    if abs(gap) > TOL:
        issues.append(f"{fy(d[-1])}: asset and liability lines differ by {gap:,.1f} cr; "
                      "first projected year's cash roll-forward check absorbs this (one-time)")
    if (s := share_gap(co)) is not None:
        issues.append(f"{fy(d[-1])}: {s['text']}")
    return issues


SHARE_GAP = 0.05  # share count from market cap / price against share capital / face value: more = shares issued since


def share_gap(co):
    """{gap, now, then, text} when today's share count (market cap / price) is more than 5% above the last balance
    sheet's (share capital / face value): an IPO or QIP since, so net debt misses the proceeds. Else None. Only upward:
    share capital that holds more than the listed shares (JSW Steel: 305 cr against 245 cr shares) would read as a
    buyback. ponytail: preference or partly paid capital can still hide a real issue."""
    m, h = co.get("market") or {}, co["hist"][-1]
    fv, now = m.get("face_value"), m.get("shares")
    if not fv or not now or h["share_cap"] <= 0:
        return None
    then = h["share_cap"] / fv
    gap = now / then - 1
    if gap <= SHARE_GAP:
        return None
    return {"gap": gap, "now": now, "then": then,
            "text": f"share count up {gap:.0%} since the last balance sheet ({now:,.1f} cr from market cap / price, "
                    f"{then:,.1f} cr from share capital / face value): shares issued since (IPO or QIP?), so net debt "
                    "misses the proceeds and our value per share reads low"}


# ---------- XBRL filings (NSE/BSE financial results, Ind AS) ----------

# Element local name -> std key, matched without the namespace (the exchanges' results taxonomy in-bse-fin and the Ind
# AS taxonomies share these names). Money is converted to Rs crore by unit (_xbrl_scale); EPS and face value stay in Rs
# per share. Keys shared with parse_export mean the same line: revenue, interest (finance cost), dep, pbt, tax, pat
# (owners' share), receivables, inventory, cash, share_cap, cfo/cfi/cff.
XBRL_PL = {
    "RevenueFromOperations": "revenue", "OtherIncome": "other_income", "Income": "total_income",
    "CostOfMaterialsConsumed": "materials", "PurchasesOfStockInTrade": "purchases",
    "ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTrade": "inventory_change",
    "EmployeeBenefitExpense": "employee", "FinanceCosts": "interest",
    "DepreciationDepletionAndAmortisationExpense": "dep", "DepreciationAndAmortisationExpense": "dep",
    "OtherExpenses": "other_exp", "Expenses": "total_exp",
    "ProfitBeforeExceptionalItemsAndTax": "pbt_before_exceptional", "ExceptionalItemsBeforeTax": "exceptional",
    "ProfitBeforeTax": "pbt", "CurrentTax": "current_tax", "DeferredTax": "deferred_tax", "TaxExpense": "tax",
    "ProfitLossForPeriodFromContinuingOperations": "profit_continuing",
    "ProfitLossFromDiscontinuedOperationsAfterTax": "profit_discontinued",
    "ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod": "associates",
    "ProfitLossForPeriod": "profit", "ProfitOrLossAttributableToOwnersOfParent": "pat",
    "ProfitOrLossAttributableToNonControllingInterests": "minority",
    "OtherComprehensiveIncomeNetOfTaxes": "oci", "ComprehensiveIncomeForThePeriod": "comprehensive_income",
    "BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations": "eps_basic",
    "DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations": "eps_diluted",
    "PaidUpValueOfEquityShareCapital": "paid_up_capital", "FaceValueOfEquityShareCapital": "face_value",
}
XBRL_BS = {  # positions at the period end
    "PropertyPlantAndEquipment": "ppe", "CapitalWorkInProgress": "cwip", "InvestmentProperty": "investment_property",
    "Goodwill": "goodwill", "OtherIntangibleAssets": "intangibles", "IntangibleAssetsUnderDevelopment": "intangibles_wip",
    "InvestmentsAccountedForUsingEquityMethod": "investments_equity_method",
    "NoncurrentInvestments": "investments_noncurrent", "CurrentInvestments": "investments_current",
    "TradeReceivablesCurrent": "receivables", "TradeReceivablesNoncurrent": "receivables_noncurrent",
    "Inventories": "inventory", "CashAndCashEquivalents": "cash",
    "BankBalanceOtherThanCashAndCashEquivalents": "bank_balances",
    "LoansCurrent": "loans_current", "LoansNoncurrent": "loans_noncurrent",
    "OtherCurrentFinancialAssets": "other_fin_assets_current", "OtherNoncurrentFinancialAssets": "other_fin_assets_noncurrent",
    "DeferredTaxAssetsNet": "deferred_tax_assets", "CurrentTaxAssets": "current_tax_assets",
    "OtherCurrentAssets": "other_current_assets", "OtherNoncurrentAssets": "other_noncurrent_assets",
    "CurrentAssets": "current_assets", "NoncurrentAssets": "noncurrent_assets", "Assets": "total_assets",
    "EquityShareCapital": "share_cap", "OtherEquity": "other_equity",
    "EquityAttributableToOwnersOfParent": "equity_parent", "NonControllingInterest": "nci", "Equity": "equity",
    "BorrowingsNoncurrent": "borrowings_noncurrent", "BorrowingsCurrent": "borrowings_current",
    # lease liabilities as named in the Ind AS / IFRS taxonomies; the 2020 results taxonomy has no such element: its
    # filings put leases in other financial liabilities, as a described breakdown line from FY2025 (parse_xbrl reads it)
    "LeaseLiabilitiesNoncurrent": "lease_noncurrent", "LeaseLiabilitiesCurrent": "lease_current",
    "NoncurrentLeaseLiabilities": "lease_noncurrent", "CurrentLeaseLiabilities": "lease_current",
    "TradePayablesCurrent": "payables", "TradePayablesNoncurrent": "payables_noncurrent",
    "OtherCurrentFinancialLiabilities": "other_fin_liabilities_current",
    "OtherNoncurrentFinancialLiabilities": "other_fin_liabilities_noncurrent",
    "ProvisionsCurrent": "provisions_current", "ProvisionsNoncurrent": "provisions_noncurrent",
    "DeferredTaxLiabilitiesNet": "deferred_tax_liabilities", "CurrentTaxLiabilities": "current_tax_liabilities",
    "OtherCurrentLiabilities": "other_current_liabilities", "OtherNoncurrentLiabilities": "other_noncurrent_liabilities",
    "CurrentLiabilities": "current_liabilities", "NoncurrentLiabilities": "noncurrent_liabilities",
    "Liabilities": "total_liabilities", "EquityAndLiabilities": "equity_and_liabilities",
}
XBRL_CF = {  # the financial year to date (results filings carry it for the half year and the year)
    "CashFlowsFromUsedInOperatingActivities": "cfo", "CashFlowsFromUsedInInvestingActivities": "cfi",
    "CashFlowsFromUsedInFinancingActivities": "cff",
    "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities": "purchase_ppe",
    "ProceedsFromSalesOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities": "proceeds_ppe",
    "PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities": "purchase_intangibles",
    "ProceedsFromSalesOfIntangibleAssetsClassifiedAsInvestingActivities": "proceeds_intangibles",
    "IncomeTaxesPaidRefundClassifiedAsOperatingActivities": "taxes_paid",
    "ProceedsFromBorrowingsClassifiedAsFinancingActivities": "borrowings_raised",
    "RepaymentsOfBorrowingsClassifiedAsFinancingActivities": "borrowings_repaid",
    "PaymentsOfLeaseLiabilitiesClassifiedAsFinancingActivities": "lease_payments",
    "PaymentsOfFinanceLeaseLiabilitiesClassifiedAsFinancingActivities": "lease_payments",  # JSW FY2024 files this one
    "DividendsPaidClassifiedAsFinancingActivities": "dividends_paid",
    "InterestPaidClassifiedAsFinancingActivities": "interest_paid",
    "ProceedsFromIssuingSharesClassifiedAsFinancingActivities": "shares_issued",
    "PaymentsToAcquireOrRedeemEntitysShares": "buyback",
    "IncreaseDecreaseInCashAndCashEquivalents": "net_change_cash",
}
XBRL_TAGS = {**XBRL_PL, **XBRL_BS, **XBRL_CF}
# Results filings from FY2025 break other financial liabilities into described lines (typed-dimension contexts); the
# ones described as lease liabilities are leases (TCS FY2026: 9,453 + 1,830 = 11,283 cr, the export's borrowings exactly)
LEASE_LINES = {"OtherNoncurrentFinancialLiabilities": "lease_noncurrent", "OtherCurrentFinancialLiabilities": "lease_current"}
LEASE_DESC = {"DescriptionOfOtherNoncurrentFinancialLiabilities", "DescriptionOfOtherCurrentFinancialLiabilities"}
LEASE_RE = re.compile(r"\blease liabilit", re.I)
XBRL_STOCKS, XBRL_CASH = set(XBRL_BS.values()) | {"borrowings"}, set(XBRL_CF.values())
XBRL_PER_SHARE = {"eps_basic", "eps_diluted", "face_value"}
XBRL_MAX_UNMAPPED = 300  # a results filing has ~50 non-zero unknown facts; a full annual-report instance can have 1000s
_XI = "{http://www.xbrl.org/2003/instance}"


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _iso(s):
    try:
        return datetime.strptime(s.strip()[:10], "%Y-%m-%d")
    except (AttributeError, ValueError):
        return None


def _xbrl_scale(unit_id, measures):
    """Rs crore per unit of a fact, or ("share", 1.0) for Rs per share; None when the unit isn't money."""
    m = " ".join([unit_id, *measures]).lower()
    if "inr" in m and "share" in m:
        return "share", 1.0
    for word, f in (("lakh", 0.01), ("crore", 1.0), ("inr", 1e-7)):  # XBRL money is in rupees unless the unit says
        if word in m:
            return "money", f
    return None


def _cr(v):
    """Rs crore with Indian grouping, negatives in brackets: Rs 1,64,177 cr, Rs (124) cr."""
    return f"Rs {_inr(v)} cr"


def parse_xbrl(file, mappings=None, company=None):
    """An NSE/BSE financial-results XBRL instance -> {company, period_start, period_end, kind, consolidated, facts
    {std key: Rs crore}, unmapped [{tag, value, context}], checks [{name, pass, detail}]}. Deterministic: XBRL_TAGS
    plus the user's approved `mappings` {tag: std key}. With `company` (parse_export's shape) revenue and net profit
    are compared with the export's figure for the same year or quarter; a mismatch is reported, never blocking.

    The period is the annual one if the filing has it (a Q4 filing carries the quarter and the year), else the shortest
    (the quarter, not the year to date). The exchanges' "_WEB" files reference contexts (OneD, FourD, OneI) they never
    define, and some define FourD with the quarter's dates; so each context's DateOfStart/EndOfReportingPeriod facts
    win over its <period>. Balance-sheet facts are taken at the period end, cash flow only for an annual filing."""
    data = file if isinstance(file, bytes) else file.read() if hasattr(file, "read") else Path(file).read_bytes()
    if data[:4] == b"PK\x03\x04":
        raise ValueError("That's a zip (or Excel) file. Unzip the download and attach the .xml inside.")
    # no DTDs at all: entity expansion (XML bombs) and external entities need one; NUL = UTF-16/32, which could hide it
    if b"\0" in data:
        raise ValueError("That isn't a UTF-8 XML file (a PDF, Excel or UTF-16 file?). Attach the XBRL .xml from NSE or BSE.")
    if re.search(rb"<!(DOCTYPE|ENTITY)", data, re.I):
        raise ValueError("This XML file declares a DTD or entities, which XBRL filings never need, so it wasn't read.")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise ValueError(f"Not a well-formed XML file ({e}).") from None
    if _local(root.tag) != "xbrl":
        raise ValueError("Not an XBRL instance (the file's root isn't <xbrl>). Download the XBRL link of a financial "
                         "results filing from NSE or BSE.")
    tags = {**(mappings or {}), **XBRL_TAGS}  # an approved mapping never overrides a standard element
    blank = lambda: {"start": None, "end": None, "instant": False, "basis": None, "dims": False}  # noqa: E731
    ctx, units = {}, {}
    for c in root.iter(_XI + "context"):
        p, x = blank(), c.find(_XI + "period")
        if x is not None:
            inst = _iso(x.findtext(_XI + "instant"))
            p["start"], p["end"], p["instant"] = _iso(x.findtext(_XI + "startDate")), inst or _iso(x.findtext(_XI + "endDate")), bool(inst)
        for m in c.iter():
            if _local(m.tag) in ("explicitMember", "typedMember"):
                member = (m.text or "").strip().split(":")[-1]
                if member in ("ConsolidatedMember", "StandaloneMember", "SeparateMember"):
                    p["basis"] = member == "ConsolidatedMember"
                else:
                    p["dims"] = True  # a breakdown (segment, expense detail): not a statement line
        ctx[c.get("id")] = p
    for u in root.iter(_XI + "unit"):
        units[u.get("id")] = [(m.text or "").strip() for m in u.iter(_XI + "measure")]

    name = symbol = nature = None
    nums, checks, desc = [], [], {}  # desc: breakdown context -> its line's description ("Lease liabilities")
    check = lambda n, ok, d: checks.append({"name": n, "pass": ok, "detail": d})  # noqa: E731
    for e in root:
        cid = e.get("contextRef")
        if cid is None:
            continue
        c = ctx.setdefault(cid, blank())  # referenced but never defined (the _WEB files)
        tag, text = _local(e.tag), (e.text or "").strip()
        if tag == "DateOfStartOfReportingPeriod":
            c["start"] = _iso(text) or c["start"]
        elif tag == "DateOfEndOfReportingPeriod":
            c["end"], c["instant"] = _iso(text) or c["end"], False
        elif tag in ("NameOfTheCompany", "NameOfCompany"):
            name = name or text
        elif tag == "Symbol":
            symbol = symbol or text
        elif tag == "NatureOfReportStandaloneConsolidated":
            nature = nature or text.lower()
        elif tag in LEASE_DESC:
            desc[cid] = text
        elif e.get("unitRef") and e.get("{http://www.w3.org/2001/XMLSchema-instance}nil") != "true":
            try:
                v = float(text)
                if not math.isfinite(v):
                    raise ValueError
            except ValueError:
                check(f"{tag} is a number", False, f"{text[:40]!r} in context {cid} isn't a number; skipped")
                continue
            nums.append((tag, cid, v, e.get("unitRef")))

    consolidated = (not nature.startswith(("standalone", "non"))) if nature else None
    if consolidated is None and any(c["basis"] is not None for c in ctx.values()):
        consolidated = any(c["basis"] for c in ctx.values())
    days = lambda s: (s[1] - s[0]).days + 1  # noqa: E731
    spans = {(ctx[cid]["start"], ctx[cid]["end"]) for tag, cid, _, _ in nums
             if tags.get(tag) in ("revenue", "pbt", "profit") and not ctx[cid]["dims"] and ctx[cid]["start"]
             and ctx[cid]["end"] and ctx[cid]["end"] > ctx[cid]["start"]}
    if spans:  # the year if there is one, else the shortest period; the latest when comparatives are included
        start, end = max(spans, key=lambda s: (days(s) >= 350, s[1], -days(s)))
        n = days((start, end))
        kind = "quarter" if 80 <= n <= 100 else "half" if 170 <= n <= 190 else "annual" if 350 <= n <= 380 else "other"
    else:
        start, kind = None, "other"
        end = max((c["end"] for c in ctx.values() if c["end"]), default=None)

    # an approved mapping's value goes aside and only fills a line no standard element gives (or gives as 0), so a
    # mapping approved on one filing never overrides a standard number in another
    facts, seen, mapped, mseen, unmapped, skipped_cash = {}, {}, {}, {}, {}, False
    leases = {}
    for tag, cid, v, uid in nums:
        c, key = ctx[cid], tags.get(tag)
        if consolidated is not None and c["basis"] not in (None, consolidated):
            continue
        if c["dims"]:  # a breakdown line: only the lease liabilities inside other financial liabilities are kept
            if (tag in LEASE_LINES and LEASE_RE.search(desc.get(cid, "")) and c["end"] in (None, end)
                    and (s := _xbrl_scale(uid, units.get(uid, []))) and s[0] == "money"):
                leases[LEASE_LINES[tag]] = leases.get(LEASE_LINES[tag], 0.0) + round(v * s[1], 6)
            continue
        if key in XBRL_CASH:
            if kind != "annual":
                skipped_cash = True
                continue
            ok = c["end"] in (None, end)  # the _WEB files tag the year's cash flow with the quarter's context
        elif key in XBRL_STOCKS or (key is None and c["instant"]):
            ok = c["end"] in (None, end)  # undefined instant contexts (OneI) are the filing's balance sheet date
        else:
            ok = (c["start"], c["end"]) == (start, end)
        if not ok:
            continue
        scale = _xbrl_scale(uid, units.get(uid, []))
        if key and scale and (scale[0] == "share") == (key in XBRL_PER_SHARE):
            val = round(v * scale[1], 6)
            fs, sn = (facts, seen) if tag in XBRL_TAGS else (mapped, mseen)
            if key not in fs or (fs[key] == 0 and val):  # a filed 0 gives way to another tag's number
                fs[key], sn[key] = val, tag
            elif val and abs(fs[key] - val) > 1e-6:  # the same line twice with different numbers: keep the first, say so
                check(f"One value for {key}", False, f"{sn[key]} = {fs[key]:,.2f} and {tag} = {val:,.2f} "
                      f"(context {cid}); kept the first")
        elif v and len(unmapped) < XBRL_MAX_UNMAPPED:  # ponytail: zeros (most of a results filing) aren't listed
            val = round(v * scale[1], 6) if scale else v
            unit = {"money": "Rs crore", "share": "Rs per share"}[scale[0]] if scale else uid
            unmapped.setdefault((tag, val), {"tag": tag, "value": val, "unit": unit,
                                             "context": cid if scale else f"{cid} ({uid})"})

    for k, v in leases.items():
        facts.setdefault(k, v)  # a filing that tags its leases directly keeps its own number
    for k, v in mapped.items():
        if not facts.get(k):
            facts[k], seen[k] = v, mseen[k]
        elif abs(facts[k] - v) > 1e-6:
            check(f"One value for {k}", None, f"The standard {seen[k]} = {facts[k]:,.2f} is kept over the approved "
                  f"mapping {mseen[k]} = {v:,.2f}.")
    for k in ("purchase_ppe", "purchase_intangibles"):
        if facts.get(k, 0.0) < 0:  # some filers enter the outflow as negative; a purchase is a size
            facts[k] = -facts[k]
            check(f"Sign of {k}", None, f"The filing gives {k} as {_cr(-facts[k])}; a purchase is an outflow, so it "
                  f"is taken as {_cr(facts[k])}.")
    if facts.get("profit") and not facts.get("pat") and not facts.get("minority"):
        if "pat" in facts:  # Hindalco Dec 2021 files 0 for both owners and minority
            check("Owners' share of profit", None, "The filing leaves the owners / minority split at 0, so net "
                  "profit is taken as the whole period's profit.")
        facts["pat"] = facts["profit"]  # standalone results have no owners / minority split
    if "borrowings_noncurrent" in facts or "borrowings_current" in facts:
        facts["borrowings"] = facts.get("borrowings_noncurrent", 0.0) + facts.get("borrowings_current", 0.0)

    f = facts
    if "pbt" in f and "tax" in f and ("profit_continuing" in f or "profit" in f):
        want = f["pbt"] - f["tax"]
        got = f["profit_continuing"] if "profit_continuing" in f else (
            f["profit"] - f.get("associates", 0.0) - f.get("profit_discontinued", 0.0))
        check("PBT less tax = profit", abs(want - got) <= max(1.0, 0.001 * abs(want)),
              f"PBT {_cr(f['pbt'])} less tax {_cr(f['tax'])} is {_cr(want)}; the filing's profit is {_cr(got)}")
    if "total_assets" in f and "equity_and_liabilities" in f:
        gap = f["total_assets"] - f["equity_and_liabilities"]
        check("Assets = equity and liabilities", abs(gap) <= 1.0,
              f"Assets {_cr(f['total_assets'])}, equity and liabilities {_cr(f['equity_and_liabilities'])}")
    if skipped_cash:
        check("Cash flow", None, "The cash flow in this filing is for the year to date, not this period, so it isn't kept.")
    if company and end:
        checks += _xbrl_ties(f, kind, end, company, consolidated)
    if not f:
        check("Statement lines found", False, "No profit and loss or balance sheet lines this app knows were found.")
    return {"company": name or symbol or next((x.text.strip() for x in root.iter(_XI + "identifier") if x.text), None),
            "period_start": start and start.date().isoformat(), "period_end": end and end.date().isoformat(),
            "kind": kind, "consolidated": consolidated, "facts": facts, "unmapped": list(unmapped.values()),
            "checks": checks}


def _xbrl_ties(f, kind, end, co, consolidated):
    """Revenue and net profit against the export's reported year (or quarter) ending on the same day, within 1%."""
    q = co.get("quarters")
    if kind == "annual":
        dates, rows, label = co["dates"], co["hist"], fy(end)
        pairs = (("revenue", "revenue", "Revenue"), ("pat", "pat", "Net profit"))
    elif kind == "quarter" and q:
        dates, label = q["dates"], f"the {end:%b %Y} quarter"
        rows = [{k: v[i] for k, v in q["rows"].items()} for i in range(len(dates))]
        pairs = (("revenue", "sales", "Revenue"), ("pat", "net_profit", "Net profit"))
    else:
        dates = []
    i = next((i for i, d in enumerate(dates) if d.date() == end.date()), None)
    if i is None:
        what = {"annual": "year", "quarter": "quarter"}.get(kind, "period")
        return [{"name": "Ties to the export", "pass": None,
                 "detail": f"The Excel file has no {what} ending {end:%d %b %Y} to compare with."}]
    out = []
    for fk, sk, line in pairs:
        a, b = f.get(fk), rows[i].get(sk)
        if a is None or b is None:
            continue
        ok = abs(a - b) <= 0.01 * abs(b)
        detail = f"Filing {_cr(a)}, export {_cr(b)}"
        if not ok:
            detail += f": {abs(a / b - 1) * 100:.1f}% apart" if b else ": the export has 0"
            if consolidated is False:
                detail += ". This filing is standalone; the export is usually consolidated."
        out.append({"name": f"{line} for {label} matches the export", "pass": ok, "detail": detail})
    return out


# ---------- a company from its filings (fetch by ticker, 5.1) ----------

# How an annual results filing's lines add up to the export's Data Sheet lines, so a company built from filings reads
# like an export: the export's borrowings include lease liabilities and its other liabilities everything else (payables,
# provisions, minority interest); its net block includes goodwill and intangibles; cash includes bank balances.
FILING_SUMS = {"borrowings": ("borrowings_noncurrent", "borrowings_current", "lease_noncurrent", "lease_current"),
               "net_block": ("ppe", "investment_property", "goodwill", "intangibles"),
               "cwip": ("cwip", "intangibles_wip"),
               "investments": ("investments_noncurrent", "investments_current", "investments_equity_method"),
               "cash": ("cash", "bank_balances")}
FILING_NEEDS = ("revenue", "pbt", "pat", "share_cap", "total_assets")  # without these a filing doesn't make a year


def filing_row(x):
    """An annual filing's facts -> one Data Sheet year (parse_export's lines), or None when a needed line is missing
    (a results filing without a balance sheet). Lines a filing leaves out are 0, as in an Excel export."""
    if any(x.get(k) is None for k in FILING_NEEDS):
        return None
    g = lambda k: x.get(k) or 0.0  # noqa: E731
    r = {k: sum(g(p) for p in parts) for k, parts in FILING_SUMS.items()}
    reserves = (x["other_equity"] if "other_equity" in x else
                x["equity_parent"] - x["share_cap"] if "equity_parent" in x else g("equity") - g("nci") - x["share_cap"])
    total = x.get("equity_and_liabilities") or x["total_assets"]
    tax = x["tax"] if "tax" in x else g("current_tax") + g("deferred_tax")
    cogs = ("materials", "purchases", "inventory_change")
    # exceptional items go into other income, as in the export (TCS FY2026: its 4,526 cr charge makes EBITDA
    # 72,398 both ways), so EBITDA is the operating line and one-off detection sees them in other income
    r.update(revenue=x["revenue"], other_income=g("other_income") + g("exceptional"), dep=g("dep"), interest=g("interest"), pbt=x["pbt"],
             tax=tax, pat=x["pat"],
             # ponytail: dividends paid in the year (last year's final + this year's interim), not the export's
             # "declared for the year"; payout defaults lag a changed dividend policy by a year
             dividend=abs(g("dividends_paid")),
             share_cap=x["share_cap"], reserves=reserves, total_liab=total, total_assets=x["total_assets"],
             receivables=g("receivables"), inventory=g("inventory"),
             cfo=x.get("cfo"), cfi=x.get("cfi"), cff=x.get("cff"),
             cogs=sum(g(k) for k in cogs) if any(k in x for k in cogs) else None)
    r["other_liab"] = total - r["share_cap"] - r["reserves"] - r["borrowings"]
    r["other_assets"] = r["total_assets"] - r["net_block"] - r["cwip"] - r["investments"]
    return r


Q_FROM = (("sales", "revenue"), ("other_income", "other_income"), ("depreciation", "dep"), ("interest", "interest"),
          ("pbt", "pbt"), ("tax", "tax"), ("net_profit", "pat"))


def _q_row(x):
    """Quarter lines (QUARTERS keys) from a filing's P&L facts; operating profit by the annual EBITDA rule."""
    q = {k: x.get(f) for k, f in Q_FROM}
    if q["other_income"] is not None and x.get("exceptional"):
        q["other_income"] += x["exceptional"]  # as filing_row does
    if q["tax"] is None and ("current_tax" in x or "deferred_tax" in x):
        q["tax"] = x.get("current_tax", 0.0) + x.get("deferred_tax", 0.0)
    te = x.get("total_exp")
    q["expenses"] = None if te is None else te - (x.get("interest") or 0.0) - (x.get("dep") or 0.0)
    parts = [q[k] for k in ("pbt", "interest", "depreciation", "other_income")]
    q["op_profit"] = None if None in parts else parts[0] + parts[1] + parts[2] - parts[3]
    return q


def filing_quarters(filings, keep=12):
    """company["quarters"] from quarter filings (one basis), the last `keep` quarters. A fourth quarter is filed inside
    the annual results, so it is the year less its first three quarters, when all three were filed; else left out."""
    rows = {}
    for f in filings:
        end = _iso(f.get("period_end") or "")
        if end and f.get("kind") == "quarter":
            rows[end] = _q_row(f["facts"])
    for f in filings:
        end = _iso(f.get("period_end") or "")
        if not end or f.get("kind") != "annual" or end in rows:
            continue
        y = _q_row(f["facts"])
        firsts = [rows.get(e) for e in (_month_end(end, -9), _month_end(end, -6), _month_end(end, -3))]
        if all(firsts):
            rows[end] = {k: None if y[k] is None or any(q[k] is None for q in firsts) else y[k] - sum(q[k] for q in firsts)
                         for k in y}
    dates = sorted(rows)
    i = len(dates) - 1  # the trailing run of consecutive quarters: a gap (a fourth quarter we can't work out) ends it
    while i > 0 and 80 <= (dates[i] - dates[i - 1]).days <= 100:
        i -= 1
    dates = dates[i:][-keep:]
    if not dates:
        return None
    return {"dates": dates, "rows": {k: [rows[d][k] for d in dates] for k in QUARTERS.values()}}


def _month_end(d, months):
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return datetime(y, m, calendar.monthrange(y, m)[1])


def from_filings(name, annual, quarters=(), market=None, least=2):
    """A company in parse_export's shape from annual results filings (one basis, any order), by rules: one year per
    filing that has a balance sheet, oldest first. -> (company, skipped [{year, why}]). ValueError with fewer than
    `least` years (1 when an export company fills the rest, see merge), or for a lender."""
    years, skipped = {}, []
    for f in annual:
        end = _iso(f.get("period_end") or "")
        if not end or f.get("kind") != "annual":
            continue
        r = filing_row(f["facts"])
        if r is None:
            skipped.append({"year": fy(end), "why": "the filing has no balance sheet or profit lines"})
        else:
            years[end] = r
    dates = sorted(years)
    if len(dates) < max(least, 1):
        raise ValueError(("No annual results filing in XBRL has a balance sheet" if not dates else
                          "Only one year of annual results with a balance sheet was filed in XBRL")
                         + "; the model needs at least two years.")
    hist = _derive([years[d] for d in dates])
    _not_lender(hist)
    m = market or {}
    return ({"name": name, "dates": dates, "hist": hist, "quarters": filing_quarters(quarters),
             "market": {"price": m.get("price"), "shares": m.get("shares"), "face_value": m.get("face_value"),
                        "price_hist": [None] * len(dates), "shares_hist": [None] * len(dates)}}, skipped)


MERGE_LINES = (("revenue", "Revenue"), ("pat", "Net profit"), ("total_assets", "Total assets"),
               ("borrowings", "Borrowings"), ("cfo", "Cash from operations"))
MERGE_TOL = 0.01  # filings and the export a year apart by more than 1%: reported, the filing's number kept
RESTATED = (0.05, 0.02)  # a year off by 5%+ on revenue or profit while the next year agrees within 2%: restated later


def _line(h, k, filing):
    """A merge line; net profit like for like: the export's is PBT less tax, a filing's pat is the owners' share."""
    return h["pbt"] - h["tax"] if k == "pat" and filing else h.get(k)


def merge(filed, other):
    """Years from filings win; an export company (an Excel export, or another source of its shape) fills only the years the
    filings don't have (older ones: NSE's XBRL starts in 2018-19). -> (company, filled years, mismatches [{year, line,
    filing, export}] on the years both have, notes). Years the other company itself took from filings aren't compared
    (they'd be compared with themselves). Where the export's borrowings are higher, the difference is lease liabilities
    the filing keeps in other liabilities: moved into borrowings (the balance sheet still ties) and said. A year off on
    revenue or profit while the next year agrees was restated later: said, the filed number kept. Market data and
    quarters come from the filings' side when it has them."""
    have = {d.date(): i for i, d in enumerate(filed["dates"])}
    rows = {d: h for d, h in zip(filed["dates"], filed["hist"])}
    whence = ((other.get("source") or {}).get("years")) or {}
    filled, mism, notes, gaps, pair = [], [], [], {}, {}
    for d, h in zip(other["dates"], other["hist"]):
        if d.date() not in have:
            rows[d] = h
            filled.append(fy(d))
            continue
        fd = filed["dates"][have[d.date()]]
        if whence.get(fy(d)) == RESTATED_USE:  # you chose the restated year (use_restated): a refresh keeps it
            rows[fd] = h
            continue
        f = rows[fd] = dict(rows[fd])
        pair[fy(d)] = (f, h)
        extra = h["borrowings"] - f["borrowings"]  # also for a refreshed fetched year: it keeps its leases
        if extra > MERGE_TOL * max(h["borrowings"], 1.0):
            f["borrowings"] += extra
            f["other_liab"] -= extra
            notes.append(f"{fy(d)}: Rs {_inr(extra)} cr of borrowings taken from the export (lease liabilities, which "
                         "this year’s filing keeps in other liabilities).")
        if whence.get(fy(d), EXPORT) != EXPORT:
            continue
        gaps[fy(d)] = {}
        for k, line in MERGE_LINES:
            a, b = _line(f, k, True), _line(h, k, False)
            if a is not None and b is not None:
                gaps[fy(d)][k] = (a, b)
                if abs(a - b) > MERGE_TOL * max(abs(b), 1.0):
                    mism.append({"year": fy(d), "line": line, "filing": a, "export": b})
    restated = []
    for y, g in gaps.items():
        nxt = gaps.get(f"FY{int(y[2:]) + 1}", {})
        off = lambda gg, k, tol: k in gg and abs(gg[k][0] - gg[k][1]) > tol * max(abs(gg[k][1]), 1.0)  # noqa: E731
        if (any(off(g, k, RESTATED[0]) for k in ("revenue", "pat"))
                and all(k in nxt and not off(nxt, k, RESTATED[1]) for k in ("revenue", "pat"))):
            k = "revenue" if off(g, "revenue", RESTATED[0]) else "pat"
            what = "revenue" if k == "revenue" else "net profit"
            notes.append(f"{y} looks restated later: {what} as first filed Rs {_inr(g[k][0])} cr, Rs {_inr(g[k][1])} cr "
                         f"on the export’s restated basis. Growth and margins from {y} into FY{int(y[2:]) + 1} aren’t like "
                         f"for like, and the defaults from history carry that break.")
            # both rows kept, so the year can be switched in one click (use_restated) and back
            restated.append({"year": y, "line": what, "filed": g[k][0], "restated": g[k][1], "used": False,
                             "filed_row": pair[y][0], "row": pair[y][1]})
    dates = sorted(rows)
    sm, fm = other.get("market") or {}, filed.get("market") or {}
    at = {d.date(): i for i, d in enumerate(other["dates"])}
    hist_of = lambda key: [(sm.get(key) or [None] * len(other["dates"]))[at[d.date()]] if d.date() in at else None  # noqa: E731
                           for d in dates]
    market = {"price": fm.get("price") or sm.get("price"), "shares": fm.get("shares") or sm.get("shares"),
              "face_value": fm.get("face_value") or sm.get("face_value"),
              "price_hist": hist_of("price_hist"), "shares_hist": hist_of("shares_hist")}
    co = {"name": filed["name"], "dates": dates, "hist": _derive([rows[d] for d in dates]), "market": market,
          "quarters": filed.get("quarters") or other.get("quarters"), "restated": restated}
    return co, sorted(filled), mism, notes


RESTATED_USE = "Excel export (restated)"  # Company.source years: a filed year you switched to its restated numbers


def use_restated(co, year, use=True):
    """The company with `year` switched to the restated numbers merge() kept (use=True) or back to the filed ones: the
    whole year's row from that side, the history derived again (the next year's capex and returns read it), and the
    source saying so. ValueError when no restated numbers were kept for that year."""
    src = co.get("source") or {}
    e = next((x for x in src.get("restated") or [] if x.get("year") == year), None)
    lab = labels(co["dates"])
    if e is None or year not in lab:
        raise ValueError(f"No restated numbers are kept for {year}. Add years from an Excel export on the Overview to "
                         "compare them again.")
    rows = [dict(h) for h in co["hist"]]
    rows[lab.index(year)] = dict(e["row"] if use else e["filed_row"])
    return {**co, "hist": _derive(rows),
            "source": {**src, "years": {**(src.get("years") or {}), year: RESTATED_USE if use else "NSE filing"},
                       "restated": [dict(x, used=use) if x is e else x for x in src["restated"]]}}


# For checking a proposed mapping of a leftover tag (mapping_checks): the lines a tag may map to, with a one-line
# meaning for the prompt (the standard element's name in words); lines that are never negative; totals and their parts.
XBRL_KEYS = {}
for _tag, _key in XBRL_TAGS.items():
    XBRL_KEYS.setdefault(_key, re.sub(r"(?<=[a-z])(?=[A-Z])", " ", _tag).lower())
XBRL_NONNEG = (set(XBRL_BS.values()) - {"other_equity", "equity_parent", "equity", "nci"}) | {
    "revenue", "total_income", "materials", "purchases", "employee", "interest", "dep", "other_exp", "total_exp",
    "paid_up_capital", "face_value", "purchase_ppe", "purchase_intangibles"}
XBRL_TOTALS = {"total_exp": ("materials", "purchases", "inventory_change", "employee", "interest", "dep", "other_exp"),
               "total_income": ("revenue", "other_income"), "total_assets": ("noncurrent_assets", "current_assets"),
               "total_liabilities": ("noncurrent_liabilities", "current_liabilities"),
               "equity_parent": ("share_cap", "other_equity")}
TIE_TOL = 0.01  # a total and its parts agree within 1% (at least Rs 1 crore)


def unmapped_rows(filing):
    """A filing's unmapped entries that have the shape parse_xbrl writes; a hand-edited or damaged entry is left out
    (it then reads as "not among this filing's unmapped tags") instead of crashing the rules."""
    return [x for x in filing.get("unmapped") or [] if isinstance(x, dict) and isinstance(x.get("tag"), str)
            and isinstance(x.get("value"), (int, float)) and not isinstance(x["value"], bool) and math.isfinite(x["value"])]


def mapping_checks(filing, tag, key, others=()):
    """Rule checks on mapping a filing's unmapped `tag` to std `key` -> (value, unit, checks). `others` = the keys
    other proposals in the same batch map to (two tags onto one line would count it twice)."""
    checks = []
    check = lambda n, ok, d: checks.append({"name": n, "pass": ok, "detail": d})  # noqa: E731
    rows = unmapped_rows(filing)
    u = next((x for x in rows if x["tag"] == tag), None)
    known = key in XBRL_KEYS
    check("A line this app knows", known, f"{key} ({XBRL_KEYS[key]})" if known else
          f"{key!r} isn't one of this app's lines, so the mapping can't be used.")
    amt = lambda x: _cr(x) if abs(x) >= 100 else f"{x:.2f}"  # noqa: E731  Indian grouping for amounts
    check("The tag is in this filing", u is not None, f"{tag} = {amt(u['value'])}, context {u.get('context')}" if u else
          f"{tag} isn't among this filing's unmapped tags.")
    if u and len({x["value"] for x in rows if x["tag"] == tag}) > 1:
        check("One value", False, f"{tag} has more than one value in this filing (e.g. opening and closing), so "
              "a rule can't tell which is the line.")
    if not (known and u):
        return (u and u["value"]), (u and u.get("unit")), checks
    v, unit, facts = u["value"], u.get("unit"), filing.get("facts", {})
    want = "Rs per share" if key in XBRL_PER_SHARE else "Rs crore"
    if unit is None:  # a filing attached before units were kept
        check("Unit", None, f"The filing's unit wasn't kept; attach the file again to check it is {want}.")
    else:
        check("Unit", unit == want, f"The tag is in {unit}; {key} is in {want}.")
    if facts.get(key):
        check("Not counted twice", False, f"The filing already gives {key} = {amt(facts[key])} from a standard tag.")
    elif key in others:
        check("Not counted twice", False, f"Another tag in this batch is also proposed as {key}.")
    else:
        check("Not counted twice", True, f"The filing has no other {key}" + (" (its standard tag is 0)." if key in facts else "."))
    if key in XBRL_NONNEG and v < 0:
        check("Sign", False, f"{key} is never negative; the tag is {amt(v)}.")
    big = max((abs(facts.get(k, 0.0)) for k in ("revenue", "total_income", "total_assets")), default=0.0)
    if want == "Rs crore" and unit in (None, want) and big:
        check("Size", abs(v) <= 10 * big, f"{_cr(v)} against the filing's largest total {_cr(big)} (at most 10 times).")
    for total, parts in XBRL_TOTALS.items():
        if key != total and key not in parts:
            continue
        after = {**facts, key: v}
        if total not in after or not any(p in after for p in parts):
            continue
        tie = lambda x: abs(sum(x.get(p, 0.0) for p in parts) - x[total]) <= max(1.0, TIE_TOL * abs(x[total]))  # noqa: E731
        s = sum(after.get(p, 0.0) for p in parts)
        detail = f"{', '.join(parts)} add up to {_cr(s)}; {total} is {_cr(after[total])}"
        if tie(after):
            check(f"{total} still ties", True, detail + ".")
        elif total in facts and tie(facts):
            check(f"{total} still ties", False, detail + ": they tied before this mapping.")
        else:
            check(f"{total} ties", None, detail + ": they didn't tie before either; other lines may be missing.")
    return v, unit, checks


def on_cogs(hist):
    """Inventory and payable days run on COGS when it is at least COGS_MIN of revenue in each of the last three
    reported years (makers and traders); otherwise on revenue (TCS: Rs 14 cr of materials on Rs 1,64,177 cr; Coal
    India; exports without the row). Only the export's rows decide it, so a saved model never changes basis."""
    return all((h.get("cogs") or 0.0) >= COGS_MIN * h["revenue"] > 0 for h in hist[-3:])


def _debt(r):
    """Borrowings plus lease liabilities: what the valuation bridge, interest and the debt ratios use."""
    return r["borrowings"] + (r.get("lease") or 0.0)


def upgrade(co, filings=(), capex=None, out=None):
    """The company with what attached annual XBRL filings add, by rules (no AI): a copy, co is untouched. A filing is
    used for the reported year ending on its period end when its revenue is within 1% of the export's (consolidated
    first, one filing per year). Per year it can add
      - trade payables, split out of the export's Other Liabilities (which include them);
      - lease liabilities, split out of the export's Borrowings (which include them): the filing's lease elements, or
        else the export's borrowings less the filing's borrowings (results filings carry no lease element; JSW Steel
        FY2024: 87,984 - 85,575 = 2,409 = the export's own lease line);
      - capex = purchase of PP&E + intangibles from its cash flow, instead of the net block change.
    `capex` {year label: Rs crore} is cash-flow capex read from annual reports and approved by the user (3.3); it
    fills years no filing gives. Totals never change, so the balance sheet still ties. `out` {revenue, ebitda, reason}
    (Rs crore): a business sold, deconsolidated or moved to a JV, approved by the user; the last reported year keeps its
    reported lines and carries it as revenue_out / ebitda_out, which project() and the margin default take out of the
    base (move_out()). Adds "sources": {basis, drivers {key: text}, notes}."""
    hist, lab = [dict(h) for h in co["hist"]], labels(co["dates"])
    at = {d.date(): i for i, d in enumerate(co["dates"])}
    used, notes, done = {"payables": [], "lease": [], "capex": [], "capex_ar": [], "moved_out": []}, [], set()
    for f in sorted(filings, key=lambda f: f.get("consolidated") is not True):
        end = _iso(f.get("period_end") or "")
        i = at.get(end.date()) if end else None
        if f.get("kind") == "annual" and i is None:
            notes.append(f"{f.get('file') or 'filing'} isn't used: its year to {end:%d %b %Y} isn't one of the "
                         "reported years in this Excel file." if end else "An annual filing without a period end isn't used.")
        if f.get("kind") != "annual" or i is None or i in done:
            continue
        x, h, y, name = f["facts"], hist[i], lab[i], f.get("file") or "filing"
        rev = x.get("revenue")
        if rev is None or abs(rev - h["revenue"]) > 0.01 * abs(h["revenue"]):
            notes.append(f"{name} isn't used: its {y} revenue ({'none' if rev is None else _cr(rev)}) is more than 1% "
                         f"from the export's {_cr(h['revenue'])}.")
            continue
        done.add(i)
        if "payables" in x or "payables_noncurrent" in x:
            pay = x.get("payables", 0.0) + x.get("payables_noncurrent", 0.0)
            if 0 <= pay <= h["other_liab"] + TOL:
                h["payables"], h["other_liab"] = pay, h["other_liab"] - pay
                used["payables"].append(y)
            else:
                notes.append(f"{y} trade payables {_cr(pay)} exceed the export's other liabilities "
                             f"{_cr(h['other_liab'])}, so they stay in other liabilities.")
        tagged = "lease_current" in x or "lease_noncurrent" in x
        lease = (x.get("lease_current", 0.0) + x.get("lease_noncurrent", 0.0) if tagged
                 else h["borrowings"] - x["borrowings"] if "borrowings" in x else None)
        # ponytail: the difference also holds preference capital and other debt the export files under borrowings
        # (JSW FY2023: 2,281 vs 2,011 of leases); fine for a debt-like split, a tagged lease line wins when present
        if lease is not None and lease > TOL:
            if lease <= h["borrowings"] + TOL:
                h["lease"], h["borrowings"] = lease, max(0.0, h["borrowings"] - lease)
                used["lease"].append(y)
            else:
                notes.append(f"{y} lease liabilities {_cr(lease)} exceed the export's borrowings, so they aren't split out.")
        elif lease is not None and lease < -TOL:
            notes.append(f"{y}: the filing's borrowings {_cr(x['borrowings'])} exceed the export's "
                         f"{_cr(h['borrowings'])}, so no lease liabilities are split out.")
        if "purchase_ppe" in x:
            # abs: a filing saved before parse_xbrl flipped a negative purchase still gives a size
            h["capex_cf"] = h["capex"] = abs(x["purchase_ppe"]) + abs(x.get("purchase_intangibles", 0.0))
            h["fcf"] = None if h["cfo"] is None else h["cfo"] - h["capex"]
            used["capex"].append(y)
    for y, v in (capex or {}).items():
        if y in lab and y not in used["capex"]:  # an XBRL cash flow for the year wins (the approval checked they agree)
            h = hist[lab.index(y)]
            h["capex_cf"] = h["capex"] = v
            h["fcf"] = None if h["cfo"] is None else h["cfo"] - v
            used["capex_ar"].append(y)
    for i, h in enumerate(hist):
        h.update(returns(h, hist[i - 1] if i else None))
    moved = move_out(hist[-1], out)
    if isinstance(moved, str):
        notes.append(moved)
    elif moved:
        hist[-1].update(moved)
        used["moved_out"].append(lab[-1])
    used = {k: sorted(v, key=lab.index) for k, v in used.items()}
    src = _sources(co["hist"], used, notes)
    if moved and not isinstance(moved, str):
        src["moved_out"] = {**moved, "year": lab[-1], "reason": out.get("reason") or "", "from": out.get("from") or ""}
        src["drivers"]["growth"] = (f"Grows from {lab[-1]} revenue less Rs {_inr(moved['revenue_out'])} cr moved out "
                                    f"({out.get('reason') or 'a business that left the group'})")
        src["drivers"]["ebitda_margin"] = (f"3-yr ratio of sums, with {lab[-1]} less the Rs {_inr(moved['revenue_out'])} cr "
                                           f"of revenue and Rs {_inr(moved['ebitda_out'])} cr of EBITDA moved out")
    return {**co, "hist": hist, "sources": src}


def move_out(last, out):
    """{revenue_out, ebitda_out} to take out of the base year `last`, or a sentence why `out` can't be used, or None
    without one. Rules: revenue moved out is above zero and below the year's revenue; EBITDA moved out is at most
    the revenue moved out either way (a loss-making business leaving lifts the margin). EBITDA not given = the
    year's own margin, so the margin default doesn't move."""
    if not out:
        return None
    r, e = out.get("revenue"), out.get("ebitda")
    if not isinstance(r, (int, float)) or not math.isfinite(r) or not 0 < r < last["revenue"]:
        return (f"The business moved out isn't used: its revenue must be above zero and below the year's "
                f"Rs {_inr(last['revenue'])} cr.")
    if e is None:
        e = r * last["ebitda"] / last["revenue"]
    if not isinstance(e, (int, float)) or not math.isfinite(e) or abs(e) > r:
        return "The business moved out isn't used: its EBITDA can't be larger than its revenue."
    return {"revenue_out": float(r), "ebitda_out": float(e)}


def _sources(hist, used, notes):
    """Where each upgraded driver's history comes from, as short sentences for the UI and the Excel note."""
    cogs, ys = on_cogs(hist), lambda k: ", ".join(used[k])  # noqa: E731
    base = "COGS" if cogs else "revenue"
    why = ("on COGS (raw material cost less change in inventory), from the export" if cogs else
           "on revenue: COGS is under 10% of revenue" if any(h.get("cogs") is not None for h in hist) else
           "on revenue: this file has no raw material cost")
    d = {"dio": why[0].upper() + why[1:],
         "dpo": (f"Trade payables from XBRL {ys('payables')}, on {base}" if used["payables"] else
                 "No trade payables in the attached annual filings; they stay in other liabilities"),
         "capex_pct": ("Cash-flow capex from " + " and ".join(x for x in (
             used["capex"] and f"XBRL {ys('capex')}", used["capex_ar"] and f"the annual report {ys('capex_ar')} (approved)") if x)
             + "; other years from the net block change" if used["capex"] or used["capex_ar"]
             else "From the net block change, from the export")}
    if cogs:
        d["cogs_pct"] = "From the export (raw material cost less change in inventory)"
    if used["payables"]:
        d["ol_pct"] = f"Excludes trade payables in {ys('payables')} (XBRL)"
    if used["lease"]:
        d["lease"] = f"Lease liabilities from XBRL {ys('lease')}, split out of borrowings; held flat, counted as debt"
    return {"basis": base.lower(), "drivers": d, "notes": notes, "used": used}


def fy(d, projected=False):
    return f"FY{d.year}{'E' if projected else ''}"


def labels(dates):
    """fy() for each reported year, unique: a year-end change can put two year ends in one calendar year
    (Mar 2019, Dec 2019), so a repeat gets its month ("FY2019 Dec"). Exclusions and flags key on these."""
    out = [fy(d) for d in dates]
    return [x if out.index(x) == i else f"{x} {d:%b}" for i, (x, d) in enumerate(zip(out, dates))]


# ---------- ratios & projection ----------

def _div(a, b):
    return a / b if b else None


def returns(c, p=None):
    """Return ratios for year c; p = previous year (None: averages fall back to closing balances).
    Blank (None) when the denominator is <= ~0: a ratio on negative equity or EBITDA means nothing.
    EBIT = PBT + interest; debt = borrowings + lease liabilities. Mirrored by _returns_formulas()."""
    avg = lambda f: (f(c) + f(p)) / 2 if p else f(c)  # noqa: E731
    eq = lambda r: r["share_cap"] + r["reserves"]  # noqa: E731
    # 1e-6 cr = Rs 10: debt faded to zero leaves float residue (1e-14) that would read as 1e18x cover
    pos = lambda num, den: num / den if den > 1e-6 else None  # noqa: E731
    ebit = c["pbt"] + c["interest"]
    return {
        "roe": pos(c["pat"], avg(eq)),
        "roce": pos(ebit, avg(lambda r: eq(r) + _debt(r))),
        "asset_turnover": pos(c["revenue"], avg(lambda r: r["total_assets"])),
        "nd_ebitda": pos(_debt(c) - c["cash"] - c["investments"], c["ebitda"]),
        "int_cover": pos(ebit, c["interest"]),
    }


def ratios(hist):
    out, cogs = [], on_cogs(hist)
    for i, h in enumerate(hist):
        p, rev = (hist[i - 1] if i else None), h["revenue"]
        base = h.get("cogs") if cogs else rev  # inventory and payable days
        out.append({
            "growth": _div(rev, p["revenue"]) - 1 if p and p["revenue"] else None,
            "ebitda_margin": _div(h["ebitda"], rev),
            "oi_pct": _div(h["other_income"], rev),
            "dep_pct": _div(h["dep"], p["net_block"]) if p else None,
            "int_rate": _div(h["interest"], _debt(p)) if p else None,
            "tax_rate": _div(h["tax"], h["pbt"]),
            "mi_pct": _div(h["pat"] - (h["pbt"] - h["tax"]), h["pbt"] - h["tax"]),
            "payout": _div(h["dividend"], h["pat"]),
            "capex_pct": _div(h["capex"], rev) if p else None,
            "dso": _div(h["receivables"] * 365, rev),
            "cogs_pct": None if h.get("cogs") is None else _div(h["cogs"], rev),
            "dio": _div(h["inventory"] * 365, base),
            "dpo": None if h.get("payables") is None else _div(h["payables"] * 365, base),
            "oca_pct": _div(h["other_ca"], rev),
            "ol_pct": _div(h["other_liab"], rev),
            "debt_change": _debt(h) - _debt(p) if p else None,
        })
    return out


def _ros(pairs, default=0.0):
    """Ratio of sums over (numerator, denominator) pairs, skipping zero denominators."""
    pairs = [(n, d) for n, d in pairs if d]
    den = sum(d for _, d in pairs)
    return sum(n for n, _ in pairs) / den if den > 0 else default


def default_assumptions(hist, years=3, exclude=(), labels=None):
    """Weighted (ratio-of-sums) averages over the last `years` reported years; growth is the plain CAGR over
    the last `years`. Borrowings held flat. Years in `exclude` (labels like "FY2020", matched against
    `labels`) are skipped and the window reaches further back instead, except for growth: no one-off flag is
    about revenue, and dropping a year from a growth window skews it (a dip year's rebound stays in)."""
    keep = [i for i in range(len(hist)) if labels is None or labels[i] not in exclude]
    if len(keep) < 2:
        raise ValueError("Keep at least two reported years in the defaults.")
    r = ratios(hist)
    w = [hist[i] for i in keep[-years:]]
    pw = [(hist[i - 1], hist[i]) for i in keep if i][-years:]  # (prev, cur); prev may be excluded: its closing balances are fine
    per_rev = lambda f: _ros((f(h), h["revenue"]) for h in w)  # noqa: E731
    base = (lambda h: h.get("cogs") or 0.0) if on_cogs(hist) else (lambda h: h["revenue"])  # noqa: E731
    # payables split out of other liabilities in some years only: both use just those years, or the split one
    # would count them twice (in payable days and again in another year's other liabilities)
    pay = [h for h in w if h.get("payables") is not None]
    oi = [r[i]["oi_pct"] for i in keep[-years:] if r[i]["oi_pct"] is not None]
    gp = [(hist[i - 1], hist[i]) for i in range(1, len(hist))][-years:]  # every year: growth ignores exclusions
    pos = all(p["revenue"] > 0 and h["revenue"] > 0 for p, h in gp)
    return {
        # the product telescopes to the plain CAGR
        "growth": math.prod(h["revenue"] / p["revenue"] for p, h in gp) ** (1 / len(gp)) - 1 if gp and pos else 0.0,
        # pro forma: a base year with a business moved out (move_out) counts without it
        "ebitda_margin": _ros((h["ebitda"] - (h.get("ebitda_out") or 0.0), h["revenue"] - (h.get("revenue_out") or 0.0))
                              for h in w),
        # ponytail: other income includes exceptional items (the export's way, and filing_row's); the median drops a one-off year
        "oi_pct": max(statistics.median(oi), 0.0) if oi else 0.0,
        "dep_pct": _ros((h["dep"], p["net_block"]) for p, h in pw),
        # ponytail: capped for every source; a company with almost no borrowings still pays interest (on bill
        # discounting, or leases a filing before FY2025 leaves in other liabilities), and Rs 400 cr on Rs 13 cr read
        # as 3,000%
        "int_rate": min(_ros((h["interest"], _debt(p)) for p, h in pw), INT_CAP),
        # ponytail: loss years make raw tax ratios meaningless
        "tax_rate": min(max(_ros(((h["tax"], h["pbt"]) for h in w), 0.25), 0.0), 0.5),
        "payout": min(max(_ros((h["dividend"], h["pat"]) for h in w), 0.0), 1.0),
        # ponytail: clamp, loss years make the ratio flip sign
        "mi_pct": min(max(_ros((h["pat"] - (h["pbt"] - h["tax"]), h["pbt"] - h["tax"]) for h in w), -0.5), 0.5),
        # ponytail: capex is the cash-flow figure where a filing gives it, else the net block change (where
        # acquisitions show up as capex); the median skips a merger year
        "capex_pct": statistics.median([h["capex"] / h["revenue"] for _, h in pw if h["revenue"]] or [0.0]),
        "dso": per_rev(lambda h: h["receivables"] * 365),
        "cogs_pct": per_rev(lambda h: h.get("cogs") or 0.0),
        "dio": _ros((h["inventory"] * 365, base(h)) for h in w),
        "dpo": _ros((h["payables"] * 365, base(h)) for h in pay),
        "oca_pct": per_rev(lambda h: h["other_ca"]),
        "ol_pct": _ros((h["other_liab"], h["revenue"]) for h in pay or w),
        "debt_change": 0.0,
    }


INT_CAP = 0.25  # the interest rate default never reads above 25%

FAST = 0.15  # last-3-year revenue CAGR above this: a young or booming company, so the defaults fade instead of holding flat


def default_ends(hist, d, g=None):
    """{driver: end value} that turn the flat defaults `d` into fades for a fast grower (3-year CAGR above FAST), else {}.
    Growth ends at half its pace, at least terminal growth + 3 pp; capex ends at what keeps the net block in step with
    revenue at that end growth (depreciation plus growth, on the last year's net block / revenue), never above its start.
    ponytail: one fade shape for every fast grower; a cited guidance proposal (4.2) replaces it where documents say more."""
    if d["growth"] <= FAST or hist[-1]["revenue"] <= 0:
        return {}
    g = VALUATION["g"] if g is None else g
    end = max(g + 0.03, d["growth"] / 2)
    k = hist[-1]["net_block"] / hist[-1]["revenue"]
    return {"growth": end, "capex_pct": min(d["capex_pct"], max(k * (d["dep_pct"] + end) / (1 + end), 0.0))}


# (ratios() key, words for the sentence, unit, floor). The floor is the smallest gap from typical worth a flag,
# so a very steady metric (TCS tax 22-26%) can't flag a 2 pp wobble just because its spread is tiny.
ONEOFF = (("oi_pct", "other income", " of revenue", 0.02), ("tax_rate", "tax rate", "", 0.10),
          ("capex_pct", "capex", " of revenue", 0.05), ("ebitda_margin", "EBITDA margin", "", 0.05),
          ("mi_pct", "minority share of profit", "", 0.05))


def _pct(v):
    s = f"{v:.1%}"
    return "0.0%" if s == "-0.0%" else s


def detect_oneoffs(hist, labels, min_years=4):
    """Years where a metric is more than 2 sigma from the company's own median: [{year, metric, value, typical,
    note}]. sigma = 1.4826 x MAD, so the odd years themselves don't widen the band. A metric needs `min_years`
    values; tax rate skips loss years (a rate on a loss means nothing); minority share only counts profit years that
    split profit (the export's years read 0, which would make every filed year look unusual)."""
    r, out = ratios(hist), []
    for key, what, unit, floor in ONEOFF:
        pts = [(labels[i], x[key]) for i, x in enumerate(r)
               if x[key] is not None and (key != "tax_rate" or hist[i]["pbt"] > 0) and (key != "mi_pct" or abs(x[key]) > 1e-9 and hist[i]["pbt"] - hist[i]["tax"] > 0)]
        if len(pts) < min_years:
            continue
        typical = statistics.median(v for _, v in pts)
        band = max(2 * 1.4826 * statistics.median(abs(v - typical) for _, v in pts), floor)
        # ponytail: 25% anchors the Indian new-regime tax rate; a year nearer it than the median is the normal one
        # (a tax holiday ending, pre-IPO disallowances). Old-regime (34.9%) firms may leave a low year unflagged.
        out += [{"year": y, "metric": key, "value": v, "typical": typical,
                 "note": f"{y} {what} was {_pct(v)}{unit}, typically {_pct(typical)}"}
                for y, v in pts if abs(v - typical) > band
                and (key != "tax_rate" or abs(v - 0.25) >= abs(typical - 0.25))]
    for o in out:  # a low capex year read from a falling net block is a disposal or transfer, not low spending
        i = labels.index(o["year"])
        if o["metric"] == "capex_pct" and o["value"] < o["typical"] and capex_unreliable(hist, i):
            o["unreliable"] = True
            o["note"] = (f"{o['year']} capex from the net-block change is unreliable: the net block fell, so a disposal or "
                         "transfer may hide the spending; attach the annual report and read its capex note (cash flow)")
    return sorted(out, key=lambda o: labels.index(o["year"]))


def capex_unreliable(hist, i):
    """Capex for year i is the net-block derivation (no cash-flow figure) and the net block fell that year."""
    return i > 0 and hist[i].get("capex_cf") is None and hist[i]["net_block"] < hist[i - 1]["net_block"]


def _inr(v, dp=0):
    """Indian digit grouping, negatives in brackets: 267021 -> "2,67,021", -124 -> "(124)"."""
    t = f"{abs(v):.{dp}f}"
    whole, _, frac = t.partition(".")
    if len(whole) > 3:
        whole = re.sub(r"(\d)(?=(\d\d)+$)", r"\1,", whole[:-3]) + "," + whole[-3:]
    t = whole + ("." + frac if frac else "")
    return f"({t})" if round(v, dp) < 0 else t


def _median_before(xs, years=3):
    """Median of the `years` values before the last one (None skipped); None with fewer than 2."""
    prev = [x for x in xs[-years - 1:-1] if x is not None]
    return statistics.median(prev) if len(prev) >= 2 else None


def key_numbers(hist, labels):
    """What the numbers say: each measure's last reported year against the median of the three years before it.
    [{key, label, kind, year, last, typical}]; cash conversion = CFO / net profit (blank when profit <= 0, or in a year
    flagged for one-off other income: a gain in profit that was never operating cash)."""
    r = ratios(hist)
    gain = {o["year"] for o in detect_oneoffs(hist, labels) if o["metric"] == "oi_pct"}
    series = (("growth", "Revenue growth", "pct", [x["growth"] for x in r]),
              ("ebitda_margin", "EBITDA margin", "pct", [x["ebitda_margin"] for x in r]),
              ("pat_growth", "Net profit growth", "pct",
               [None, *(_div(h["pat"], p["pat"]) - 1 if p["pat"] > 0 and h["pat"] is not None else None
                        for p, h in zip(hist, hist[1:]))]),
              ("roce", "ROCE", "pct", [h.get("roce") for h in hist]),
              ("cash_conversion", "Cash conversion (CFO / profit)", "x",
               [h["cfo"] / h["pat"] if h.get("cfo") is not None and h["pat"] > 0 and y not in gain else None
                for y, h in zip(labels, hist)]),
              ("dso", "Receivable days", "days", [x["dso"] for x in r]))
    return [{"key": k, "label": lab, "kind": kind, "year": labels[-1], "last": xs[-1], "typical": _median_before(xs)}
            for k, lab, kind, xs in series]


# ---------- forensic radar (4.3): rules detect, AI only explains (words, cited) ----------

# Thresholds as (high, medium[, low]). ponytail: one set of cut-offs for every sector; per-sector bands once peers
# exist (5.2). Each line says why the cut-off sits there.
CASH_CONV = (0.5, 0.8)  # CFO / net profit summed over the window: under 0.8 a fifth of profit isn't cash; under 0.5, half
DAYS_UP = (0.5, 0.2, 0.1)  # receivable / inventory days up this share over 3 years = the book growing faster than sales
DAYS_MIN = (30, 10, 5)  # ... and by at least these many days, so a 10-day book can't flag on a 2-day wobble
CWIP_SHARE = (0.6, 0.3, 0.15)  # capital WIP / net block, only while rising: plant not yet earning (or costs parked there)
OI_SHARE = (0.5, 0.3, 0.2)
OI_SWING = 0.01  # other income / revenue more than 1 pp off its 3-year median (or negative): exceptional items folded in  # other income / PBT over 3 years: profit that doesn't come from the business
TAX_SWING = (0.20, 0.10)  # max - min effective tax rate over the last 5 profit years; a steady payer moves 2-3 pp
DEBT_PACE = (0.25, 0.10)  # debt CAGR minus EBITDA CAGR, 3 years, when debt is up 30%+ and net debt > 0: borrowing outruns earnings
DEBT_UP = 0.30  # ... the 30%: smaller rises are ordinary refinancing noise
ND_EBITDA = (3.5, 2.0)  # net debt / EBITDA: lenders' usual comfort is under 2-2.5x; past 3.5x covenants bite
COVER = (1.5, 3.0)  # EBIT / interest: under 3x one bad year hurts; under 1.5x profit barely pays the interest
NWC_DRIFT = (0.15, 0.08, 0.04)  # working capital / revenue, last year against the median of the 3 before (pp of revenue)
M_SCORE = (-1.78, -2.22)  # Beneish (1999): above -1.78 most manipulators in his sample; -2.22 the stricter screen
NOTE_SHARE = (0.25, 0.10)  # contingent liabilities / net worth and related-party transactions / revenue
PLEDGE = (0.50, 0.20, 0.0)  # promoter shares pledged: any pledge is worth knowing, a fifth is a risk, half is a margin call away
SEVERITY = ("high", "medium", "low", "ok", "not_checked")
OPINIONS = ("unmodified", "qualified", "adverse", "disclaimer")  # an auditor's opinion (ai checks the note against these)


def _sev(x, cuts, below=False):
    """'high' | 'medium' | 'low' | 'ok' for x against (high, medium[, low]) cut-offs; below=True when less is worse."""
    for s, c in zip(SEVERITY, cuts):
        if (x < c) if below else (x > c):
            return s
    return "ok"


def _worst(*s):
    return min(s, key=SEVERITY.index)


def _cagr(a, b, n):
    return (b / a) ** (1 / n) - 1 if a > 0 and b > 0 else None


def _note(notes, topic):
    """The latest approved annual-report note for the topic ("ar:<topic>:FY2025") as (year, note), or (None, None)."""
    k = max((k for k, v in (notes or {}).items() if k.startswith(f"ar:{topic}:") and isinstance(v, dict)),
            default=None, key=lambda k: k.split(":")[2])
    return (k.split(":")[2], notes[k]) if k else (None, None)


def _mscore(p, h, cogs):
    """Beneish M-score (8 variables) for year h against p, approximated from what the export has. (score, parts, notes)
    or None when cash flow, receivables or a positive margin is missing. Weights are Beneish's 1999 ones."""
    if h.get("cfo") is None or not (p["revenue"] > 0 and h["revenue"] > 0 and p["receivables"] > 0 and h["total_assets"] > 0
                                    and p["total_assets"] > 0):
        return None
    gm = ((lambda r: (r["revenue"] - r["cogs"]) / r["revenue"]) if cogs and p.get("cogs") is not None and h.get("cogs") is not None
          else (lambda r: r["ebitda"] / r["revenue"]))
    if gm(p) <= 0 or gm(h) <= 0:
        return None
    lev = lambda r: (_debt(r) + r["other_liab"] + (r.get("payables") or 0.0)) / r["total_assets"]  # noqa: E731
    dr = lambda r: r["dep"] / (r["dep"] + r["net_block"]) if r["dep"] + r["net_block"] > 0 else None  # noqa: E731
    parts = {"DSRI": (h["receivables"] / h["revenue"]) / (p["receivables"] / p["revenue"]), "GMI": gm(p) / gm(h),
             "AQI": 1.0, "SGI": h["revenue"] / p["revenue"],
             "DEPI": dr(p) / dr(h) if dr(p) and dr(h) else 1.0, "SGAI": 1.0,
             "LVGI": lev(h) / lev(p) if lev(p) > 0 else 1.0, "TATA": (h["pat"] - h["cfo"]) / h["total_assets"]}
    w = {"DSRI": 0.92, "GMI": 0.528, "AQI": 0.404, "SGI": 0.892, "DEPI": 0.115, "SGAI": -0.172, "TATA": 4.679, "LVGI": -0.327}
    approx = ["asset quality (AQI) set to 1: the export doesn't split current from non-current assets",
              "SG&A (SGAI) set to 1: not read from the export"]
    if not (cogs and p.get("cogs") is not None and h.get("cogs") is not None):
        approx.insert(0, "gross margin (GMI) read as EBITDA margin: no cost of goods in the export")
    approx.append("leverage (LVGI) uses borrowings + other liabilities, current and long-term together")
    return -4.84 + sum(w[k] * v for k, v in parts.items()), parts, approx


def forensic(hist, labels, notes=None):
    """The forensic radar: [{key, title, severity (high | medium | low | ok | not_checked), value, threshold, years,
    fact, detail, rule, needs}], in a fixed order. Rules only, on the reported years (and approved annual-report
    notes); `needs` = "annual report" when a filing would let the check run. AI never touches these numbers."""
    out, n, last, y = [], len(hist), hist[-1], labels[-1]
    span = lambda k: f"{labels[-min(k, n)]}–{y}"  # noqa: E731

    def add(key, title, sev, value, threshold, years, fact, detail, rule, needs=None):
        out.append({"key": key, "title": title, "severity": sev, "value": value, "threshold": threshold,
                    "years": years, "fact": fact, "detail": detail, "rule": rule, "needs": needs})

    # cash conversion, 3 and 5 years
    for k, key in ((3, "cash"), (5, "cash5")):
        rule = (f"Operating cash flow / net profit, summed over the last {k} years: below {CASH_CONV[1]}x medium, "
                f"{CASH_CONV[0]}x high")
        title = f"Cash conversion, {k} yrs"
        w = hist[-k:]
        if n < k or any(h.get("cfo") is None for h in w):
            add(key, title, "not_checked", None, CASH_CONV[1], labels[-k:], f"Needs {k} years of cash flow",
                f"The export has fewer than {k} years of operating cash flow.", rule)
            continue
        pat = sum(h["pat"] for h in w)
        if pat <= 0:
            add(key, title, "not_checked", None, CASH_CONV[1], labels[-k:], "Losses over the window",
                f"Net profit over {span(k)} adds up to a loss, so cash conversion means nothing.", rule)
            continue
        cc = sum(h["cfo"] for h in w) / pat
        add(key, title, _sev(cc, CASH_CONV, below=True), cc, CASH_CONV[1], labels[-k:], f"CFO {cc:.2f}x profit, {span(k)}",
            f"Over {span(k)} operating cash flow was {cc:.2f}x net profit: Rs {_inr(100 * cc)} of cash for every Rs 100 "
            f"of profit.", rule)

    # receivable and inventory days stretching faster than revenue (3 years)
    cogs = on_cogs(hist)
    for key, title, line, base, what in (("dso", "Receivable days", "receivables", "revenue", "revenue"),
                                         ("dio", "Inventory days", "inventory", "cogs" if cogs else "revenue",
                                          "cost of goods" if cogs else "revenue")):
        rule = (f"{line.capitalize()} x 365 / {what}, against 3 years before: up {DAYS_UP[2]:.0%} and {DAYS_MIN[2]} days low, "
                f"{DAYS_UP[1]:.0%} and {DAYS_MIN[1]} days medium, {DAYS_UP[0]:.0%} and {DAYS_MIN[0]} days high")
        if n < 4:
            add(key, title, "not_checked", None, None, labels, "Needs 4 years", "Needs four reported years.", rule)
            continue
        p = hist[-4]
        b0, b1 = p.get(base) or 0.0, last.get(base) or 0.0
        if b0 <= 0 or b1 <= 0:
            add(key, title, "not_checked", None, None, [labels[-4], y], f"No {what} to divide by", f"No {what} in {labels[-4]} or {y}.", rule)
            continue
        d0, d1 = p[line] * 365 / b0, last[line] * 365 / b1
        if d0 < DAYS_MIN[2] and d1 < DAYS_MIN[2]:
            add(key, title, "ok", d1, None, [labels[-4], y], f"{d1:.0f} days in {y}",
                f"Under {DAYS_MIN[2]} days of {what} in {labels[-4]} and {y}: nothing to stretch.", rule)
            continue
        up = d1 / d0 - 1 if d0 > 0 else math.inf
        sev = next((s for s, u, m in zip(SEVERITY, DAYS_UP, DAYS_MIN) if up > u and d1 - d0 > m), "ok")
        g_line, g_base = _cagr(p[line], last[line], 3), _cagr(b0, b1, 3)
        pace = (f" {line.capitalize()} grew {_pct(g_line)} a year, {what} {_pct(g_base)}."
                if g_line is not None and g_base is not None else "")
        add(key, title, sev, d1, d0 * (1 + DAYS_UP[2]), [labels[-4], y], f"{d1:.0f} days, {d0:.0f} in {labels[-4]}",
            f"{title} went from {d0:.0f} in {labels[-4]} to {d1:.0f} in {y}.{pace}", rule)

    # capital work in progress piling up against the net block
    rule = (f"Capital WIP / net block, while higher than 3 years before: above {CWIP_SHARE[2]:.0%} low, "
            f"{CWIP_SHARE[1]:.0%} medium, {CWIP_SHARE[0]:.0%} high")
    if n < 4 or last["net_block"] <= 0 or hist[-4]["net_block"] <= 0:
        add("cwip", "Capital WIP", "not_checked", None, CWIP_SHARE[2], labels[-4:], "Needs 4 years and a net block",
            "Needs four reported years with a positive net block.", rule)
    else:
        r0, r1 = hist[-4]["cwip"] / hist[-4]["net_block"], last["cwip"] / last["net_block"]
        add("cwip", "Capital WIP", _sev(r1, CWIP_SHARE) if r1 > r0 else "ok", r1, CWIP_SHARE[2], [labels[-4], y],
            f"{_pct(r1)} of net block, {_pct(r0)} in {labels[-4]}",
            f"Capital work in progress is Rs {_inr(last['cwip'])} cr, {_pct(r1)} of the net block in {y} against "
            f"{_pct(r0)} in {labels[-4]}" + (": spending that isn't earning yet." if r1 > r0 else ", and falling."), rule)

    # other income as a share of profit before tax
    rule = (f"Other income / profit before tax, summed over 3 years: above {OI_SHARE[2]:.0%} low, {OI_SHARE[1]:.0%} medium, "
            f"{OI_SHARE[0]:.0%} high")
    w = hist[-3:]
    pbt, oi = sum(h["pbt"] for h in w), sum(h["other_income"] for h in w)
    if pbt <= 0:
        add("other_income", "Other income vs PBT", "not_checked", None, OI_SHARE[2], labels[-3:], "PBT not positive",
            f"Profit before tax over {span(3)} adds up to a loss.", rule)
    else:
        sev, fact = _sev(oi / pbt, OI_SHARE), f"{_pct(oi / pbt)} of PBT, {span(3)}"
        txt = (f"Other income was {_pct(oi / pbt)} of profit before tax over {span(3)}"
               + (" (it includes exceptional items)." if oi / pbt > OI_SHARE[2] else "."))
        # other income includes exceptional items (gains and charges), from exports and filings alike: a swing against its median
        # makes reported profit growth that year say little about the business (TCS FY2026: Rs 4,526 cr of charges)
        pct = [h["other_income"] / h["revenue"] if h["revenue"] > 0 else None for h in hist]
        typ = _median_before(pct)
        if pct[-1] is not None and (pct[-1] < 0 or typ is not None and abs(pct[-1] - typ) > OI_SWING):
            sev = _worst(sev, "low")
            fact = f"{_pct(pct[-1])} of revenue in {y}" + (f", median {_pct(typ)}" if typ is not None else "")
            txt += (f" In {y} other income was Rs {_inr(last['other_income'])} cr, {_pct(pct[-1])} of revenue"
                    + (f" against a median of {_pct(typ)} in the 3 years before" if typ is not None else "")
                    + ": other income here includes exceptional items, so this year's reported profit growth "
                    "isn't the business trend (our projection uses the median).")
        add("other_income", "Other income vs PBT", sev, oi / pbt, OI_SHARE[2], labels[-3:], fact, txt,
            rule + f"; or other income negative, or {OI_SWING * 100:.0f} pp of revenue off the median of the 3 years "
            "before: low")

    # tax-rate swings
    rule = f"Effective tax rate (tax / PBT) over the last 5 profit years: a spread over {TAX_SWING[1]:.0%} medium, {TAX_SWING[0]:.0%} high"
    pts = [(labels[i], hist[i]["tax"] / hist[i]["pbt"]) for i in range(max(0, n - 5), n) if hist[i]["pbt"] > 0]
    if len(pts) < 3:
        add("tax", "Tax-rate swing", "not_checked", None, TAX_SWING[1], [p[0] for p in pts], "Needs 3 profit years",
            "Fewer than three profit years in the last five.", rule)
    else:
        lo, hi = min(pts, key=lambda t: t[1]), max(pts, key=lambda t: t[1])
        add("tax", "Tax-rate swing", _sev(hi[1] - lo[1], TAX_SWING), hi[1] - lo[1], TAX_SWING[1], [p[0] for p in pts],
            f"{_pct(lo[1])}–{_pct(hi[1])}, {pts[0][0]}–{pts[-1][0]}",
            f"The effective tax rate ran from {_pct(lo[1])} ({lo[0]}) to {_pct(hi[1])} ({hi[0]}); it was {_pct(pts[-1][1])} "
            f"in {pts[-1][0]}.", rule)

    # debt: level against EBITDA, and pace against EBITDA over 3 years
    nd = _debt(last) - last["cash"] - last["investments"]
    nd_e = nd / last["ebitda"] if last["ebitda"] > 0 else None
    rule = (f"Net debt (borrowings + leases - cash - investments) / EBITDA: over {ND_EBITDA[1]}x medium, {ND_EBITDA[0]}x "
            f"(or negative EBITDA) high; and debt up {DEBT_UP:.0%}+ in 3 years growing {DEBT_PACE[1]:.0%} a year faster "
            f"than EBITDA medium, {DEBT_PACE[0]:.0%} high")
    if nd <= 0:
        add("debt", "Net cash", "ok", nd, ND_EBITDA[1], [y], f"Net cash Rs {_inr(-nd)} cr",
            f"Cash and investments exceed borrowings by Rs {_inr(-nd)} cr in {y}.", rule)
    else:
        sev = "high" if nd_e is None else _sev(nd_e, ND_EBITDA)
        txt = (f"Net debt is Rs {_inr(nd)} cr in {y}, " + (f"{nd_e:.1f}x EBITDA." if nd_e is not None else "with EBITDA negative."))
        if n >= 4:
            d0, e0, d1 = _debt(hist[-4]), hist[-4]["ebitda"], _debt(last)
            gd, ge = _cagr(d0, d1, 3), _cagr(e0, last["ebitda"], 3)
            if d0 <= 0 < d1:  # no pace from nil; borrowing from nothing in 3 years is worth a look on its own
                sev, txt = _worst(sev, "low"), txt + f" Debt rose from nil in {labels[-4]}."
            elif gd is not None and d1 > d0 * (1 + DEBT_UP):
                if last["ebitda"] <= 0:  # already high on the level test
                    txt += f" Debt grew {_pct(gd)} a year since {labels[-4]} while EBITDA fell below zero."
                elif ge is None:  # EBITDA negative then, positive now: no pace to compare, the level test decides
                    txt += f" Debt grew {_pct(gd)} a year since {labels[-4]} while EBITDA turned positive from a loss."
                else:
                    sev = _worst(sev, _sev(gd - ge, DEBT_PACE))
                    txt += f" Debt grew {_pct(gd)} a year since {labels[-4]}, EBITDA {_pct(ge)}."
        add("debt", "Net debt", sev, nd_e, ND_EBITDA[1], [labels[-4] if n >= 4 else y, y],
            f"Rs {_inr(nd)} cr" + (f", {nd_e:.1f}x EBITDA" if nd_e is not None else ", EBITDA negative"), txt, rule)

    # interest cover
    rule = f"EBIT (PBT + interest) / interest: below {COVER[1]:.0f}x medium, {COVER[0]}x high"
    ebit = last["pbt"] + last["interest"]
    if last["interest"] > 0:
        cov = ebit / last["interest"]
        add("cover", "Interest cover", _sev(cov, COVER, below=True), cov, COVER[1], [y], f"{cov:.1f}x in {y}",
            f"Operating profit covered interest {cov:.1f} times in {y}.", rule)
    else:
        add("cover", "Interest cover", "ok", None, COVER[1], [y], f"No interest in {y}", f"No interest expense in {y}.", rule)

    # working capital drifting up against revenue
    rule = (f"(Receivables + inventory + other current assets - other liabilities - payables) / revenue, last year against "
            f"the median of the 3 before: up {NWC_DRIFT[2] * 100:.0f} pp low, {NWC_DRIFT[1] * 100:.0f} pp medium, "
            f"{NWC_DRIFT[0] * 100:.0f} pp high")
    wc = [(h["receivables"] + h["inventory"] + h["other_ca"] - h["other_liab"] - (h.get("payables") or 0.0)) / h["revenue"]
          if h["revenue"] > 0 else None for h in hist]
    typ = _median_before(wc)
    if wc[-1] is None or typ is None:
        add("nwc", "Working capital", "not_checked", None, NWC_DRIFT[2], labels[-4:], "Needs 3 earlier years",
            "Needs the last year and at least two of the three before it.", rule)
    else:
        add("nwc", "Working capital", _sev(wc[-1] - typ, NWC_DRIFT), wc[-1] - typ, NWC_DRIFT[2], labels[-4:],
            f"{_pct(wc[-1])} of revenue, median {_pct(typ)}",
            f"Working capital was {_pct(wc[-1])} of revenue in {y} against a median of {_pct(typ)} in the three years before.",
            rule)

    # Beneish M-score, approximated
    rule = (f"Beneish M-score (8 variables, 1999 weights) on {labels[-2] if n > 1 else y} to {y}: above {M_SCORE[1]} low, above "
            f"{M_SCORE[0]} medium. Approximated from the reported lines, so never high")
    m = _mscore(hist[-2], last, cogs) if n > 1 else None
    if m is None:
        add("mscore", "M-score", "not_checked", None, M_SCORE[0], labels[-2:], "Missing inputs",
            "Needs two years with operating cash flow, receivables and a positive margin.", rule)
    else:
        score, parts, approx = m
        add("mscore", "M-score", _sev(score, (math.inf, *M_SCORE)), score, M_SCORE[0], labels[-2:], f"{score:.2f} for {y}",
            f"The Beneish M-score is {score:.2f} for {y}, approximated from the reported lines (above {M_SCORE[0]} looked like "
            "manipulation in Beneish's sample).", rule)
        out[-1].update(parts=parts, approx=approx)

    # from approved annual-report notes only
    net_worth = last["share_cap"] + last["reserves"]
    for topic, title, base, what in (("contingent", "Contingent liabilities", net_worth, "net worth"),
                                     ("related", "Related parties", last["revenue"], "revenue")):
        rule = (f"Approved annual-report note against {what}: above {NOTE_SHARE[1]:.0%} medium, {NOTE_SHARE[0]:.0%} high"
                + ("; dividends paid to the promoter group are left out (paid pro rata to all shareholders)" if topic == "related" else ""))
        yr, nt = _note(notes, topic)
        rows = [r for r in (nt or {}).get("rows") or [] if isinstance(r, dict) and isinstance(r.get("amount"), (int, float))
                and math.isfinite(r["amount"])]
        if topic == "related":
            rows = [r for r in rows if "dividend" not in str(r.get("label", "")).lower()]
        t = sum(abs(r["amount"]) for r in rows) if rows else (nt or {}).get("total")
        if not isinstance(t, (int, float)) or not math.isfinite(t):
            add(topic, title, "not_checked", None, NOTE_SHARE[1], [], "Needs the annual report",
                f"Attach an annual report and read its {title.lower()} note.", rule, "annual report")
            continue
        if base <= 0:  # the note is there; there's just nothing to scale it by
            add(topic, title, ("high" if t > 0 else "ok") if topic == "contingent" else "not_checked", None,
                NOTE_SHARE[1], [yr], f"Rs {_inr(t)} cr, {what} not positive ({yr})",
                f"{title} in the {yr} annual report add up to Rs {_inr(t)} cr, against a {y} {what} of Rs {_inr(base)} cr "
                "(zero or negative), so it can't be shown as a share.", rule)
            continue
        add(topic, title, _sev(t / base, NOTE_SHARE), t / base, NOTE_SHARE[1], [yr],
            f"Rs {_inr(t)} cr, {_pct(t / base)} of {what} ({yr})",
            f"{title} in the {yr} annual report add up to Rs {_inr(t)} cr, {_pct(t / base)} of {y} {what}.", rule)

    yr, nt = _note(notes, "pledge")
    rule = f"Promoter shares pledged or encumbered (approved annual-report note): any low, over {PLEDGE[1]:.0%} medium, over {PLEDGE[0]:.0%} high"
    pct = (nt or {}).get("total")
    if isinstance(pct, (int, float)) and math.isfinite(pct) and 0 <= pct <= 100:
        add("pledge", "Promoter pledge", _sev(pct / 100, PLEDGE), pct / 100, PLEDGE[1], [yr], f"{_pct(pct / 100)} pledged ({yr})",
            f"The {yr} annual report shows {_pct(pct / 100)} of promoter shares pledged or encumbered.", rule)
    else:
        add("pledge", "Promoter pledge", "not_checked", None, PLEDGE[1], [], "Needs the annual report",
            "Attach an annual report and read its promoter pledge note (shareholding pattern).", rule, "annual report")

    rule = ("Approved auditor's-report note: adverse opinion or disclaimer high, qualified medium, a change of auditor low "
            "(rotation is compulsory every 5-10 years, so a change alone is mild)")
    aud = sorted(((k.split(":")[2], v) for k, v in (notes or {}).items() if k.startswith("ar:auditor:") and isinstance(v, dict)),
                 key=lambda t: t[0])  # every year: the firm across years tells a change
    yr, nt = _note(notes, "auditor")
    if nt:
        op = nt.get("opinion") if nt.get("opinion") in OPINIONS else "unmodified"
        # letters only, "&" read as "and": "B S R & Co. LLP" and "BSR and Co LLP" are one firm.
        # ponytail: "Co." vs "Company" or a trailing "Chartered Accountants" still reads as a change
        firms = [re.sub(r"[^a-z]", "", str(v.get("auditor", "")).lower().replace("&", "and")).removesuffix("llp") for _, v in aud]
        changed = bool(nt.get("changed")) or len(set(f for f in firms if f)) > 1
        sev = {"adverse": "high", "disclaimer": "high", "qualified": "medium"}.get(op, "low" if changed else "ok")
        add("auditor", "Auditor", sev, None, None, [t[0] for t in aud],
            f"{op.capitalize()} opinion{', changed' if changed else ''} ({yr})",
            f"{nt.get('auditor') or 'The auditor'} gave {'an' if op[0] in 'aeiou' else 'a'} {op} opinion on {yr}"
            + (", and the auditor changed." if changed else "."), rule)
    else:
        add("auditor", "Auditor", "not_checked", None, None, [], "Needs the annual report",
            "Attach an annual report and read its auditor's report.", rule, "annual report")
    return out


STRIP = {"high": "red", "medium": "amber", "low": "amber", "ok": "clear", "not_checked": "filing"}


def rule_checks(hist, labels, oneoffs, issues, notes=None, radar=None):
    """The note's rule-check strip: [{id, name, status (red | amber | clear | filing), severity, fact, rule}]; red,
    amber (medium before low), clear, then waiting for a filing. One-off years in the last 3 (red if the latest), data
    issues, then the forensic radar (`radar`, else computed); checks that can't run on this data are left out."""
    out, y = [], labels[-1]
    for o in oneoffs:
        if o["year"] in labels[-3:]:
            name = dict((k, w) for k, w, _, _ in ONEOFF)[o["metric"]]
            out.append({"id": f"oneoff-{o['metric']}-{o['year']}", "name": name[0].upper() + name[1:],
                        "status": "red" if o["year"] == y else "amber", "severity": "high" if o["year"] == y else "medium",
                        "fact": f"Unreliable in {o['year']}: the net block fell" if o.get("unreliable")
                        else f"{_pct(o['value'])} in {o['year']}, typically {_pct(o['typical'])}",
                        "rule": "More than 2 sigma (1.4826 x MAD) from the company's own median, and past a floor"})
    if issues:
        out.append({"id": "data", "name": "Reported data", "status": "amber", "severity": "medium",
                    "fact": f"{len(issues)} issue{'s' * (len(issues) > 1)} in the export",
                    "rule": "Assets = liabilities, lines add to totals, PBT - tax = profit, 12-month years"})
    for f in radar if radar is not None else forensic(hist, labels, notes):
        if f["severity"] != "not_checked" or f["needs"]:
            out.append({"id": f["key"], "name": f["title"], "status": STRIP[f["severity"]], "severity": f["severity"],
                        "fact": f["fact"], "rule": f["rule"]})
    order = {"red": 0, "amber": 1, "clear": 2, "filing": 3}
    return sorted(out, key=lambda c: (order[c["status"]], SEVERITY.index(c["severity"])))


def expand(assumptions, n):
    """{key: {"start", "end"}} -> {key: [n floats]}. end None = flat; otherwise a straight line from start
    (first projected year) to end (last projected year). A bare float is treated as flat."""
    out = {}
    for k, v in assumptions.items():
        s, e = (v, None) if isinstance(v, (int, float)) else (v["start"], v.get("end"))
        # ponytail: with one projected year there is no path to walk, so start wins
        out[k] = [s if e is None or n < 2 else s + (e - s) * t / (n - 1) for t in range(n)]
    return out


def project(hist, a, n=5):
    """Mirrors the Excel formulas in to_excel(); keep both in sync (test_model.py checks this).
    a[key] is a float (every year) or a list of n per-year values (see expand())."""
    out, p, cogs = [], hist[-1], on_cogs(hist)
    for t in range(n):
        y = {k: v[t] if isinstance(v, list) else v for k, v in a.items()}  # this year's inputs
        c = {}
        # a business that left the group (move_out) leaves the base before growth applies
        c["revenue"] = (p["revenue"] - (p.get("revenue_out") or 0.0)) * (1 + y["growth"])
        # memo line: COGS only sets the base for inventory and payable days; EBITDA still comes from the margin
        c["cogs"] = c["revenue"] * y["cogs_pct"]
        wc = c["cogs"] if cogs else c["revenue"]
        c["ebitda"] = c["revenue"] * y["ebitda_margin"]
        c["other_income"] = c["revenue"] * y["oi_pct"]
        c["dep"] = p["net_block"] * y["dep_pct"]
        c["interest"] = _debt(p) * y["int_rate"]
        c["pbt"] = c["ebitda"] + c["other_income"] - c["dep"] - c["interest"]
        c["tax"] = max(0.0, c["pbt"] * y["tax_rate"])
        # ponytail: minority share / associates flow through cash and reserves; no separate minority-interest liability
        c["pat"] = (c["pbt"] - c["tax"]) * (1 + y["mi_pct"])
        c["dividend"] = max(0.0, c["pat"] * y["payout"])
        c["share_cap"] = p["share_cap"]
        c["reserves"] = p["reserves"] + c["pat"] - c["dividend"]
        planned = max(0.0, p["borrowings"] + y["debt_change"])
        c["other_liab"] = c["revenue"] * y["ol_pct"]
        c["payables"] = wc * y["dpo"] / 365
        # ponytail: lease liabilities held at the last reported level (new leases ~ repayments); debt_change moves
        # borrowings only. Upgrade path: a lease driver once leases are a real share of debt in the models used
        c["lease"] = p.get("lease") or 0.0
        c["capex"] = c["revenue"] * y["capex_pct"]
        c["net_block"] = p["net_block"] + c["capex"] - c["dep"]
        c["cwip"], c["investments"] = p["cwip"], p["investments"]
        c["receivables"] = c["revenue"] * y["dso"] / 365
        c["inventory"] = wc * y["dio"] / 365
        c["other_ca"] = c["revenue"] * y["oca_pct"]
        non_cash = sum(c[k] for k in ("net_block", "cwip", "investments", "receivables", "inventory", "other_ca"))
        # revolver: borrow whatever keeps cash >= 0. Interest runs on opening debt, so no circularity.
        # ponytail: never repaid automatically; lower 'Borrowings change' to pay it down
        liab = c["lease"] + c["payables"] + c["other_liab"]
        c["revolver"] = max(0.0, non_cash - (c["share_cap"] + c["reserves"] + planned + liab))
        c["borrowings"] = planned + c["revolver"]
        c["total_liab"] = c["share_cap"] + c["reserves"] + c["borrowings"] + liab
        c["cash"] = c["total_liab"] - non_cash  # balancing item
        c["total_assets"] = non_cash + c["cash"]
        c["cfo"] = (c["pat"] + c["dep"] - sum(c[k] - p[k] for k in ("receivables", "inventory", "other_ca"))
                    + c["other_liab"] - p["other_liab"] + c["payables"] - (p.get("payables") or 0.0))
        c["cfi"] = -c["capex"] - (c["cwip"] - p["cwip"]) - (c["investments"] - p["investments"])
        # lease liabilities are flat (c["lease"] == p["lease"]), so they add nothing to financing cash flow
        c["cff"] = c["borrowings"] - p["borrowings"] + c["share_cap"] - p["share_cap"] - c["dividend"]
        c["net_cf"] = c["cfo"] + c["cfi"] + c["cff"]
        c["fcf"] = c["cfo"] - c["capex"]
        # FCFF for the DCF: operating EBIT only; other income's cash and investments join in the equity bridge.
        # ponytail: a loss year's EBIT gets a tax credit at the full rate; fine while the value rests on profit years
        c["ebit"] = c["ebitda"] - c["dep"]
        c["nopat"] = c["ebit"] * (1 - y["tax_rate"])
        c["nwc"] = _nwc(c)
        c["fcff"] = c["nopat"] + c["dep"] - c["capex"] - (c["nwc"] - _nwc(p))
        c["chk_bs"] = c["total_assets"] - c["total_liab"]
        c["chk_cash"] = p["cash"] + c["net_cf"] - c["cash"]
        c.update(returns(c, p))
        out.append(c)
        p = c
    return out


def _nwc(r):
    return r["receivables"] + r["inventory"] + r["other_ca"] - r["other_liab"] - (r.get("payables") or 0.0)


# The model document's "valuation" inputs. kd None = the base scenario's first-year interest rate;
# price / shares None = the export's market data. Same inputs for all three scenarios.
VALUATION = {"rf": 0.065, "erp": 0.07, "beta": 1.0, "kd": None, "g": 0.05, "mid_year": True,
             "wacc_override": None, "price": None, "shares": None}
MIN_SPREAD = 0.005  # WACC must beat terminal growth by 0.5 pp, or the Gordon value explodes
GRID_WACC = (-0.02, -0.01, 0.0, 0.01, 0.02)  # sensitivity grid steps around WACC (rows) and growth (columns)
GRID_G = (-0.01, -0.005, 0.0, 0.005, 0.01)
# second grid: shifts added to every projected year of revenue growth (rows) and EBITDA margin (columns)
GRID_GROWTH = (-0.04, -0.02, 0.0, 0.02, 0.04)
GRID_MARGIN = (-0.02, -0.01, 0.0, 0.01, 0.02)
IMPLIED_RANGE = (-0.30, 0.80)  # reverse DCF: flat revenue growth searched between these


def _clears(w, g):
    """WACC is positive and at least MIN_SPREAD above g. The ROUND keeps Excel (=ROUND(w-g,10)>=0.005) and Python
    deciding an exact 0.5 pp spread the same way: 0.055-0.05 is 0.00499999... in floats."""
    return w > 0 and round(w - g, 10) >= MIN_SPREAD


def _dcf(fcff, period, w, g):
    """PV of the explicit years and of a Gordon terminal value; None when w doesn't clear g (or isn't positive),
    or the final year's FCFF isn't positive (a perpetuity on a cash burn means nothing).
    The terminal value takes the final year's discount factor: with mid-year flows that is the consistent one."""
    if not _clears(w, g) or fcff[-1] <= 0:
        return None
    df = [(1 + w) ** -p for p in period]
    pv = [f * d for f, d in zip(fcff, df)]
    # ponytail: terminal FCFF carries the final year's reinvestment (capex, NWC at that year's growth); a
    # value-driver TV, NOPAT x (1+g) x (1 - g/RONIC) / (WACC - g), if growth-phase reinvestment distorts it
    tv = fcff[-1] * (1 + g) / (w - g)
    return {"df": df, "pv": pv, "pv_sum": sum(pv), "tv": tv, "pv_tv": tv * df[-1], "ev": sum(pv) + tv * df[-1]}


def _burn(rows, tax):
    """Why a scenario has no value when its last projected year burns cash, and what would give it one, in plain words.
    That year's FCFF moves one for one with its capex (x revenue) and with its EBITDA margin (x revenue x (1 - tax)),
    so the two fixes are exact for the last year. Milky Mist: still growing 15% in year 5 with capex at 12.8% of
    revenue against a 13% EBITDA margin."""
    r = rows[-1]
    rev, f = r["revenue"], r["fcff"]
    head = (f"Final-year free cash flow is negative (Rs {_inr(f)} cr in the last projected year), and a perpetuity on a "
            "cash burn means nothing.")
    if rev <= 0:
        return head + " Raise revenue growth or the EBITDA margin, or lower capex, in the last years."
    g = rev / rows[-2]["revenue"] - 1 if len(rows) > 1 and rows[-2]["revenue"] > 0 else None
    # a tenth of a point past break-even, rounded away from it, so the figure shown does give a value
    cap, mar = math.floor(((r["capex"] + f) / rev - 0.001) * 1000) / 1000, None
    if tax < 1:
        mar = math.ceil(((r["ebitda"] - f / (1 - tax)) / rev + 0.001) * 1000) / 1000
    fixes = [f"capex of at most {_pct(cap)} of revenue by then"] if cap > 0 else []
    fixes += [f"an EBITDA margin of at least {_pct(mar)} by then"] if mar is not None else []
    fixes.append("more projection years, with growth fading lower and capex cut to match")
    return (head + f" That year capex takes {_pct(r['capex'] / rev)} of revenue against an EBITDA margin of "
            f"{_pct(r['ebitda'] / rev)}" + (f", with revenue still growing {_pct(g)}" if g is not None else "")
            + ". Any one of these gives it a value: " + "; ".join(fixes) + ".")


def valuation(projs, hist, val, base, market, inputs=None, note=False):
    """DCF (free cash flow to firm) of each scenario, discounted from the last reported year end.
    projs: {scenario: project() rows}; val: VALUATION-shaped inputs; base: the base scenario's per-year inputs
    (expand()), for the default cost of debt and the WACC tax rate; market: the company's market data.
    inputs: {scenario: expand()} adds "grid_gm" per scenario (re-runs project() 25 times each) and
    "implied_growth" (reverse DCF, about 50 more runs each), for the scenarios it names. note=True (with inputs
    for base) adds "note": the base case's drivers_impact, breakevens and growth_scale (about 130 more runs). "multiples": P/E, EV/EBITDA and P/B at each reported
    year end; per scenario at today's price and at its value per share (see _multiples()).
    Mirrors the Valuation sheet in to_excel()."""
    v, last = {**VALUATION, **(val or {})}, hist[-1]
    market = market or {}
    price = _pos(v["price"] if v["price"] is not None else market.get("price"))
    shares = _pos(v["shares"] if v["shares"] is not None else market.get("shares"))
    ke, tax = v["rf"] + v["beta"] * v["erp"], base["tax_rate"][0]
    # ponytail: the default (3-yr interest / opening borrowings) is kept between rf and ke; lease interest or a
    # big late loan can push it above the cost of equity. A typed kd is used as is.
    kd = min(max(base["int_rate"][0], v["rf"]), ke) if v["kd"] is None else v["kd"]
    kd_at = kd * (1 - tax)
    # ponytail: no share price -> book equity weights the WACC; a negative book counts as zero
    e = price * shares if price and shares else max(0.0, last["share_cap"] + last["reserves"])
    # lease liabilities are debt (Ind AS 116 moved lease rent out of EBITDA, so FCFF is before lease payments);
    # The export's borrowings already included them, so splitting them out leaves D and the bridge unchanged
    d = _debt(last)
    we = e / (e + d) if e + d > 0 else 1.0
    wacc_build = we * ke + (1 - we) * kd_at
    wacc = v["wacc_override"] if v["wacc_override"] is not None else wacc_build
    g, n = v["g"], len(next(iter(projs.values())))
    period = [t + 1 - (0.5 if v["mid_year"] else 0) for t in range(n)]
    bridge = -d + last["cash"] + last["investments"]
    # minority holders' claim on the consolidated EV, as their share of profit (the base scenario's first year;
    # mi_pct nets minorities against associates, so a net positive share deducts nothing).
    # ponytail: proportional to profit share; upgrade path: a typed NCI value from the annual report
    nci = max(0.0, -base["mi_pct"][0])
    minority = lambda ev: None if ev is None else max(0.0, ev + bridge) * nci  # noqa: E731
    equity_of = lambda ev: None if ev is None else ev + bridge - minority(ev)  # noqa: E731
    error = None
    if not math.isfinite(wacc):
        error = "Those inputs give no WACC. Check the beta, rates and share price."
    elif wacc <= 0:
        error = f"WACC is {_pct(wacc)}; it must be above zero."
    elif not _clears(wacc, g):
        error = (f"WACC ({_pct(wacc)}) must be at least 0.5 pp above terminal growth ({_pct(g)}). "
                 "Lower the growth or raise the WACC.")
    per_share = lambda ev: equity_of(ev) / shares if ev is not None and shares else None  # noqa: E731
    out = {}
    for s, rows in projs.items():
        fcff = [r["fcff"] for r in rows]
        x = _dcf(fcff, period, wacc, g) or dict.fromkeys(("df", "pv", "pv_sum", "tv", "pv_tv", "ev"))
        ps = per_share(x["ev"])
        out[s] = {**x, "fcff": fcff, "minority": minority(x["ev"]), "equity": equity_of(x["ev"]), "per_share": ps,
                  "error": None if error or fcff[-1] > 0 else _burn(rows, (inputs or {}).get(s, base)["tax_rate"][-1]),
                  "upside": ps / price - 1 if ps is not None and price else None,
                  "tv_share": x["pv_tv"] / x["ev"] if x["ev"] and x["ev"] > 0 else None,
                  "grid": [[per_share((_dcf(fcff, period, wacc + dw, g + dg) or {}).get("ev")) for dg in GRID_G]
                           for dw in GRID_WACC]}
        if inputs and s in inputs:
            out[s]["grid_gm"] = [[_shifted(hist, inputs[s], dgr, dm, period, wacc, g, per_share) for dm in GRID_MARGIN]
                                 for dgr in GRID_GROWTH]
            out[s]["implied_growth"] = _implied(hist, inputs[s], period, wacc, g, per_share, price)
        # multiples at today's price and at this value per share, on the last reported and first projected year
        out[s]["multiples"] = {f"{k}_{t}": _multiples(p * shares if p is not None and shares else None, -bridge, r, nci)
                               for k, p in (("price", price), ("value", ps))
                               for t, r in (("last", last), ("next", rows[0]))}
    nb = None
    if note and inputs and "base" in inputs and not error:
        args = (hist, inputs["base"], period, wacc, g, per_share)
        nb = {"impact": drivers_impact(*args), "breakevens": breakevens(*args, price), "growth_scale": growth_scale(*args)}
    return {"note": nb, "inputs": v, "price": price, "shares": shares, "ke": ke, "kd": kd, "tax": tax, "kd_after_tax": kd_at,
            "e": e, "d": d, "we": we, "wacc": wacc, "wacc_build": wacc_build, "g": g, "period": period,
            "error": error, "nci": nci,
            "borrowings": d, "lease": last.get("lease") or 0.0, "cash": last["cash"], "investments": last["investments"],
            "multiples": _hist_multiples(hist, market, shares, nci),
            "steps": {"wacc": GRID_WACC, "g": GRID_G, "growth": GRID_GROWTH, "margin": GRID_MARGIN,
                      "implied": IMPLIED_RANGE}, "scenarios": out}


MULTIPLES = ("pe", "ev_ebitda", "pb")
MULTIPLE_LABELS = (("pe", "P/E (market cap / net profit)"),
                   ("ev_ebitda", "EV/EBITDA (EV = market cap + borrowings - cash - investments)"),
                   ("pb", "P/B (market cap / book equity)"))


def _multiples(mcap, ev_net, r, nci=0.0):
    """P/E, EV/EBITDA, P/B of a market cap against year r's net profit, EBITDA and book equity (share capital +
    reserves). ev_net: borrowings - cash - investments. EV grosses the (attributable) market cap up by the minority
    share nci, so it matches the consolidated EBITDA and the DCF's EV. None without a positive market cap (a
    negative DCF value has no meaningful multiple) or when a denominator is <= 0."""
    if mcap is None or mcap <= 0:
        return dict.fromkeys(MULTIPLES)
    book = r["share_cap"] + r["reserves"]
    return {"pe": mcap / r["pat"] if r["pat"] > 0 else None,
            "ev_ebitda": (mcap / (1 - nci) + ev_net) / r["ebitda"] if r["ebitda"] > 0 and nci < 1 else None,
            "pb": mcap / book if book > 0 else None}


def _hist_multiples(hist, market, shares, nci=0.0):
    """Multiples at each reported year end's price, plus the median, min and max of each across the years.
    Mirrored by the MULTIPLES rows of the Valuation sheet."""
    years, ph, sh = [], market.get("price_hist") or [], market.get("shares_hist") or []
    for i, h in enumerate(hist):
        p, s = (_pos(x[i]) if i < len(x) else None for x in (ph, sh))
        # ponytail: a year without the export's adjusted share count uses today's count (typed or from the export)
        s = s or shares
        years.append(_multiples(p * s if p and s else None, _debt(h) - h["cash"] - h["investments"], h, nci))
    out = {"hist": {k: [y[k] for y in years] for k in MULTIPLES}}
    for name, f in (("median", statistics.median), ("min", min), ("max", max)):
        out[name] = {k: f(xs) if (xs := [x for x in out["hist"][k] if x is not None]) else None for k in MULTIPLES}
    return out


def _value(hist, a, period, wacc, g, per_share):
    """Value per share of one assumption set (a: expand()-shaped, or flat floats), None when there is none."""
    v = per_share((_dcf([r["fcff"] for r in project(hist, a, len(period))], period, wacc, g) or {}).get("ev"))
    return v if v is not None and math.isfinite(v) else None


def _shifted(hist, a, dgr, dm, period, wacc, g, per_share):
    """Value per share with growth and EBITDA margin moved by dgr / dm in every projected year."""
    a = {**a, "growth": [x + dgr for x in a["growth"]], "ebitda_margin": [x + dm for x in a["ebitda_margin"]]}
    return _value(hist, a, period, wacc, g, per_share)


def _solve(gap, xs, near):
    """A root of gap() on the grid xs (gap None = no value there): scan for sign changes, bisect (to 1e-10) the
    bracket nearest `near`. None when no bracket has one.
    ponytail: value isn't always monotonic (heavy capex makes growth burn cash), so a root inside one step can be
    missed; a finer grid if that ever matters"""
    ys = [gap(x) for x in xs]
    pairs = [(xs[i], xs[i + 1], ys[i]) for i in range(len(xs) - 1)
             if ys[i] is not None and ys[i + 1] is not None and (ys[i] == 0 or ys[i] * ys[i + 1] < 0)]
    if not pairs:
        return xs[-1] if ys[-1] == 0 else None
    lo, hi, ylo = min(pairs, key=lambda p: abs((p[0] + p[1]) / 2 - near))
    while hi - lo > 1e-10:
        mid = (lo + hi) / 2
        ym = gap(mid)
        if ylo * ym <= 0:
            hi = mid
        else:
            lo, ylo = mid, ym
    return (lo + hi) / 2


def _flat_gap(hist, a, key, period, wacc, g, per_share, price):
    """gap(x): value per share with driver `key` at x in every projected year, less the price."""
    def gap(x):
        v = _value(hist, {**a, key: x}, period, wacc, g, per_share)
        return None if v is None else v - price
    return gap


def _implied(hist, a, period, wacc, g, per_share, price):
    """Reverse DCF: the flat revenue growth (every projected year, other drivers as they are) at which value per
    share equals the price. None without a price or per-share value, or when no growth in IMPLIED_RANGE gets there."""
    gap = _flat_gap(hist, a, "growth", period, wacc, g, per_share, price)
    if not price or gap(0.0) is None:
        return None
    lo, hi = IMPLIED_RANGE
    xs = [lo + i * 0.05 for i in range(round((hi - lo) / 0.05) + 1)]
    return _solve(gap, xs, sum(a["growth"]) / len(a["growth"]))


# ---------- the research note (4.1): what moves value, what the price needs, the growth scale ----------

# (driver, label, step): each moved down and up by one step in every projected year, the rest at base. Growth and
# margin use the inner steps of the growth x margin grid; WACC and terminal growth those of the WACC x g grid.
# Payout, other income, interest and minorities don't move a cash-flow-to-firm value, so they aren't here.
IMPACT = (("growth", "Revenue growth", GRID_GROWTH[3]), ("ebitda_margin", "EBITDA margin", GRID_MARGIN[3]),
          ("wacc", "Discount rate (WACC)", GRID_WACC[3]), ("g", "Terminal growth", GRID_G[3]),
          ("capex_pct", "Capex % revenue", 0.01), ("tax_rate", "Tax rate", 0.02), ("dso", "Receivable days", 10.0),
          ("dio", "Inventory days", 10.0), ("dpo", "Payable days", 10.0), ("oca_pct", "Other current assets", 0.01),
          ("ol_pct", "Other liabilities", 0.01), ("dep_pct", "Depreciation rate", 0.01))
NON_NEG = {"capex_pct", "tax_rate", "dso", "dio", "dpo", "oca_pct", "ol_pct", "dep_pct"}  # a step down stops at 0
GROWTH_SCALE = [round(-0.10 + 0.02 * i, 2) for i in range(26)]  # flat revenue growth, -10% to +40%, for the ruler
MARGINS = [round(-0.20 + 0.05 * i, 2) for i in range(21)]  # break-even EBITDA margin searched from -20% to 80%


def drivers_impact(hist, a, period, wacc, g, per_share):
    """Value per share with each IMPACT driver moved down / up one step, others at base, widest swing first.
    a: expand()-shaped inputs of one scenario. Drivers that move nothing (no payables: payable days) are left out."""
    fcff = [r["fcff"] for r in project(hist, a, len(period))]
    at = lambda w, gg: (lambda ev: None if ev is None else per_share(ev))((_dcf(fcff, period, w, gg) or {}).get("ev"))  # noqa: E731
    out, no_pay = [], all(h.get("payables") is None for h in hist)
    for key, label, step in IMPACT:
        if key == "dpo" and no_pay:  # export-only: payables sit in other liabilities, payable days would add a second copy
            continue
        if key == "wacc":
            lo, hi = at(wacc - step, g), at(wacc + step, g)
        elif key == "g":
            lo, hi = at(wacc, g - step), at(wacc, g + step)
        else:
            lo, hi = (_value(hist, {**a, key: [max(0.0, x + d) if key in NON_NEG else x + d for x in a[key]]}, period, wacc, g,
                             per_share) for d in (-step, step))
        if lo is None and hi is None or lo == hi:
            continue
        out.append({"key": key, "label": label, "step": step, "down": lo, "up": hi,
                    "swing": abs(hi - lo) if lo is not None and hi is not None else None})
    return sorted(out, key=lambda d: -(d["swing"] if d["swing"] is not None else -1))


def breakevens(hist, a, period, wacc, g, per_share, price):
    """The flat level of each driver at which value per share equals the price, everything else as it is (the
    reverse DCF generalised): {key: {"value", "range"}}, value None when nothing in the range gets there."""
    if not price:
        return {}
    fcff = [r["fcff"] for r in project(hist, a, len(period))]

    def at(w, gg):
        v = per_share((_dcf(fcff, period, w, gg) or {}).get("ev"))
        return None if v is None or not math.isfinite(v) else v - price
    ws = [round(g + MIN_SPREAD + 0.0025 * i, 6) for i in range(max(0, int((0.30 - g - MIN_SPREAD) / 0.0025) + 1))]
    gs = [round(-0.05 + 0.0025 * i, 6) for i in range(max(0, int((min(0.08, wacc - MIN_SPREAD) + 0.05) / 0.0025) + 1))]
    solve = lambda f, xs, near: _solve(f, xs, near) if len(xs) > 1 else None  # noqa: E731
    return {"growth": {"value": _implied(hist, a, period, wacc, g, per_share, price), "range": list(IMPLIED_RANGE)},
            "ebitda_margin": {"value": solve(_flat_gap(hist, a, "ebitda_margin", period, wacc, g, per_share, price),
                                             MARGINS, sum(a["ebitda_margin"]) / len(a["ebitda_margin"])),
                              "range": [MARGINS[0], MARGINS[-1]]},
            "wacc": {"value": solve(lambda w: at(w, g), ws, wacc), "range": [ws[0], ws[-1]] if ws else None},
            "g": {"value": solve(lambda x: at(wacc, x), gs, g), "range": [gs[0], gs[-1]] if gs else None}}


def growth_scale(hist, a, period, wacc, g, per_share):
    """[[flat revenue growth, value per share]] across GROWTH_SCALE, other inputs at base: the ruler's lower scale."""
    return [[x, _value(hist, {**a, "growth": x}, period, wacc, g, per_share)] for x in GROWTH_SCALE]


def cagrs(hist, labels, years):
    """Every rolling `years`-year revenue CAGR: [{"from", "to", "value"}] (skips windows that start or end <= 0)."""
    return [{"from": labels[i - years], "to": labels[i],
             "value": (hist[i]["revenue"] / hist[i - years]["revenue"]) ** (1 / years) - 1}
            for i in range(years, len(hist)) if hist[i]["revenue"] > 0 and hist[i - years]["revenue"] > 0]


def projected_dates(co, n):
    last = co["dates"][-1]
    return [last.replace(year=y, day=min(last.day, calendar.monthrange(y, last.month)[1]))
            for y in range(last.year + 1, last.year + n + 1)]


# ---------- tracking (5.3): the forecast you had against the results that came in; rules only ----------

# (driver, words, how close counts as a hit). A hit = the actual within one step of what you assumed: the impact
# table's steps where it has one (growth 2 pp, margin 1 pp, days 10...), else a step of the same size.
# ponytail: minority share and planned borrowing aren't scored (a share of profit and a plan in crore, not a rate)
TRACK = (("growth", "Revenue growth", 0.02), ("ebitda_margin", "EBITDA margin", 0.01),
         ("oi_pct", "Other income % revenue", 0.01), ("tax_rate", "Tax rate", 0.02), ("capex_pct", "Capex % revenue", 0.01),
         ("dso", "Receivable days", 10.0), ("cogs_pct", "COGS % revenue", 0.02), ("dio", "Inventory days", 10.0),
         ("dpo", "Payable days", 10.0), ("oca_pct", "Other current assets % revenue", 0.01),
         ("ol_pct", "Other liabilities % revenue", 0.01), ("dep_pct", "Depreciation % opening net block", 0.01),
         ("int_rate", "Interest % opening borrowings", 0.01), ("payout", "Dividend payout", 0.10))
TRACK_LINES = (("revenue", "Revenue"), ("ebitda", "EBITDA"), ("pat", "Net profit"), ("fcf", "Free cash flow"))
MAX_TRACK = 20  # forecasts kept per model, one per set of new annual results: twenty years of them


def forecast_record(co, a, proj):
    """What the base case said before new results: per projected year (by its year end) each scored driver and the
    main lines. a = expand()-shaped base inputs, proj = project() of them. The server adds the value range then."""
    dates = projected_dates(co, len(proj))
    return {"last": labels(co["dates"])[-1], "dates": [d.isoformat()[:10] for d in dates], "years": [fy(d) for d in dates],
            "drivers": {k: [float(x) for x in a[k]] for k, _, _ in TRACK if k in a},
            "lines": {k: [r.get(k) for r in proj] for k, _ in TRACK_LINES}}


def _at(rec, group, k, j):
    xs = (rec.get(group) or {}).get(k) or []
    x = xs[j] if j < len(xs) else None
    return x if isinstance(x, (int, float)) and math.isfinite(x) else None


def track(records, co):
    """Each saved forecast against the years now reported: {records: [{last, made_at, years: [{year, drivers: [{key,
    label, forecast, actual, diff, err, hit}], lines: [{key, label, forecast, actual, err}]}]}], hit_rate: [{key, label,
    hits, scored}]}. A year matches by its year end's month; err = (actual - forecast) / |forecast|. The hit rate runs
    over every (forecast, year) pair, so a year two forecasts covered counts twice. ponytail: no weighting by horizon"""
    hist, labs, cogs = co["hist"], labels(co["dates"]), on_cogs(co["hist"])
    r, at = ratios(hist), {str(d)[:7]: i for i, d in enumerate(co["dates"])}
    tally, out = {k: [0, 0] for k, _, _ in TRACK}, []
    for rec in records:
        years = []
        for j, d in enumerate(rec.get("dates") or []):
            i = at.get(str(d)[:7])
            if i is None:
                continue
            ds = []
            for k, label, tol in TRACK:
                f, x = _at(rec, "drivers", k, j), r[i].get(k)
                # nothing to score: no number, COGS % for a company not on COGS (a services firm), or none either side
                if f is None or x is None or k == "cogs_pct" and not cogs or max(abs(f), abs(x)) < tol / 10:
                    continue
                hit = abs(x - f) <= tol + 1e-12
                tally[k][0] += hit
                tally[k][1] += 1
                ds.append({"key": k, "label": label, "forecast": f, "actual": x, "diff": x - f,
                           "err": (x - f) / abs(f) if abs(f) > 1e-9 else None, "hit": hit, "tol": tol})
            ls = [{"key": k, "label": label, "forecast": f, "actual": x, "err": (x - f) / abs(f) if abs(f) > 1e-9 else None}
                  for k, label in TRACK_LINES if (f := _at(rec, "lines", k, j)) is not None and (x := hist[i].get(k)) is not None]
            years.append({"year": labs[i], "drivers": ds, "lines": ls})
        out.append({"last": rec.get("last"), "made_at": rec.get("made_at"), "years": years})
    words = {k: label for k, label, _ in TRACK}
    return {"records": out, "hit_rate": [{"key": k, "label": words[k], "hits": h, "scored": n}
                                         for k, (h, n) in tally.items() if n]}


def track_proposals(scored, records, base, defaults, unusual=()):
    """Rules proposals after new results: for each driver the latest results missed (outside its step) where the rule
    default, now with those results in, moves your base toward what came in, by at least half a step. Never applied
    here: each is {key, label, year, forecast, actual, current, proposed} for you to accept. A driver you chose to keep
    (the record's "kept") isn't proposed again for those results. A miss in a year detect_oneoffs flags for that driver
    (`unusual`: {(key, year)}) proposes nothing: it comes back with proposed None and unusual True, so you can leave the
    year out of the defaults instead (a one-off tax credit shouldn't set next year's tax rate)."""
    for rec, s in zip(reversed(records), reversed(scored["records"])):
        if s["years"]:
            break
    else:
        return []
    y, kept, out = s["years"][-1], set(rec.get("kept") or []), []
    for d in y["drivers"]:
        k = d["key"]
        cur, new = (base.get(k) or {}).get("start"), defaults.get(k)
        if d["hit"] or k in kept or cur is None or new is None:
            continue
        odd = (k, y["year"]) in unusual
        if odd or abs(new - cur) >= d["tol"] / 2 and (new - cur) * d["diff"] > 0:
            out.append({"key": k, "label": d["label"], "year": y["year"], "forecast": d["forecast"], "actual": d["actual"],
                        "current": cur, "proposed": None if odd else new, **({"unusual": True} if odd else {})})
    return out


# ---------- Excel export (live formulas) ----------

RAW = {"revenue", "cogs", "lease", "payables", "other_income", "dep", "interest", "pbt", "tax", "pat", "dividend", "share_cap", "reserves",
       "borrowings", "other_liab", "net_block", "cwip", "investments", "receivables", "inventory", "other_ca",
       "cash", "cfo", "cfi", "cff"}


def _returns_formulas(x, has_prev):
    """Excel twin of returns(): blank ("") where the denominator is <= ~0 (1e-6)."""
    avg = lambda f: f"(({f(0)})+({f(1)}))/2" if has_prev else f"({f(0)})"  # noqa: E731
    eq = lambda p: f'{x("share_cap", p)}+{x("reserves", p)}'  # noqa: E731
    debt = lambda p=0: f'{x("borrowings", p)}+{x("lease", p)}'  # noqa: E731  a blank lease cell counts as 0
    pos = lambda num, den: f'=IFERROR(IF(({den})>1E-6,({num})/({den}),""),"")'  # noqa: E731
    ebit = f'{x("pbt")}+{x("interest")}'
    return {
        "roe": pos(x("pat"), avg(eq)),
        "roce": pos(ebit, avg(lambda p: f'{eq(p)}+{debt(p)}')),
        "asset_turnover": pos(x("revenue"), avg(lambda p: x("total_assets", p))),
        "nd_ebitda": pos(f'{debt()}-{x("cash")}-{x("investments")}', x("ebitda")),
        "int_cover": pos(ebit, x("interest")),
    }


def _hist_formula(key, x, has_prev, cogs=False):
    """Formula for a historical column. x(key, prev=False) -> cell ref. cogs: on_cogs() (days on COGS)."""
    def ratio(num, den):
        return f'=IFERROR({num}/{den},"")'
    base = x("cogs") if cogs else x("revenue")
    debt = lambda p=0: f'({x("borrowings", p)}+{x("lease", p)})'  # noqa: E731
    known = lambda k, f: f'=IF(ISNUMBER({x(k)}),{f[1:]},"")'  # noqa: E731  blank where the line isn't reported
    needs_prev = {"growth", "dep_pct", "int_rate", "capex_pct", "debt_change", "capex", "fcf"}
    if key in needs_prev and not has_prev:
        return None
    return {
        "growth": f'=IFERROR({x("revenue")}/{x("revenue", 1)}-1,"")',
        "ebitda_margin": ratio(x("ebitda"), x("revenue")),
        "oi_pct": ratio(x("other_income"), x("revenue")),
        "dep_pct": ratio(x("dep"), x("net_block", 1)),
        "int_rate": ratio(x("interest"), debt(1)),
        "tax_rate": ratio(x("tax"), x("pbt")),
        "payout": ratio(x("dividend"), x("pat")),
        "mi_pct": f'=IFERROR({x("pat")}/({x("pbt")}-{x("tax")})-1,"")',
        "capex_pct": ratio(x("capex"), x("revenue")),
        "dso": ratio(f'{x("receivables")}*365', x("revenue")),
        "cogs_pct": known("cogs", ratio(x("cogs"), x("revenue"))),
        "dio": ratio(f'{x("inventory")}*365', base),
        "dpo": known("payables", ratio(f'{x("payables")}*365', base)),
        "oca_pct": ratio(x("other_ca"), x("revenue")),
        "ol_pct": ratio(x("other_liab"), x("revenue")),
        "debt_change": f'={debt()}-{debt(1)}',
        "ebitda": f'={x("pbt")}+{x("interest")}+{x("dep")}-{x("other_income")}',
        "total_liab": f'=SUM({x("share_cap")}:{x("other_liab")})',
        "total_assets": f'=SUM({x("net_block")}:{x("cash")})',
        "net_cf": f'={x("cfo")}+{x("cfi")}+{x("cff")}',
        "capex": f'={x("net_block")}-{x("net_block", 1)}+{x("cwip")}-{x("cwip", 1)}+{x("dep")}',
        "fcf": f'={x("cfo")}-{x("capex")}',
        "chk_bs": f'=ROUND({x("total_assets")}-{x("total_liab")},2)',
        **_returns_formulas(x, has_prev),
    }.get(key)


def _proj_formula(key, x, cogs=False):
    d = lambda k: f'({x(k)}-{x(k, 1)})'  # noqa: E731
    base = x("cogs") if cogs else x("revenue")
    liab = f'{x("lease")}+{x("payables")}+{x("other_liab")}'
    return {
        "revenue": f'={x("revenue", 1)}*(1+{x("growth")})',
        "cogs": f'={x("revenue")}*{x("cogs_pct")}',
        "ebitda": f'={x("revenue")}*{x("ebitda_margin")}',
        "other_income": f'={x("revenue")}*{x("oi_pct")}',
        "dep": f'={x("net_block", 1)}*{x("dep_pct")}',
        "interest": f'=({x("borrowings", 1)}+{x("lease", 1)})*{x("int_rate")}',
        "pbt": f'={x("ebitda")}+{x("other_income")}-{x("dep")}-{x("interest")}',
        "tax": f'=MAX(0,{x("pbt")}*{x("tax_rate")})',
        "pat": f'=({x("pbt")}-{x("tax")})*(1+{x("mi_pct")})',
        "dividend": f'=MAX(0,{x("pat")}*{x("payout")})',
        "share_cap": f'={x("share_cap", 1)}',
        "reserves": f'={x("reserves", 1)}+{x("pat")}-{x("dividend")}',
        "borrowings": f'=MAX(0,{x("borrowings", 1)}+{x("debt_change")})+{x("revolver")}',
        "revolver": (f'=MAX(0,SUM({x("net_block")}:{x("other_ca")})-({x("share_cap")}+{x("reserves")}'
                     f'+MAX(0,{x("borrowings", 1)}+{x("debt_change")})+{liab}))'),
        "lease": f'={x("lease", 1)}',
        "payables": f'={base}*{x("dpo")}/365',
        "other_liab": f'={x("revenue")}*{x("ol_pct")}',
        "total_liab": f'=SUM({x("share_cap")}:{x("other_liab")})',
        "net_block": f'={x("net_block", 1)}+{x("capex")}-{x("dep")}',
        "cwip": f'={x("cwip", 1)}',
        "investments": f'={x("investments", 1)}',
        "receivables": f'={x("revenue")}*{x("dso")}/365',
        "inventory": f'={base}*{x("dio")}/365',
        "other_ca": f'={x("revenue")}*{x("oca_pct")}',
        "cash": f'={x("total_liab")}-SUM({x("net_block")}:{x("other_ca")})',
        "total_assets": f'=SUM({x("net_block")}:{x("cash")})',
        "cfo": (f'={x("pat")}+{x("dep")}-{d("receivables")}-{d("inventory")}-{d("other_ca")}+{d("other_liab")}'
                f'+{d("payables")}'),
        "cfi": f'=-{x("capex")}-{d("cwip")}-{d("investments")}',
        "cff": f'={d("borrowings")}+{d("share_cap")}-{x("dividend")}',
        "net_cf": f'={x("cfo")}+{x("cfi")}+{x("cff")}',
        "capex": f'={x("revenue")}*{x("capex_pct")}',
        "fcf": f'={x("cfo")}-{x("capex")}',
        "ebit": f'={x("ebitda")}-{x("dep")}',
        "nopat": f'={x("ebit")}*(1-{x("tax_rate")})',
        "nwc": f'={x("receivables")}+{x("inventory")}+{x("other_ca")}-{x("other_liab")}-{x("payables")}',
        "fcff": (f'={x("nopat")}+{x("dep")}-{x("capex")}-({x("nwc")}-({x("receivables", 1)}+{x("inventory", 1)}'
                 f'+{x("other_ca", 1)}-{x("other_liab", 1)}-{x("payables", 1)}))'),
        "chk_bs": f'=ROUND({x("total_assets")}-{x("total_liab")},2)',
        "chk_cash": f'=ROUND({x("cash", 1)}+{x("net_cf")}-{x("cash")},2)',
        **_returns_formulas(x, True),
    }[key]


def _scenario_sheet(wb, scenarios, n, years, formats, head_fill):
    """'Scenarios' sheet: one block of blue per-year input cells per scenario. Returns src(scenario, key, j) -> ref."""
    sc = wb.create_sheet("Scenarios")
    sc["A1"] = "Per-year inputs for each scenario. The Model sheet uses the one picked in its cell B3."
    sc["A1"].font = Font(italic=True, color="808080")
    sc.cell(3, 1, "Assumption").font = Font(bold=True)
    for j, y in enumerate(years):
        sc.cell(3, 2 + j, y).font = Font(bold=True)
    rows, r = {}, 4
    for s in SCENARIOS:
        for j in range(n + 1):
            sc.cell(r, 1 + j).fill = head_fill
        sc.cell(r, 1, s.upper()).font = Font(bold=True)
        inputs = expand(scenarios[s], n)
        for key, label, kind in DRIVERS:
            r += 1
            rows[s, key] = r
            sc.cell(r, 1, label)
            for j in range(n):
                c = sc.cell(r, 2 + j, inputs[key][j])
                c.number_format, c.font = formats[kind], Font(color="0000FF")
        r += 2
    sc.column_dimensions["A"].width = 46
    for j in range(n):
        sc.column_dimensions[get_column_letter(2 + j)].width = 11
    sc.freeze_panes = "B4"
    return lambda s, key, j: f"Scenarios!{get_column_letter(2 + j)}{rows[s, key]}"


def _valuation_sheet(wb, co, n, val, src, at, years, formats, head_fill):
    """'Valuation' sheet: the DCF of whichever scenario Model!B3 picks. Mirrors valuation(); val is its result
    (inputs, price and shares as resolved there, and the grid_gm / implied_growth values per scenario).
    at(key, j) -> Model sheet ref for column j (0 = first reported year)."""
    v, m, nh = val["inputs"], co.get("market") or {}, len(co["hist"])
    price, shares, sv = val["price"], val["shares"], val["scenarios"]
    vs = wb.create_sheet("Valuation")
    vs["A1"] = "DCF of free cash flow to firm, for the scenario picked in Model!B3"
    vs["A1"].font = Font(bold=True, size=14)
    vs["A2"] = (f"Discounted from the {labels(co['dates'])[-1]} year end. Rs crore; value per share in Rs. "
                "Blue = input, green = from the Scenarios sheet (base, first projected year).")
    vs["A2"].font = Font(italic=True, color="808080")
    blue, green = Font(color="0000FF"), Font(color="008000")
    hist = lambda k: f"Model!{at(k, nh - 1)}"  # noqa: E731
    r, ref = 3, {}

    def put(key, label, value, fmt, font=None):
        nonlocal r
        r += 1
        ref[key] = f"$B${r}"
        vs.cell(r, 1, label)
        c = vs.cell(r, 2, value)
        c.number_format, c.font = fmt, font or Font()
        return c

    def head(title):
        nonlocal r
        r += 2
        for j in range(max(n, nh, 7) + 1):
            vs.cell(r, 1 + j).fill = head_fill
        vs.cell(r, 1, title).font = Font(bold=True)

    pct, num, rs = formats["pct"], formats["num"], "#,##0.00;(#,##0.00);-"
    r -= 1
    head("INPUTS")
    put("rf", "Risk-free rate (10-yr G-sec)", v["rf"], pct, blue)
    put("erp", "Equity risk premium", v["erp"], pct, blue)
    put("beta", "Beta", v["beta"], "0.00", blue)
    # the default is clamped between rf and ke, like valuation()
    put("kd", "Cost of debt, pre-tax",
        f"=MIN(MAX({src('base', 'int_rate', 0)},{ref['rf']}),{ref['rf']}+{ref['beta']}*{ref['erp']})"
        if v["kd"] is None else v["kd"], pct, green if v["kd"] is None else blue)
    put("tax", "Tax rate", f"={src('base', 'tax_rate', 0)}", pct, green)
    put("g", "Terminal growth", v["g"], pct, blue)
    put("mid", "Mid-year discounting (1 = yes, 0 = year end)", 1 if v["mid_year"] else 0, "0", blue)
    yes_no = DataValidation(type="whole", operator="between", formula1="0", formula2="1", showErrorMessage=True,
                            error="Enter 1 (mid-year) or 0 (year end).")
    vs.add_data_validation(yes_no)
    yes_no.add(ref["mid"])
    put("override", "WACC override (blank = build-up below)", v["wacc_override"], pct, blue)
    put("price", "Share price (Rs)", price, rs, blue)
    put("shares", "Shares (crore)", shares, rs, blue)
    put("nci", "Minority share of profit", f"=MAX(0,-{src('base', 'mi_pct', 0)})",
        pct, green)

    head("WACC BUILD-UP")
    put("ke", "Cost of equity = risk-free + beta x premium", f"={ref['rf']}+{ref['beta']}*{ref['erp']}", pct)
    put("kd_at", "Cost of debt after tax", f"={ref['kd']}*(1-{ref['tax']})", pct)
    put("e", "Equity (market cap; book equity if no price)",
        f"=IF(AND(ISNUMBER({ref['price']}),ISNUMBER({ref['shares']})),{ref['price']}*{ref['shares']},"
        f"MAX(0,{hist('share_cap')}+{hist('reserves')}))", num)
    put("d", "Debt (borrowings and lease liabilities)", f"={hist('borrowings')}+{hist('lease')}", num)
    put("we", "Equity weight", f"=IF({ref['e']}+{ref['d']}>0,{ref['e']}/({ref['e']}+{ref['d']}),1)", pct)
    put("wd", "Debt weight", f"=1-{ref['we']}", pct)
    put("wacc", "WACC", f"=IF(ISNUMBER({ref['override']}),{ref['override']},"
                        f"{ref['we']}*{ref['ke']}+{ref['wd']}*{ref['kd_at']})", pct, Font(bold=True))
    okw = f"AND({ref['wacc']}>0,ROUND({ref['wacc']}-{ref['g']},10)>={MIN_SPREAD})"  # see _clears()
    check = put("check", "", None, "General", Font(bold=True, color="C00000"))

    head("EXPLICIT YEARS")
    lastf = f"${col(n - 1)}${r + 1}"  # final-year FCFF: the first row below
    ok = f"AND({okw},{lastf}>0)"
    check.value = (f'=IF(NOT({okw}),"WACC must be above zero and at least 0.5 pp above terminal growth",'
                   f'IF({lastf}>0,"","Final-year free cash flow is negative; a perpetuity on it has no meaning"))')
    for j, y in enumerate(years):
        vs.cell(r, 2 + j, y).font = Font(bold=True)
    rows = {}
    for key, label, fmt, f in (
        ("fcff", "Free cash flow to firm", num, lambda j: f"=Model!{at('fcff', nh + j)}"),
        ("period", "Discount period (years)", "0.0", lambda j: f"={j + 1}-IF({ref['mid']}=1,0.5,0)"),
        ("df", "Discount factor", "0.0000", lambda j: f'=IF({ok},1/(1+{ref["wacc"]})^{col(j)}{rows["period"]},"")'),
        ("pv", "Present value", num, lambda j: f'=IF({ok},{col(j)}{rows["fcff"]}*{col(j)}{rows["df"]},"")'),
    ):
        r += 1
        rows[key] = r
        vs.cell(r, 1, label)
        for j in range(n):
            c = vs.cell(r, 2 + j, f(j))
            c.number_format = fmt
    span = lambda key: f"$B${rows[key]}:${col(n - 1)}${rows[key]}"  # noqa: E731
    lastp, lastdf = (f"${col(n - 1)}${rows[k]}" for k in ("period", "df"))

    head("ENTERPRISE VALUE TO VALUE PER SHARE")
    put("pv_sum", "PV of explicit years", f'=IF({ok},SUM({span("pv")}),"")', num)
    put("tv", "Terminal value (Gordon growth on final-year FCFF)",
        f'=IF({ok},{lastf}*(1+{ref["g"]})/({ref["wacc"]}-{ref["g"]}),"")', num)
    put("pv_tv", "PV of terminal value", f'=IF({ok},{ref["tv"]}*{lastdf},"")', num)
    put("ev", "Enterprise value", f'=IF({ok},{ref["pv_sum"]}+{ref["pv_tv"]},"")', num, Font(bold=True))
    put("borrowings", "Less borrowings and lease liabilities", f"={hist('borrowings')}+{hist('lease')}", num)
    put("cash", "Plus cash & bank", f"={hist('cash')}", num)
    put("investments", "Plus investments", f"={hist('investments')}", num)
    pre = f'{ref["ev"]}-{ref["borrowings"]}+{ref["cash"]}+{ref["investments"]}'
    put("minority", "Less minority interest (estimate)", f'=IF({ok},MAX(0,{pre})*{ref["nci"]},"")', num)
    put("equity", "Equity value", f'=IF({ok},{pre}-{ref["minority"]},"")', num, Font(bold=True))
    put("per_share", "Value per share (Rs)", f'=IFERROR(IF({ok},{ref["equity"]}/{ref["shares"]},""),"")', rs,
        Font(bold=True))
    put("upside", f"Upside: value at the {labels(co['dates'])[-1]} year end vs price at export",
        f'=IFERROR(IF(ISNUMBER({ref["per_share"]}),{ref["per_share"]}/{ref["price"]}-1,""),"")', pct)
    put("tv_share", "Terminal value share of EV", f'=IFERROR(IF({ref["ev"]}>0,{ref["pv_tv"]}/{ref["ev"]},""),"")', pct)
    # ponytail: the reverse DCF is a search over whole projections, so like the second grid it ships as values
    x = ['""' if sv[s]["implied_growth"] is None else repr(sv[s]["implied_growth"]) for s in SCENARIOS]
    put("implied", "Revenue growth implied by share price at export", f"=CHOOSE(Model!$B$3,{','.join(x)})", pct)
    vs.cell(r, 3, "Flat every projected year, other inputs as set; value at export (re-run in the app)").font = Font(
        italic=True, color="808080")

    head("VALUE PER SHARE (Rs): WACC (rows) x TERMINAL GROWTH (columns)")
    top = r
    for i, dg in enumerate(GRID_G):
        c = vs.cell(top, 2 + i, f"={ref['g']}{dg:+}")
        c.number_format, c.font = pct, Font(bold=True)
    for k, dw in enumerate(GRID_WACC):
        r += 1
        c = vs.cell(r, 1, f"={ref['wacc']}{dw:+}")
        c.number_format, c.font = pct, Font(bold=True)
        for i in range(len(GRID_G)):
            w, g = f"$A{r}", f"{col(i)}${top}"
            eq = (f'(SUMPRODUCT({span("fcff")},1/(1+{w})^{span("period")})+{lastf}*(1+{g})/({w}-{g})/(1+{w})^{lastp}'
                  f'-{ref["borrowings"]}+{ref["cash"]}+{ref["investments"]})')  # equity before minorities
            vs.cell(r, 2 + i, (
                f'=IF(AND({w}>0,ROUND({w}-{g},10)>={MIN_SPREAD},{lastf}>0),'
                f'IFERROR(({eq}-MAX(0,{eq})*{ref["nci"]})/{ref["shares"]},""),"")')).number_format = rs

    # ponytail: growth x margin needs a re-run of the whole projection per cell, so it ships as values
    # (one set per scenario, picked by the selector); editing inputs in Excel doesn't move it
    head("VALUE PER SHARE (Rs): REVENUE GROWTH SHIFT (rows) x EBITDA MARGIN SHIFT (columns)")
    vs.cell(r + 1, 1, "Values at export (re-run in the app). Shifts apply to every projected year.").font = Font(
        italic=True, color="808080")
    r += 1
    top = r
    for i, dm in enumerate(GRID_MARGIN):
        vs.cell(top, 2 + i, f"{dm * 100:+g} pp").font = Font(bold=True)
    for k, dgr in enumerate(GRID_GROWTH):
        r += 1
        vs.cell(r, 1, f"{dgr * 100:+g} pp").font = Font(bold=True)
        for i in range(len(GRID_MARGIN)):
            x = ['""' if sv[s]["grid_gm"][k][i] is None else repr(sv[s]["grid_gm"][k][i]) for s in SCENARIOS]
            vs.cell(r, 2 + i, f"=CHOOSE(Model!$B$3,{','.join(x)})").number_format = rs

    # multiples: every reported year at its year-end price, then today's price and the DCF value against the last
    # reported year and the first projected one (the selector's scenario). Mirrors _hist_multiples() / _multiples().
    head("MULTIPLES AT EACH REPORTED YEAR END")
    hl = labels(co["dates"])
    for j, y in enumerate(hl):
        vs.cell(r, 2 + j, y).font = Font(bold=True)
    hr, ph, sh, xf = {}, m.get("price_hist") or [], m.get("shares_hist") or [], '0.0"x";-0.0"x"'
    model_at = lambda k, j: f"Model!{at(k, j)}"  # noqa: E731

    def mult(cap, net, k, j):
        """P/E, EV/EBITDA, P/B formulas of market cap ref `cap` against Model column j; net = borrowings - cash
        - investments ("" when cap is blank or <= 0, or a denominator is <= 0)."""
        x = lambda key: model_at(key, j)  # noqa: E731
        book = f'{x("share_cap")}+{x("reserves")}'
        num, den = {"pe": (cap, x("pat")), "ev_ebitda": (f"({cap}/(1-{ref['nci']})+{net})", x("ebitda")),
                    "pb": (cap, book)}[k]
        return f'=IFERROR(IF(AND(ISNUMBER({cap}),{cap}>0,{den}>0),{num}/({den}),""),"")'

    for key, label, fmt, f in (
        ("price", "Year-end share price (Rs)", rs, lambda j, c: _pos(ph[j]) if j < len(ph) else None),
        ("shares", "Shares (crore; today's if not reported)", rs,
         lambda j, c: (_pos(sh[j]) if j < len(sh) else None) or f'=IF(ISNUMBER({ref["shares"]}),{ref["shares"]},"")'),
        ("cap", "Market cap", num, lambda j, c: f'=IF(AND(ISNUMBER({c}{hr["price"]}),ISNUMBER({c}{hr["shares"]})),'
                                                f'{c}{hr["price"]}*{c}{hr["shares"]},"")'),
        *((k, label, xf, lambda j, c, k=k: mult(f"{c}{hr['cap']}", f"{model_at('borrowings', j)}+{model_at('lease', j)}-"
                                                    f"{model_at('cash', j)}-{model_at('investments', j)}", k, j))
          for k, label in MULTIPLE_LABELS),
    ):
        r += 1
        hr[key] = r
        vs.cell(r, 1, label)
        for j in range(nh):
            c = vs.cell(r, 2 + j, f(j, get_column_letter(2 + j)))
            c.number_format = fmt
            if key in ("price", "shares") and not str(c.value).startswith("="):
                c.font = blue

    nxt, last_y = years[0], hl[-1]
    head("MULTIPLES CROSS-CHECK: HISTORY vs TODAY'S PRICE vs DCF VALUE (scenario in Model!B3)")
    heads = ("History median", "History low", "History high", f"Price, {last_y}", f"Price, {nxt}",
             f"Value, {last_y}", f"Value, {nxt}")
    for i, h in enumerate(heads):
        vs.cell(r, 2 + i, h).font = Font(bold=True)
    net = f"{ref['borrowings']}-{ref['cash']}-{ref['investments']}"
    cap_p = f'IF(AND(ISNUMBER({ref["price"]}),ISNUMBER({ref["shares"]})),{ref["price"]}*{ref["shares"]},"")'
    cap_v = f'IFERROR({ref["per_share"]}*{ref["shares"]},"")'
    for k, label in MULTIPLE_LABELS:
        r += 1
        span_h = f"$B${hr[k]}:${get_column_letter(1 + nh)}${hr[k]}"
        vs.cell(r, 1, label.split(" (")[0])
        cells = [f'=IF(COUNT({span_h})=0,"",{fn}({span_h}))' for fn in ("MEDIAN", "MIN", "MAX")]
        cells += [mult(cap, net, k, j) for cap in (cap_p, cap_v) for j in (nh - 1, nh)]
        for i, x in enumerate(cells):
            vs.cell(r, 2 + i, x).number_format = xf

    vs.column_dimensions["A"].width = 50
    for j in range(max(n, len(GRID_G), nh, len(heads))):
        vs.column_dimensions[get_column_letter(2 + j)].width = 12


# Quarters sheet rows: (label, key); "opm" is a formula row (operating profit / sales)
Q_LAYOUT = [("Sales", "sales"), ("Expenses", "expenses"), ("Operating profit (EBITDA)", "op_profit"),
            ("Operating margin", "opm"), ("Other income", "other_income"), ("Depreciation", "depreciation"),
            ("Interest", "interest"), ("Profit before tax", "pbt"), ("Tax", "tax"), ("Net profit", "net_profit")]


def _quarters_sheet(wb, q, formats):
    """'Quarters' sheet: reported quarters as values (ink), then a TTM column of live SUMs over the last four
    (blank when one is missing, like ttm()). No TTM column when the last four quarters aren't consecutive."""
    qs = wb.create_sheet("Quarters")
    qs["A1"] = ("Quarterly results as reported, Rs crore (Excel export). Operating profit = profit before tax + "
                "interest + depreciation - other income. TTM = sum of the last four quarters.")
    qs["A1"].font = Font(italic=True, color="808080")
    top, nq, t = 3, len(q["dates"]), ttm(q)
    heads = [f"{d:%b %Y}" for d in q["dates"]] + ([f"TTM {t['end']:%b %Y}"] if t else [])
    qs.cell(top, 1, "Rs crore").font = Font(bold=True)
    for j, h in enumerate(heads):
        qs.cell(top, 2 + j, h).font = Font(bold=True)
    rows = {key: top + 1 + i for i, (_, key) in enumerate(Q_LAYOUT)}
    for label, key in Q_LAYOUT:
        r = rows[key]
        qs.cell(r, 1, label).font = Font(bold=key in ("op_profit", "net_profit"))
        for j in range(len(heads)):
            c, x = qs.cell(r, 2 + j), get_column_letter(2 + j)
            if key == "opm":
                op, sales = f"{x}{rows['op_profit']}", f"{x}{rows['sales']}"
                c.value = f'=IF(AND(ISNUMBER({op}),ISNUMBER({sales}),N({sales})>0),{op}/{sales},"")'
            elif j < nq:
                c.value = q["rows"][key][j]
            else:
                span = f"{get_column_letter(2 + nq - 4)}{r}:{get_column_letter(1 + nq)}{r}"
                c.value = f'=IF(COUNT({span})=4,SUM({span}),"")'
            c.number_format = formats["pct" if key == "opm" else "num"]
            c.font = Font(bold=key in ("op_profit", "net_profit") or j == nq)
    qs.column_dimensions["A"].width = 28
    for j in range(len(heads)):
        qs.column_dimensions[get_column_letter(2 + j)].width = 12
    qs.freeze_panes = qs.cell(top + 1, 2)


# ---------- peers (5.2): the same measures for the company and each peer, by rules ----------

PEERS = (  # key, label, kind, direction: 1 = higher ranks first, -1 = lower ranks first (less debt, cheaper)
    ("mcap", "Market cap, Rs crore", "num", 1), ("pe", "P/E", "x", -1), ("ev_ebitda", "EV/EBITDA", "x", -1),
    ("pb", "P/B", "x", -1), ("revenue", "Revenue, Rs crore", "num", 1),
    ("g3", "Revenue growth, 3 years", "pct", 1), ("g5", "Revenue growth, 5 years", "pct", 1),
    ("ebitda_margin", "EBITDA margin", "pct", 1), ("net_margin", "Net margin", "pct", 1), ("roce", "ROCE", "pct", 1),
    ("cash_conv", "Cash conversion (CFO / net profit, 3 years)", "pct", 1), ("nd_ebitda", "Net debt / EBITDA", "x", -1),
)


def peer_metrics(hist, price=None, shares=None):
    """One company's comparison measures from its reported years (the last one = hist[-1]) and a price and share
    count: size, revenue CAGRs, margins, ROCE (returns()), cash conversion, net debt / EBITDA and P/E, EV/EBITDA, P/B
    at that price (_multiples(), minorities as the median share of profit over the last 3 years, so one exceptional
    year doesn't inflate it; the company's own EV/EBITDA can differ a little from the Valuation page's, which uses the
    base case's). None where a number or a positive base is missing."""
    h, n = hist[-1], len(hist)
    r = returns(h, hist[-2] if n > 1 else None)
    last3 = hist[-3:]
    cfo, pat = [x.get("cfo") for x in last3], sum(x["pat"] for x in last3)
    mcap = price * shares if price and shares and price > 0 and shares > 0 else None
    shares_mi = [max(0.0, (a - x["pat"]) / a) for x in last3 if (a := x["pbt"] - x["tax"]) > 0]
    nci = statistics.median(shares_mi) if shares_mi else 0.0
    rev = h["revenue"] if h["revenue"] > 0 else None
    return {"mcap": mcap, "revenue": h["revenue"],
            "g3": _cagr(hist[-4]["revenue"], h["revenue"], 3) if n > 3 else None,
            "g5": _cagr(hist[-6]["revenue"], h["revenue"], 5) if n > 5 else None,
            "ebitda_margin": rev and h["ebitda"] / rev, "net_margin": rev and h["pat"] / rev, "roce": r["roce"],
            "cash_conv": sum(cfo) / pat if n >= 3 and pat > 0 and None not in cfo else None,
            "nd_ebitda": r["nd_ebitda"], **_multiples(mcap, _debt(h) - h["cash"] - h["investments"], h, min(nci, 0.99))}


def peer_table(own, peers):
    """The company ({name, symbol, year, metrics}) against its peers (the same, or {symbol, error}): per measure the
    peers' median (the company left out) and the company's rank among everyone that has it, 1 = best (PEERS'
    direction; ties share a rank), `of` = how many were ranked."""
    ok = [p for p in peers if p.get("metrics")]
    out = {"own": own, "peers": peers, "median": {}, "rank": {}, "of": {}, "columns": PEERS}
    for k, _, _, way in PEERS:
        xs = [x for p in ok if (x := p["metrics"].get(k)) is not None]
        mine = own["metrics"].get(k)
        out["median"][k] = statistics.median(xs) if xs else None
        v = (lambda x: max(x, 0.0)) if k == "nd_ebitda" else (lambda x: x)  # net cash: all tie as the least debt  # noqa: E731
        out["rank"][k] = None if mine is None else 1 + sum((v(x) - v(mine)) * way > 0 for x in xs)
        out["of"][k] = len(xs) + (mine is not None)
    return out


def _peers_sheet(wb, t, at, formats):
    """'Peers' sheet: the peer table as values at export (no formulas: the peers' numbers aren't in this workbook)."""
    ps = wb.create_sheet("Peers")
    ps["A1"] = (f"Peers at export, {at:%d %b %Y}: values, not formulas. Each company's last reported year; market cap "
                "and multiples at the NSE price when its data was fetched (this company: the price in this model). "
                "Rank 1 = best: largest, fastest growth, highest margins, returns and cash conversion, least debt, "
                "cheapest multiple. Median = the peers', this company left out.")
    ps["A1"].font = Font(italic=True, color="808080")
    top, bold = 3, Font(bold=True)
    for j, h in enumerate(["Company", "Symbol", "Year", *(label for _, label, _, _ in PEERS)]):
        ps.cell(top, 1 + j, h).font = bold
    rows = [t["own"], *t["peers"]]
    for i, p in enumerate(rows):
        r = top + 1 + i
        ps.cell(r, 1, p.get("name") or p.get("symbol")).data_type = "s"
        ps.cell(r, 2, p.get("symbol"))
        ps.cell(r, 3, p.get("year") or p.get("error"))
        for j, (k, _, kind, _) in enumerate(PEERS):
            c = ps.cell(r, 4 + j, (p.get("metrics") or {}).get(k))
            c.number_format = formats[kind]
        for j in range(3 + len(PEERS)):
            ps.cell(r, 1 + j).font = Font(bold=i == 0)
    r = top + 1 + len(rows)
    ps.cell(r, 1, "Peer median").font = bold
    ps.cell(r + 1, 1, f"{t['own'].get('name')}: rank").font = bold
    for j, (k, _, kind, _) in enumerate(PEERS):
        ps.cell(r, 4 + j, t["median"][k]).number_format = formats[kind]
        ps.cell(r + 1, 4 + j, None if t["rank"][k] is None else f"{t['rank'][k]} of {t['of'][k]}")
    ps.column_dimensions["A"].width = 34
    for j in range(2 + len(PEERS)):
        ps.column_dimensions[get_column_letter(2 + j)].width = 13
    ps.freeze_panes = ps.cell(top + 1, 2)


def col(j):
    """Valuation sheet column for explicit year j (B = first projected year)."""
    return get_column_letter(2 + j)


def to_excel(co, scenarios, n=5, active="base", val=None, peers=None, at=None):
    """Workbook bytes: historicals as values, projections as live formulas, inputs in blue.
    scenarios: {"base"|"bull"|"bear": {key: {"start", "end"}}}. Each scenario's per-year inputs (from expand())
    sit on the Scenarios sheet; the Model sheet's driver cells pick one with CHOOSE on the selector in B3.
    val: VALUATION-shaped inputs for the Valuation sheet (None = defaults). co may carry upgrade()'s filings data.
    peers: peer_table()'s result, written as values on a Peers sheet (at = the export time)."""
    wb = openpyxl.Workbook()
    cogs, used = on_cogs(co["hist"]), (co.get("sources") or {}).get("used") or {}
    ws = wb.active
    ws.title = "Model"
    ws["A1"] = co["name"]
    ws["A1"].data_type = "s"  # a name starting with '=' must not become a live formula
    ws["A1"].font = Font(bold=True, size=14)
    got = "; ".join(f"{what} {', '.join(used[k])}" for k, what in (
        ("payables", "trade payables"), ("lease", "lease liabilities"), ("capex", "cash-flow capex")) if used.get(k))
    ar = ", ".join(used.get("capex_ar") or [])
    ws["A2"] = ("Rs crore. Source: Excel export" + (f", plus XBRL filings ({got})" if got else "")
                + (f", plus cash-flow capex read from the annual report and approved ({ar})" if ar else "")
                + (f"; the forecast's base leaves out a business moved out of {used['moved_out'][0]} (inputs under the table)"
                   if used.get("moved_out") else "")
                + ". Blue = input (B3 and the Scenarios sheet), green = picked from the Scenarios sheet, black = formula. "
                + f"Inventory and payable days are on {'COGS' if cogs else 'revenue'}.")
    ws["A2"].font = Font(italic=True, color="808080")
    ws["A3"] = "Scenario (1 = base, 2 = bull, 3 = bear)"
    ws["B3"] = SCENARIOS.index(active) + 1
    ws["B3"].font = Font(bold=True, color="0000FF")
    ws["C3"] = '=CHOOSE(B3,"Base","Bull","Bear")'
    pick = DataValidation(type="whole", operator="between", formula1="1", formula2="3", showErrorMessage=True,
                          error="Enter 1 (base), 2 (bull) or 3 (bear).")
    ws.add_data_validation(pick)
    pick.add("B3")

    top = 4  # header row
    rows = {key: top + 1 + i for i, (_, key, _) in enumerate(LAYOUT) if key}
    nh = len(co["hist"])
    headers = labels(co["dates"]) + [fy(d, True) for d in projected_dates(co, n)]
    bold, totals = Font(bold=True), {"total_liab", "total_assets", "pat", "fcf", "fcff"}
    head_fill = PatternFill("solid", fgColor="DDE4EE")
    formats = {"pct": "0.0%", "days": "0", "num": "#,##0.0;(#,##0.0);-", "chk": "#,##0.00;(#,##0.00);-",
               "x": '0.0"x";-0.0"x"'}
    drivers = {k for k, _, _ in DRIVERS}
    src = _scenario_sheet(wb, scenarios, n, headers[nh:], formats, head_fill)
    # a business moved out of the base year (move_out): two inputs under the table, in the base year's column
    last, moved = co["hist"][-1], co["hist"][-1].get("revenue_out") is not None
    out_row, base_col = top + len(LAYOUT) + 2, get_column_letter(1 + nh)
    out_ref = f"${base_col}${out_row}"

    ws.cell(top, 1, "Rs crore").font = bold
    for j, h in enumerate(headers):
        cell = ws.cell(top, 2 + j, h)
        cell.font = bold
        if j >= nh:
            cell.fill = PatternFill("solid", fgColor="FFF2CC")

    for i, (label, key, kind) in enumerate(LAYOUT):
        r = top + 1 + i
        ws.cell(r, 1, f"{label} (on {'COGS' if cogs else 'revenue'})" if key in ("dio", "dpo") else label)
        if kind == "head":
            for j in range(len(headers) + 1):
                ws.cell(r, 1 + j).fill = head_fill
            ws.cell(r, 1).font = bold
        if not key:
            continue
        for j in range(len(headers)):
            col, prev = get_column_letter(2 + j), get_column_letter(1 + j)
            x = lambda k, p=0, col=col, prev=prev: f"{prev if p else col}{rows[k]}"  # noqa: E731
            cell = ws.cell(r, 2 + j)
            if j < nh:
                h = co["hist"][j]  # missing cash-flow lines stay blank instead of 0-based formulas
                # cash-flow capex from a filing is a reported number, not the net block formula
                cell.value = (h.get(key) if key in RAW or h.get(key, 0) is None
                              or (key == "capex" and h.get("capex_cf") is not None)
                              # =cfo-capex needs no earlier column when the year's capex is a cash-flow value
                              else _hist_formula(key, x, j > 0 or (key == "fcf" and h.get("capex_cf") is not None), cogs))
            elif key == "revenue" and j == nh and moved:
                cell.value = f'=({x("revenue", 1)}-{out_ref})*(1+{x("growth")})'
            else:
                cell.value = (f"=CHOOSE($B$3,{','.join(src(s, key, j - nh) for s in SCENARIOS)})"
                              if key in drivers else _proj_formula(key, x, cogs))
            cell.number_format = formats[kind]
            cell.font = Font(bold=key in totals, color="008000" if j >= nh and key in drivers else None)
        ws.cell(r, 1).font = Font(bold=key in totals)

    if moved:
        y = headers[nh - 1]
        reason = (co.get("sources") or {}).get("moved_out", {}).get("reason") or "a business that left the group"
        for k, (label, v) in enumerate(((f"Revenue moved out of the {y} base ({reason})", last["revenue_out"]),
                                        (f"EBITDA moved out of the {y} base", last["ebitda_out"]))):
            ws.cell(out_row + k, 1, label).data_type = "s"
            c = ws.cell(out_row + k, 1 + nh, v)
            c.font, c.number_format = Font(color="0000FF"), formats["num"]
        rev, ebitda = f"{base_col}{rows['revenue']}", f"{base_col}{rows['ebitda']}"
        ws.cell(out_row + 2, 1, f"{y} EBITDA margin without it (the default margin uses this year)")
        c = ws.cell(out_row + 2, 1 + nh, f"=IFERROR(({ebitda}-{base_col}{out_row + 1})/({rev}-{out_ref}),\"\")")
        c.number_format = formats["pct"]
    ws.column_dimensions["A"].width = 34
    for j in range(len(headers)):
        ws.column_dimensions[get_column_letter(2 + j)].width = 11
    ws.freeze_panes = ws.cell(top + 1, 2)
    ex = {s: expand(scenarios[s], n) for s in SCENARIOS}
    v = valuation({s: project(co["hist"], ex[s], n) for s in SCENARIOS}, co["hist"], val, ex["base"],
                  co.get("market"), inputs=ex)
    _valuation_sheet(wb, co, n, v, src, lambda k, j: f"{get_column_letter(2 + j)}{rows[k]}", headers[nh:],
                     formats, head_fill)
    if co.get("quarters"):
        _quarters_sheet(wb, co["quarters"], formats)
    if peers:
        _peers_sheet(wb, peers, at or datetime.now(), formats)
    cash_proj = f"{get_column_letter(2 + nh)}{rows['cash']}:{get_column_letter(1 + len(headers))}{rows['cash']}"
    ws.conditional_formatting.add(cash_proj, CellIsRule(operator="lessThan", formula=["0"],
                                                        font=Font(color="C00000", bold=True),
                                                        fill=PatternFill("solid", fgColor="FDE2E1")))

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
