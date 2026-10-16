"""Run: uv run uvicorn server:app  (serves the API and the built web/dist front end)."""
import contextlib
import hashlib
import io
import json
import math
import os
import re
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, ValidationError, model_validator

import ai
import model

MAX_UPLOAD = 5 * 1024 * 1024  # Screener exports are ~50 KB
MAX_SAVE = 512 * 1024  # a saved model document is ~10-20 KB
MODELS = Path(__file__).parent / "models"  # the local library, gitignored
MAPPINGS = "mappings.json"  # approved XBRL tag -> std key, at the library root (list_models only reads */*.json)
FILINGS = "_filings"  # the XBRL files as uploaded, <id>.xml, re-read when a mapping is approved ("_": never a slug)
FILING_ID = re.compile(r"[0-9a-f]{12}")
REPORTS = "_reports"  # annual-report PDFs as page text, <id>.json (ai.pdf_pages); the PDF itself isn't kept
MAX_PDF = 60 * 1024 * 1024  # annual reports run 5-30 MB
MAX_ASK = 80  # unmapped tags sent to the LLM per proposal round; a results filing has ~10-50
MODEL_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*/\d{4}-\d{2}-\d{2}")  # <company-slug>/<YYYY-MM-DD>
app = FastAPI()


@app.exception_handler(RequestValidationError)
def _invalid(_, exc):
    # the default handler echoes inputs back, and a NaN among them can't be JSON-encoded
    msgs = "; ".join(f"{'.'.join(map(str, e['loc'][1:]))}: {e['msg']}" for e in exc.errors())
    return JSONResponse({"detail": f"Invalid request: {msgs}"}, status_code=422)


@app.exception_handler(OSError)
def _disk(_, exc):
    # library reads and writes (full disk, read-only folder): say what failed instead of a bare 500
    return JSONResponse({"detail": f"Couldn't read or write the models folder: {exc.strerror or exc}."},
                        status_code=500)


REQUIRED = [*model.PL.values(), *model.BS.values(), "ebitda", "other_ca"]  # always numbers from parse_screener


class Market(BaseModel):
    """Share price (Rs) and count (crore) from the export; null when Screener left it out."""
    price: FiniteFloat | None = None
    shares: FiniteFloat | None = None
    price_hist: list[FiniteFloat | None] = []
    shares_hist: list[FiniteFloat | None] = []


class Quarters(BaseModel):
    """The export's Quarters block (model.QUARTERS keys), one value or null per quarter."""
    dates: list[datetime]
    rows: dict[str, list[FiniteFloat | None]]

    @model_validator(mode="after")
    def _lengths(self):
        if any(len(v) != len(self.dates) for v in self.rows.values()):
            raise ValueError("quarters need one value per quarter date in every row")
        return self


class Company(BaseModel):
    name: str
    dates: list[datetime]
    hist: list[dict[str, float | None]]
    market: Market = Market()  # version-3 documents saved before 2.1 have none
    quarters: Quarters | None = None  # none in the export (Milky Mist), or saved before 3.5

    @model_validator(mode="after")
    def _years(self):
        """Every endpoint and the library go through here, so a hand-made or damaged company is a 422."""
        if len(self.hist) < 2 or len(self.dates) != len(self.hist):
            raise ValueError("company needs at least two reported years, with one date per year")
        for i, row in enumerate(self.hist):
            bad = [k for k in REQUIRED if not isinstance(row.get(k), float) or not math.isfinite(row[k])]
            if bad:
                raise ValueError(f"company.hist[{i}] is missing numbers for {', '.join(bad)}")
        return self


class DriverPath(BaseModel):
    start: FiniteFloat
    end: FiniteFloat | None = None  # None = flat; else a straight fade from start to end over the projection


Scenario = Literal["base", "bull", "bear"]
V = model.VALUATION


class Valuation(BaseModel):
    """DCF inputs (model.VALUATION). kd None = base scenario's interest rate; price/shares None = market data."""
    rf: FiniteFloat = V["rf"]
    erp: FiniteFloat = V["erp"]
    beta: FiniteFloat = V["beta"]
    kd: FiniteFloat | None = V["kd"]
    g: FiniteFloat = V["g"]
    mid_year: bool = V["mid_year"]
    wacc_override: FiniteFloat | None = V["wacc_override"]
    price: FiniteFloat | None = Field(V["price"], gt=0)
    shares: FiniteFloat | None = Field(V["shares"], gt=0)


class Check(BaseModel):
    name: str
    pass_: bool | None = Field(alias="pass")  # None = nothing to compare with (a note)
    detail: str
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)


