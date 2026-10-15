"""Run: uv run python test_model.py  (Excel formula check needs LibreOffice `soffice` on PATH)."""
import io
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

import openpyxl

import model


def fake_screener(path, years=10):
    """Synthetic file in Screener.in 'Data Sheet' layout with internally consistent numbers."""
    dates = [datetime(2016 + i, 3, 31) for i in range(years)]
    pl = {k: [] for k in ("Sales", "Raw Material Cost", "Other Income", "Depreciation", "Interest",
                          "Profit before tax", "Tax", "Net profit", "Dividend Amount")}
    bs = {k: [] for k in ("Equity Share Capital", "Reserves", "Borrowings", "Other Liabilities", "Total",
                          "Net Block", "Capital Work in Progress", "Investments", "Other Assets", "Total#2",
                          "Receivables", "Inventory", "Cash & Bank")}
    for i in range(years):
        rev = 1000 * 1.12 ** i
        dep, interest, oi = 40 + 3 * i, 20.0, 0.02 * rev
        pbt = 0.2 * rev + oi - dep - interest
        tax = 0.25 * pbt
        for k, v in zip(pl, (rev, 0.5 * rev, oi, dep, interest, pbt, tax, pbt - tax, 0.3 * (pbt - tax))):
            pl[k].append(round(v, 2))
        liab = (50, 400 + 80 * i, 200, 0.15 * rev)
        total = sum(liab)
        nb, cwip, inv = 500 + 30 * i, 20, 60
        rec, stock = 0.12 * rev, 0.08 * rev
        other_assets = total - nb - cwip - inv
        cash = other_assets - rec - stock - 0.03 * rev
        for k, v in zip(bs, (*liab, total, nb, cwip, inv, other_assets, total, rec, stock, cash)):
            bs[k].append(round(v, 2))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Data Sheet"
    ws.append(["COMPANY NAME", "Test Industries Ltd"])
    ws.append([])
    ws.append(["PROFIT & LOSS"])
    ws.append(["Report Date", *dates])
    for k, v in pl.items():
        ws.append([k, *v])
    ws.append(["Quarters"])
    ws.append(["Report Date", *dates[:4]])
    ws.append(["Sales", 1, 2, 3, 4])  # must not clobber annual Sales
    ws.append(["BALANCE SHEET"])
    ws.append(["Report Date", *dates])
    for k, v in bs.items():
        ws.append([k.split("#")[0], *v])
    ws.append(["CASH FLOW:"])
    ws.append(["Report Date", *dates])
    ws.append(["Cash from Operating Activity", *[100.0] * years])
    wb.save(path)


def recalc(xlsx, outdir):
    """LibreOffice headless round-trip so formula cells get computed values."""
    subprocess.run(["soffice", "--headless", "--convert-to", "xlsx", "--outdir", str(outdir), str(xlsx)],
                   check=True, capture_output=True, timeout=120)
    return openpyxl.load_workbook(Path(outdir) / Path(xlsx).name, data_only=True)["Model"]