class Filing(BaseModel):
    """An attached XBRL filing (model.parse_xbrl plus id and file name). Read by rules; an annual one that ties to
    Screener adds payables, leases and cash-flow capex to its year (model.upgrade)."""
    id: str
    file: str
    kind: Literal["quarter", "half", "annual", "other"]
    company: str | None = None
    period_start: str | None = None
    period_end: str | None
    consolidated: bool | None = None
    facts: dict[str, FiniteFloat]
    unmapped: list[dict] = []
    checks: list[Check] = []
    model_config = ConfigDict(extra="allow")  # later Phase 3 features may add fields; keep them on save


class Report(BaseModel):
    """An attached annual-report PDF: its page text is in models/_reports/<id>.json; `year` is the label it was
    attached for (FY2020)."""
    id: str = Field(pattern=r"^[0-9a-f]{12}$")
    file: str
    year: str
    pages: int
    model_config = ConfigDict(extra="allow")  # 3.3 may add fields


NEW_DRIVERS = ("cogs_pct", "dpo")  # added in 3.4; scenarios saved before lack them


class ModelRequest(BaseModel):
    """The model document (version 4) minus what the engine ignores (excluded_years, saved_at)."""
    company: Company
    scenarios: dict[Scenario, dict[str, DriverPath]]
    active: Scenario = "base"
    n: int = 5
    valuation: Valuation = Valuation()
    filings: list[Filing] = []
    notes: dict = {}  # "oneoff:FY2020" (3.2b, words), "ar:<topic>:FY2021" (3.3); an approved capex note feeds capex

    @model_validator(mode="after")
    def _new_drivers(self):
        """Scenarios saved before 3.4 get COGS % revenue at its default (0 for them: their company has no COGS
        line, so inventory days stay on revenue) and payable days at 0: their other-liabilities % still includes
        payables, so a default would count them twice. Their numbers stay exactly as they were."""
        if all(k in a for a in self.scenarios.values() for k in NEW_DRIVERS):
            return self
        d = model.default_assumptions(self.upgraded()["hist"])
        for a in self.scenarios.values():
            a.setdefault("cogs_pct", DriverPath(start=d["cogs_pct"]))
            a.setdefault("dpo", DriverPath(start=0.0))
        return self

    def upgraded(self):
        """The company with what the attached filings and approved capex notes add (model.upgrade), as the engine uses it."""
        return model.upgrade(self.company.model_dump(), [f.model_dump() for f in self.filings], ar_capex(self.notes))

    def args(self):
        if not 1 <= self.n <= 15:
            raise HTTPException(422, "Projection years must be between 1 and 15.")
        if len(self.scenarios) != len(model.SCENARIOS):
            raise HTTPException(422, f"Need all three scenarios: {list(model.SCENARIOS)}")
        for s, a in self.scenarios.items():
            missing = {k for k, _, _ in model.DRIVERS} - a.keys()
            if missing:
                raise HTTPException(422, f"Missing assumptions in {s}: {sorted(missing)}")
        sc = {s: {k: v.model_dump() for k, v in a.items()} for s, a in self.scenarios.items()}
        return self.upgraded(), sc, self.n

    def projection(self):
        co, sc, n = self.args()
        out = {s: model.project(co["hist"], model.expand(sc[s], n), n) for s in model.SCENARIOS}
        for s, proj in out.items():
            if any(v is not None and not math.isfinite(v) for row in proj for v in row.values()):
                raise HTTPException(422, f"Those {s} assumptions make the numbers too large to project. "
                                         "Try smaller values.")
        return co, sc, n, out

    def dcf(self, co, sc, n, out):
        ex = {s: model.expand(sc[s], n) for s in model.SCENARIOS}
        v = model.valuation(out, co["hist"], self.valuation.model_dump(), ex["base"], co["market"], inputs=ex)
        try:  # extreme but finite inputs (shares 1e-320, rates 1e308) can overflow; JSON can't carry inf/NaN
            json.dumps(v, allow_nan=False)
        except ValueError:
            raise HTTPException(422, "Those valuation inputs make the numbers too large to value. Try smaller values.")
        return v


class ModelDoc(ModelRequest):
    """The full model document as saved in the library. Version 3 (before valuation) loads with default inputs;
    versions 3 and 4 load with empty Phase 3 blocks."""
    version: Literal[3, 4, 5]
    excluded_years: list[str] = []
    saved_at: str | None = None
    # ponytail: untyped dicts (mapping proposals, 3.2, add "filing": the filing id). proposals: [{id, kind (mapping | oneoff_note | ar_note), field, value, unit, period, source: {file,
    # page, quote, tag}, reasoning, checks: [{name, pass, detail}], status (proposed | approved | rejected), ai}];
    # notes: approved oneoff_note / ar_note results keyed for display
    proposals: list[dict] = []
    # notes (in ModelRequest): "oneoff:FY2020": {proposal, summary, file, page, quote, from_numbers, ai} (3.2b);
    # "ar:segments:FY2021": {proposal, topic, year, file, rows, total, against, ai} (3.3)
    reports: list[Report] = []  # attached annual reports (3.2b); added within version 5, so it defaults to none

    @model_validator(mode="after")
    def _migrate(self):
        self.version = 5  # v3 -> v4 added "valuation", v4 -> v5 the blocks above; all already defaulted
        return self


def ar_capex(notes):
    """{year label: Rs crore} from approved annual-report capex notes ("ar:capex:FY2021"); the client keeps notes
    in step with the approved proposals, and the server's rules checked each before approving it."""
    out = {}
    for k, v in (notes or {}).items():
        t = isinstance(v, dict) and v.get("total")
        if k.startswith("ar:capex:") and isinstance(t, (int, float)) and math.isfinite(t) and t >= 0:
            out[k.removeprefix("ar:capex:")] = float(t)
    return out


def _company_payload(co, excluded=(), filings=(), notes=None):
    """What the dashboard derives from the company. Ratios, defaults and one-offs use the upgraded history (with the
    filings' payables, leases and cash-flow capex); "company" stays as parsed, for the document."""
    labels, q, up = model.labels(co["dates"]), co.get("quarters"), model.upgrade(co, filings, ar_capex(notes))
    return {
        "company": {"name": co["name"], "dates": [d.isoformat() for d in co["dates"]], "hist": co["hist"],
                    "market": co.get("market") or Market().model_dump(),
                    "quarters": q and {"dates": [d.isoformat() for d in q["dates"]], "rows": q["rows"]}},
        "ttm": model.ttm(q), "ttm_prev": model.ttm(q, 4),  # last four quarters, and the four before them
        "years": labels,
        "hist": up["hist"], "sources": up["sources"],
        "ratios": model.ratios(up["hist"]),
        "defaults": model.default_assumptions(up["hist"], exclude=set(excluded), labels=labels),
        "checks": model.data_checks(co),
        "oneoffs": model.detect_oneoffs(up["hist"], labels),
        "valuation": model.VALUATION,  # defaults for a new document
        "drivers": model.DRIVERS,
        "layout": model.LAYOUT,
    }


@app.post("/api/parse")
async def parse(file: UploadFile):
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "That file is over 5 MB. A Screener export is usually under 100 KB.")
    try:
        co = model.parse_screener(io.BytesIO(data))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception:  # corrupt / not an xlsx
        raise HTTPException(422, "Couldn't read that file as an Excel workbook. Upload the .xlsx from "
                                 "Screener.in's 'Export to Excel' button.")
    return _company_payload(co) | {"restated": restatements(co)}


def load_mappings(root=MODELS):
    """The user's approved tag mappings ({tag: std key}); none when the file is missing or damaged."""
    try:
        m = json.loads((root / MAPPINGS).read_bytes())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in m.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(m, dict) else {}


@app.post("/api/xbrl")
async def xbrl(file: UploadFile, company: str | None = Form(None)):
    """Read an XBRL results filing by rules (tie checks against `company`, the open model's company as JSON). The
    client adds the returned filing to its document's `filings`, and autosave stores it."""
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "That file is over 5 MB. A results XBRL filing is usually under 100 KB.")
    try:
        co = Company.model_validate_json(company).model_dump() if company else None
    except ValidationError:
        raise HTTPException(422, "The open model's company data is damaged; reload the model and try again.")
    try:
        f = model.parse_xbrl(data, mappings=load_mappings(MODELS), company=co)
    except ValueError as e:
        raise HTTPException(422, str(e))
    fid = hashlib.sha1(data).hexdigest()[:12]
    _write(MODELS / FILINGS / f"{fid}.xml", data)  # kept to be re-read by rules when a mapping is approved
    return {"id": fid, "file": (file.filename or "filing.xml")[:200], **f}


# ---------- AI-proposed mappings for leftover tags: the LLM proposes, rules check, the user approves ----------