def main():
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "screener.xlsx"
    fake_screener(src)

    co = model.parse_screener(src)
    assert co["name"] == "Test Industries Ltd"
    assert len(co["hist"]) == 10
    assert co["hist"][0]["revenue"] == 1000.0, "quarterly Sales leaked into annual data"
    assert model.data_checks(co) == [], model.data_checks(co)
    assert co["hist"][1]["cfi"] is None and co["hist"][1]["net_cf"] is None, "missing CF rows must not be 0"

    a = model.default_assumptions(co["hist"])
    assert abs(a["growth"] - 0.12) < 1e-3 and abs(a["ebitda_margin"] - 0.2) < 1e-3, a
    assert abs(a["tax_rate"] - 0.25) < 1e-3 and abs(a["dso"] - 0.12 * 365) < 0.1, a

    # defaults: CAGR not mean of YoY, ratio-of-sums not mean of ratios, median other income
    h = [dict(co["hist"][-1]) for _ in range(4)]
    for x, r, b, i in zip(h, (100, 50, 100, 100), (2, 2, 500, 500), (0, 15, 45, 45)):
        x.update(revenue=r, borrowings=b, interest=i, other_income=0.02 * r)
    h[-1]["other_income"] = -900  # one-off write-down
    d = model.default_assumptions(h)
    assert abs(d["growth"]) < 1e-9 and d["int_rate"] < 0.3 and d["oi_pct"] == 0.02, d

    for edit, msg in ((_bankify, "bank"), (_no_dimension, None), (_text_cell, "not a number")):
        p = tmp / f"{edit.__name__}.xlsx"
        fake_screener(p)
        edit(p)
        try:
            model.parse_screener(p)
            assert msg is None, f"{edit.__name__}: expected ValueError"
        except ValueError as e:
            assert msg and msg in str(e), (edit.__name__, e)
    try:
        model.parse_screener(io.BytesIO(b"not a zip"))
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "Export to Excel" in str(e)

    # return ratios: averages of opening and closing balances, first year on closing
    h0, h1 = co["hist"][0], co["hist"][1]
    eq = lambda h: h["share_cap"] + h["reserves"]  # noqa: E731
    assert abs(h0["roe"] - h0["pat"] / eq(h0)) < 1e-12
    assert abs(h1["roe"] - h1["pat"] / ((eq(h0) + eq(h1)) / 2)) < 1e-12
    assert abs(h1["roce"] - (h1["pbt"] + h1["interest"]) / ((eq(h0) + eq(h1) + 400) / 2)) < 1e-12
    assert abs(h1["asset_turnover"] - h1["revenue"] / ((h0["total_assets"] + h1["total_assets"]) / 2)) < 1e-12
    assert abs(h1["int_cover"] - (h1["pbt"] + 20) / 20) < 1e-12
    assert abs(h1["nd_ebitda"] - (200 - h1["cash"] - 60) / h1["ebitda"]) < 1e-12
    neg = model.returns(dict(h1, interest=0.0, ebitda=-1.0, reserves=-1000.0), h0)
    assert neg["int_cover"] is None and neg["nd_ebitda"] is None and neg["roe"] is None, neg

    assert abs(a["mi_pct"]) < 1e-3, a  # synthetic PAT = PBT - tax
    a["debt_change"] = 25.0
    a["mi_pct"] = -0.05  # exercise the minority path in the Excel parity check below
    a["capex_pct"] = 0.35  # heavy capex: forces the automatic shortfall borrowing
    proj = model.project(co["hist"], a, n=5)
    for c in proj:
        assert abs(c["chk_bs"]) < 1e-6 and abs(c["chk_cash"]) < 1e-6, c
        assert c["cash"] >= -1e-9, c
    assert any(c["revolver"] > 0 for c in proj), "test should exercise the revolver"

    try:
        model.parse_screener(_blank(tmp))
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "Data Sheet" in str(e)

    out = tmp / "model.xlsx"
    out.write_bytes(model.to_excel(co, a, n=5))
    if not shutil.which("soffice"):
        print("SKIP Excel formula check: soffice not found")
        return
    ws = recalc(out, tmp / "calc")
    rows = {key: 5 + i for i, (_, key, _) in enumerate(model.LAYOUT) if key}
    for j, c in enumerate(proj):
        _same(ws, rows, 2 + len(co["hist"]) + j, c, ("proj", j))
    for j, h in enumerate(co["hist"]):  # historical ratio formulas, incl. first year on closing balances
        _same(ws, rows, 2 + j, {k: h[k] for k in ("ebitda", *RETURNS)}, ("hist", j))
    # zero interest and negative EBITDA must come out blank in both
    zero = dict(a, int_rate=0.0, ebitda_margin=-0.05)
    proj0 = model.project(co["hist"], zero, n=2)
    assert all(c["int_cover"] is None and c["nd_ebitda"] is None for c in proj0), proj0
    (tmp / "zero").mkdir()
    (tmp / "zero" / "model.xlsx").write_bytes(model.to_excel(co, zero, n=2))
    ws0 = recalc(tmp / "zero" / "model.xlsx", tmp / "calc0")
    for j, c in enumerate(proj0):
        _same(ws0, rows, 2 + len(co["hist"]) + j, c, ("zero", j))
    print("OK: parse, checks, projection, Excel formulas match Python")


RETURNS = ("roe", "roce", "asset_turnover", "nd_ebitda", "int_cover")


def _same(ws, rows, col, values, where):
    """Recalculated Excel column equals Python; Python None = blank cell."""
    for key, v in values.items():
        got = ws.cell(rows[key], col).value
        if v is None:
            assert got in (None, ""), (key, where, got)
        else:
            assert isinstance(got, (int, float)) and abs(got - v) < 1e-6 * max(1, abs(v)), (key, where, got, v)


def _edit_rows(path, fn):
    wb = openpyxl.load_workbook(path)
    for row in wb["Data Sheet"].iter_rows():
        fn(row[0].value, row)
    wb.save(path)


def _bankify(path):
    """Bank layout: same labels, Receivables/Inventory blank, interest ~half of sales."""
    def fn(label, row):
        if label in ("Receivables", "Inventory"):
            for c in row[1:]:
                c.value = None
        if label == "Interest":
            for c in row[1:]:
                c.value = 500.0
    _edit_rows(path, fn)


def _text_cell(path):
    _edit_rows(path, lambda label, row: label == "Tax" and setattr(row[3], "value", "1,000.00x"))


def _no_dimension(path):
    """Blank last Net profit cell and strip <dimension> so read_only rows come back ragged."""
    _edit_rows(path, lambda label, row: label == "Net profit" and setattr(row[-1], "value", None))
    with zipfile.ZipFile(path) as z:
        files = {n: z.read(n) for n in z.namelist()}
    files["xl/worksheets/sheet1.xml"] = re.sub(rb"<dimension[^>]*/>", b"", files["xl/worksheets/sheet1.xml"])
    with zipfile.ZipFile(path, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)


def _blank(tmp):
    p = tmp / "blank.xlsx"
    openpyxl.Workbook().save(p)
    return p


if __name__ == "__main__":
    main()