@app.get("/api/ai")
def ai_status():
    return {"available": ai.available(), "message": None if ai.available() else ai.NOT_SET,
            "pdf": ai.pdf_available(), "pdf_message": None if ai.pdf_available() else ai.PDF_MISSING}


class ProposeRequest(BaseModel):
    filing: Filing


@app.post("/api/mappings/propose")
def propose(req: ProposeRequest):
    """Ask the LLM which std key each unmapped tag is, and check every answer by rules (model.mapping_checks). The
    proposals go back to the client, which keeps them in the document; nothing is used until approved."""
    if not ai.available():
        raise HTTPException(503, ai.NOT_SET)
    f = req.filing.model_dump()
    asked = f["unmapped"][:MAX_ASK]  # ponytail: one round of the first 80; propose again after approving some
    if not asked:
        raise HTTPException(422, "This filing has no unmapped tags.")
    try:
        items = ai.propose_mappings(asked, model.XBRL_KEYS, f)
    except ai.LLMError as e:
        raise HTTPException(502, str(e))
    seen = set()
    items = [x for x in items if not (x["tag"] in seen or seen.add(x["tag"]))]  # one answer per tag, the first
    keys = [x["std_key"] for x in items]
    out = []
    for i, x in enumerate(items):
        if x["std_key"] is None:
            continue
        value, unit, checks = model.mapping_checks(f, x["tag"], x["std_key"], keys[:i] + keys[i + 1:])
        out.append({"id": hashlib.sha1(f"{f['id']}:{x['tag']}:{x['std_key']}".encode()).hexdigest()[:12],
                    "kind": "mapping", "filing": f["id"], "field": x["std_key"][:80], "value": value, "unit": unit,
                    "period": f["period_end"], "source": {"file": f["file"], "page": None, "quote": None, "tag": x["tag"]},
                    "reasoning": str(x.get("reasoning") or "")[:500], "checks": checks, "status": "proposed", "ai": True})
    return {"proposals": out, "left": [x["tag"] for x in items if x["std_key"] is None]}


class Decision(BaseModel):
    proposal: dict
    filings: list[Filing] = []  # the document's filings, re-read with the new mappings
    company: Company | None = None  # for the tie checks on re-reading


def _decided(req, status):
    p = req.proposal
    tag, key = (p.get("source") or {}).get("tag"), p.get("field")
    if p.get("kind") != "mapping" or not isinstance(tag, str) or not isinstance(key, str):
        raise HTTPException(422, "That isn't a mapping proposal.")
    m = load_mappings(MODELS)
    if status == "approved" and m.get(tag) != key:
        f = next((f for f in req.filings if f.id == p.get("filing")), None)
        if f is None:
            raise HTTPException(422, "The filing this proposal came from isn't attached any more.")
        _, _, checks = model.mapping_checks(f.model_dump(), tag, key)
        failed = [c for c in checks if c["pass"] is False]
        if failed:
            raise HTTPException(422, "The rules reject this mapping: " + "; ".join(c["detail"] for c in failed))
        p = dict(p, checks=checks)
        m[tag] = key
    elif status == "rejected" and m.get(tag) == key:
        del m[tag]  # an approved mapping taken back; it applies to every model in the library
    else:
        return {"proposal": dict(p, status=status), "filings": [f.model_dump() for f in req.filings], "missing": []}
    # ponytail: read-modify-write of one small file; fine for one user, a lock if two tabs approve at once
    _write(MODELS / MAPPINGS, json.dumps(m, indent=1, sort_keys=True).encode())
    co = req.company and req.company.model_dump()
    out, missing = [], []
    for f in req.filings:
        raw = MODELS / FILINGS / f"{f.id}.xml"
        if not FILING_ID.fullmatch(f.id) or not raw.is_file():
            missing.append(f.file)  # attached before raw files were kept: re-attach to apply
            out.append(f.model_dump())
            continue
        out.append({**f.model_dump(), **model.parse_xbrl(raw.read_bytes(), mappings=m, company=co)})
    return {"proposal": dict(p, status=status), "filings": out, "missing": missing}


@app.post("/api/mappings/approve")
def approve(req: Decision):
    """Save the tag's mapping to mappings.json (after the rules pass again) and re-read the filings by rules."""
    return _decided(req, "approved")


@app.post("/api/mappings/reject")
def reject(req: Decision):
    """Mark it rejected (kept for audit); if it was approved, its mapping leaves mappings.json and the filings are re-read."""
    return _decided(req, "rejected")


# ---------- one-off years explained in words (3.2b): rules pick the pages, the LLM explains, rules check the quote ----------

@app.post("/api/report")
async def report(file: UploadFile, year: str = Form(...)):
    """Read an annual-report PDF into page text by rules (pdftotext) and keep the text for explanations. The client
    adds {id, file, year, pages} to its document's `reports`."""
    data = await file.read(MAX_PDF + 1)
    if len(data) > MAX_PDF:
        raise HTTPException(413, "That file is over 60 MB. Annual reports are usually 5-30 MB.")
    try:
        pages = ai.pdf_pages(data)
    except ValueError as e:
        raise HTTPException(503 if str(e) == ai.PDF_MISSING else 422, str(e))
    rid = hashlib.sha1(data).hexdigest()[:12]
    _write(MODELS / REPORTS / f"{rid}.json", json.dumps({"file": file.filename or "", "pages": pages}).encode())
    return {"id": rid, "file": (file.filename or "report.pdf")[:200], "year": year[:20], "pages": len(pages)}


class ExplainRequest(BaseModel):
    company: Company
    filings: list[Filing] = []
    year: str
    report: Report | None = None  # None: explain from the numbers only


NOTE_LINES = (("revenue", "Revenue"), ("ebitda", "EBITDA"), ("other_income", "Other income"), ("pbt", "PBT"),
              ("tax", "Tax"), ("pat", "Net profit"), ("capex", "Capex"), ("net_block", "Net block"),
              ("borrowings", "Borrowings"))


@app.post("/api/oneoffs/explain")
def explain(req: ExplainRequest):
    """A words-only proposal (kind oneoff_note) for a year detect_oneoffs flags. With a report, rules pick the pages
    and check that the quote is on the cited page (a quote that isn't comes back rejected); without, it is marked
    as read from the numbers only. Approving it only pins the words: no number uses it."""
    if not ai.available():
        raise HTTPException(503, ai.NOT_SET)
    co = req.company.model_dump()
    labels, up = model.labels(co["dates"]), model.upgrade(co, [f.model_dump() for f in req.filings])
    flags = [o for o in model.detect_oneoffs(up["hist"], labels) if o["year"] == req.year]
    if not flags:
        raise HTTPException(422, f"{req.year} isn't flagged as an unusual year.")
    i = labels.index(req.year)
    end = co["dates"][i].date()
    rows = [(labels[j], up["hist"][j]) for j in range(max(0, i - 2), min(len(labels), i + 2))]
    numbers = "\n".join(f"{name}: " + ", ".join(f"{y} {h[k]:,.0f}" if h.get(k) is not None else f"{y} n/a" for y, h in rows)
                        for k, name in NOTE_LINES)
    r = req.report
    try:
        if r is None:
            reply = ai.explain_oneoff(req.year, flags, numbers)
            checks = [{"name": "Source", "pass": None, "detail": "From the numbers only, no filing read."}]
            source = {"file": None, "page": None, "quote": None, "tag": None}
        else:
            raw = MODELS / REPORTS / f"{r.id}.json"
            if not raw.is_file():
                raise HTTPException(422, f"The text of {r.file} isn't on this machine any more; attach it again.")
            pages = [tuple(p) for p in json.loads(raw.read_bytes())["pages"]]
            sent = ai.pick_pages(pages, {o["metric"] for o in flags}, end)
            if not sent:
                raise HTTPException(422, f"No page of {r.file} mentions exceptional items or the flagged lines. "
                                         "Explain from the numbers only instead.")
            reply = ai.explain_oneoff(req.year, flags, numbers, [(n, pages[n - 1][0]) for n in sent])
            checks = ai.quote_checks(reply, pages, sent, end)
            source = {"file": r.file, "page": reply["page"], "quote": reply["quote"].strip()[:600], "tag": None}
    except ai.LLMError as e:
        raise HTTPException(502, str(e))
    summary = reply["summary"].strip()
    ok = all(c["pass"] is not False for c in checks)
    return {"id": hashlib.sha1(f"oneoff:{req.year}:{r and r.id}:{summary}".encode()).hexdigest()[:12],
            "kind": "oneoff_note", "field": "oneoff", "value": summary, "unit": None, "period": req.year,
            "source": source, "report": r and r.id, "from_numbers": r is None,
            "reasoning": "; ".join(f["note"] for f in flags), "checks": checks,
            "status": "proposed" if ok else "rejected", "ai": True}


# ---------- annual-report notes (3.3): rules pick pages per topic, the LLM extracts, rules check, the user approves ----------

class NotesRequest(BaseModel):
    company: Company
    filings: list[Filing] = []
    report: Report
    topic: str | None = None  # extract: one of ai.TOPICS

    def year(self):
        """(row index, year end) of the report's year in the company's reported years."""
        co = self.company
        labels = model.labels(co.dates)
        if self.report.year not in labels:
            raise HTTPException(422, f"{self.report.year} isn't one of the reported years in this model.")
        i = labels.index(self.report.year)
        return i, co.dates[i].date()

    def pages(self):
        raw = MODELS / REPORTS / f"{self.report.id}.json"
        if not raw.is_file():
            raise HTTPException(422, f"The text of {self.report.file} isn't on this machine any more; attach it again.")
        return [tuple(p) for p in json.loads(raw.read_bytes())["pages"]]


def _against(req, topic, i):
    """What a topic's sum must tie to, [(label, Rs crore)], from Screener and the filings (rules)."""
    y = req.report.year
    h, up = req.company.hist[i], model.upgrade(req.company.model_dump(), [f.model_dump() for f in req.filings])
    u = up["hist"][i]
    if topic == "segments":
        return [(f"Screener's {y} revenue", h["revenue"])]
    if topic == "maturity":
        return [(f"Screener's {y} borrowings (incl. leases)", h["borrowings"])] + (
            [(f"{y} borrowings without leases (XBRL)", u["borrowings"])] if u.get("lease") else [])
    if topic == "capex":
        return [(f"the XBRL cash-flow capex for {y}", u["capex_cf"])] if y in up["sources"]["used"]["capex"] else []
    return None


def _ar_note(req, topic, reply, sent, pages):
    """The ar_note proposal for one topic's reply: values converted to Rs crore and checked by rules (ai.note_checks).
    A failed check comes back rejected (kept for audit)."""
    i, end = req.year()
    h, r = req.company.hist[i], req.report
    rows, total, checks = ai.note_checks(topic, reply, pages, sent, end, _against(req, topic, i))
    ref = {"contingent": ("Net worth", h["share_cap"] + h["reserves"]), "related": ("Revenue", h["revenue"])}.get(topic)
    against = (_against(req, topic, i) or [None])[0] or ref
    first = rows[0]
    ok = all(c["pass"] is not False for c in checks)
    return {"id": hashlib.sha1(f"ar:{topic}:{r.id}:{json.dumps(reply, sort_keys=True)}".encode()).hexdigest()[:12],
            "kind": "ar_note", "field": topic, "value": {"rows": rows, "total": total,
                                                          "against": against and {"label": against[0], "value": against[1]}},
            "unit": "Rs crore", "period": r.year,
            "source": {"file": r.file, "page": first["page"], "quote": first["quote"], "tag": None},
            "report": r.id, "pages": sent, "reply": reply,
            "reasoning": f"{ai.TOPICS[topic][0]} read from PDF page{'s' if len(sent) > 1 else ''} "
                         f"{', '.join(map(str, sent))}; printed in {reply['unit']}.",
            "checks": checks, "status": "proposed" if ok else "rejected", "ai": True}


def _topic(t):
    if t not in ai.TOPICS:
        raise HTTPException(422, f"Unknown topic {t!r}; one of {', '.join(ai.TOPICS)}.")
    return t


@app.post("/api/notes/plan")
def notes_plan(req: NotesRequest):
    """Before anything is sent: the pages rules pick per topic and the exact prompt size, so the cost shows first."""
    _, end = req.year()
    pages, out = req.pages(), {}
    for t, (title, _, _) in ai.TOPICS.items():
        sent = ai.pick_topic_pages(pages, t, end)
        chars = len(ai.note_prompt(t, req.report.year, end, [(n, ai.page_text(pages[n - 1])) for n in sent])) if sent else 0
        out[t] = {"title": title, "pages": sent, "chars": chars}
    return {"topics": out, "chars": sum(x["chars"] for x in out.values())}


@app.post("/api/notes/extract")
def notes_extract(req: NotesRequest):
    """One topic: rules pick the pages, the LLM extracts values with page and quote, rules check every value."""
    if not ai.available():
        raise HTTPException(503, ai.NOT_SET)
    topic, (_, end) = _topic(req.topic), req.year()
    pages = req.pages()
    sent = ai.pick_topic_pages(pages, topic, end)
    title = ai.TOPICS[topic][0].lower()
    if not sent:
        raise HTTPException(422, f"No page of {req.report.file} looks like the {title} note.")
    try:
        reply = ai.extract_note(topic, req.report.year, end, [(n, ai.page_text(pages[n - 1])) for n in sent])
    except ai.LLMError as e:
        raise HTTPException(502, str(e))
    if reply.get("found") is False:
        raise HTTPException(422, f"The model found no {title} on PDF pages {', '.join(map(str, sent))}.")
    return _ar_note(req, topic, reply, sent, pages)


class NoteDecision(NotesRequest):
    report: Report | None = None
    proposal: dict


@app.post("/api/notes/approve")
def notes_approve(req: NoteDecision):
    """Re-run the rules on the saved reply against the stored page text (no LLM call); approve only if all pass."""
    p = req.proposal
    rep = next((r for r in [req.report] if r and r.id == p.get("report")), None)
    if p.get("kind") != "ar_note" or rep is None or not isinstance(p.get("reply"), dict) or ai.note_shape(p["reply"]):
        raise HTTPException(422, "That isn't an annual-report note proposal, or its report isn't attached.")
    req.report = rep
    sent = [n for n in p.get("pages") or [] if isinstance(n, int)]
    again = _ar_note(req, _topic(p.get("field")), p["reply"], sent, req.pages())
    failed = [c["detail"] for c in again["checks"] if c["pass"] is False]
    if failed:
        raise HTTPException(422, "The rules reject this note: " + " ".join(failed))
    return dict(again, id=p.get("id", again["id"]), status="approved")


@app.get("/api/sample")
def sample():
    from test_model import fake_screener  # ponytail: synthetic demo company, swap for a real export later
    buf = io.BytesIO()
    fake_screener(buf)
    buf.seek(0)
    return _company_payload(model.parse_screener(buf))


class DefaultsRequest(BaseModel):
    company: Company
    excluded_years: list[str] = []
    filings: list[Filing] = []
    notes: dict = {}

    def payload(self):
        try:
            return _company_payload(self.company.model_dump(), self.excluded_years,
                                    [f.model_dump() for f in self.filings], self.notes)
        except ValueError as e:
            raise HTTPException(422, str(e))


@app.post("/api/defaults")
def defaults(req: DefaultsRequest):
    """Defaults with the user's excluded (one-off) years left out, on the history the filings upgrade."""
    return req.payload()["defaults"]


@app.post("/api/company")
def refresh(req: DefaultsRequest):
    """Everything the dashboard derives from the company, again: after a filing is attached or removed."""
    return req.payload()


@app.post("/api/project")
def project(req: ModelRequest):
    co, sc, n, out = req.projection()
    return {"years": [model.fy(d, True) for d in model.projected_dates(co, n)], "scenarios": out,
            "valuation": req.dcf(co, sc, n, out)}


@app.post("/api/export")
def export(req: ModelRequest):
    co, sc, n, _ = req.projection()
    safe = re.sub(r"[^\w\- ]+", "", co["name"], flags=re.ASCII).strip() or "company"  # headers are latin-1
    return Response(model.to_excel(co, sc, n, req.active, req.valuation.model_dump()),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{safe} model.xlsx"'})


# ---------- local model library: models/<company-slug>/<YYYY-MM-DD>.json, one file per company per day ----------

def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60].strip("-")
    return s or "company-" + hashlib.sha1(name.encode()).hexdigest()[:8]  # non-Latin names


def model_file(model_id, root=MODELS):
    """The file for an id, only ever inside root. Anything else is rejected, never resolved."""
    if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id):
        raise HTTPException(422, "That isn't a valid model id.")
    p = (root / f"{model_id}.json").resolve()
    if not p.is_relative_to(root.resolve()):  # e.g. a symlinked folder pointing elsewhere
        raise HTTPException(422, "That isn't a valid model id.")
    return p


def save_model(doc: ModelDoc, root=MODELS, now=None):
    """Write today's version for this company (replacing any earlier one from today). Returns (id, saved_at)."""
    doc.args()  # all three scenarios, every driver, a sane horizon
    now = now or datetime.now()
    data = doc.model_dump(mode="json") | {"saved_at": now.isoformat(timespec="seconds")}
    try:
        text = json.dumps(data, allow_nan=False)
    except ValueError:
        raise HTTPException(422, "The model has numbers that aren't finite, so it can't be saved.")
    name, folder = doc.company.name, slug(doc.company.name)
    if any(_saved_name(f) not in (None, name) for f in (root / folder).glob("*.json")):
        folder += "-" + hashlib.sha1(name.encode()).hexdigest()[:6]  # another company slugs the same ("Tata Motors"/"TATA MOTORS!")
    model_id = f"{folder}/{now.date().isoformat()}"
    _write(model_file(model_id, root), text.encode())
    return model_id, data["saved_at"]


def _write(p, data: bytes):
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")  # own temp file per write, so saves can't collide
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)  # atomic: a crash mid-write never leaves half a file
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp)  # only still there if the write failed


def _saved_name(p):
    try:
        return json.loads(p.read_bytes())["company"]["name"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def load_model(model_id, root=MODELS):
    p = model_file(model_id, root)
    try:
        return ModelDoc.model_validate_json(p.read_bytes())
    except FileNotFoundError:
        raise HTTPException(404, "No saved model with that id. It may have been deleted.")
    except ValidationError:
        raise HTTPException(422, "That saved model is damaged or from an older version of the app.")


def list_models(root=MODELS):
    """Every saved version, most recent first. Unreadable files are skipped."""
    out = []
    for p in root.glob("*/*.json"):
        model_id = f"{p.parent.name}/{p.stem}"
        try:
            doc = load_model(model_id, root)
            co, sc, n = doc.args()
            last = model.project(co["hist"], model.expand(sc[doc.active], n), n)[-1]["revenue"]
        except Exception:  # noqa: BLE001
            continue  # ponytail: skip any unreadable file, never fail the whole list
        out.append({"id": model_id, "company": doc.company.name, "active": doc.active, "n": n,
                    "saved_at": doc.saved_at, "year": model.fy(model.projected_dates(co, n)[-1], True),
                    "revenue": last if last is not None and math.isfinite(last) else None})
    # ponytail: parses and projects every file per listing; fine for hundreds, add an index file past that
    return sorted(out, key=lambda m: m["saved_at"] or "", reverse=True)


RESTATED = (("revenue", "Revenue"), ("ebitda", "EBITDA"), ("pat", "Net profit"), ("total_assets", "Total assets"),
            ("borrowings", "Borrowings"))
RESTATE_TOL = 0.005  # 0.5%: Screener rounds lines to whole crores or 2 decimals, so less is noise


def restatements(co, root=MODELS):
    """Reported years in a freshly imported file that moved by more than 0.5% against the latest saved model of the
    same company: {id, saved_at, changes: [{year, line, old, new}]}, or None when nothing of it is saved."""
    saved = [p for p in root.glob(f"{slug(co['name'])}*/*.json") if _saved_name(p) == co["name"]]
    for p in sorted(saved, key=lambda p: p.stem, reverse=True):  # newest day first; a damaged file falls back
        model_id = f"{p.parent.name}/{p.stem}"
        try:
            doc = load_model(model_id, root)
        except HTTPException:
            continue
        old = {d.date(): h for d, h in zip(doc.company.dates, doc.company.hist)}
        changes = [{"year": y, "line": line, "old": o[k], "new": h[k]}
                   for y, d, h in zip(model.labels(co["dates"]), co["dates"], co["hist"]) if (o := old.get(d.date()))
                   for k, line in RESTATED
                   if o.get(k) is not None and abs(h[k] - o[k]) > max(RESTATE_TOL * abs(o[k]), 0.01)]
        return {"id": model_id, "saved_at": doc.saved_at, "changes": changes}
    return None


def delete_model(model_id, root=MODELS):
    p = model_file(model_id, root)
    try:
        p.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "No saved model with that id.")
    try:
        p.parent.rmdir()  # last version of that company
    except OSError:
        pass


@app.get("/api/models")
def models():
    return list_models()


@app.get("/api/models/{model_id:path}")
def open_model(model_id: str):
    """The saved document plus everything the dashboard derives from the company, defaults honouring exclusions."""
    doc = load_model(model_id)
    try:
        parsed = _company_payload(doc.company.model_dump(), doc.excluded_years, [f.model_dump() for f in doc.filings],
                                  doc.notes)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"id": model_id, "doc": doc.model_dump(mode="json"), "parsed": parsed}


@app.post("/api/models")
async def save(request: Request):
    body = bytearray()
    async for chunk in request.stream():  # read raw so the size cap applies before parsing
        body += chunk
        if len(body) > MAX_SAVE:
            raise HTTPException(413, "That model is too large to save.")
    try:
        doc = ModelDoc.model_validate_json(body)
    except ValidationError as e:
        raise RequestValidationError([{**x, "loc": ("body", *x["loc"])} for x in e.errors()])
    model_id, saved_at = save_model(doc)
    return {"id": model_id, "saved_at": saved_at}


@app.delete("/api/models/{model_id:path}")
def remove_model(model_id: str):
    delete_model(model_id)
    return {"ok": True}


dist = Path(__file__).parent / "web" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
