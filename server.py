"""Run: uv run uvicorn server:app  (serves the API and the built web/dist front end)."""
import contextlib
import hashlib
import io
import json
import math
import mimetypes
import statistics
import os
import re
import tempfile
import threading
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, ValidationError, model_validator

import ai
import model
import sources

try:  # optional local source of older years (not in this repo)
    from handoff import local_source
except Exception:  # noqa: BLE001  ponytail: optional; a broken one is skipped and never blocks the server starting
    local_source = None

MAX_UPLOAD = 5 * 1024 * 1024  # Excel exports are ~50 KB
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


@app.middleware("http")
async def _same_origin(request: Request, call_next):
    """Only this app's own pages may change the library: a page on another site can send a form or text/plain POST
    to localhost without a CORS preflight, and the browser would carry it out."""
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (
                origin and urlsplit(origin).netloc != request.headers.get("host")):
            return JSONResponse({"detail": "Requests from other sites aren't accepted."}, status_code=403)
    # ponytail: no Host allow-list, so DNS rebinding isn't blocked; add one if the app ever listens beyond localhost
    return await call_next(request)


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


# The import's old name in documents saved before it was named plainly; loading one shows today's words (no version
# bump). ponytail: split so the source never spells the name; only ever matched, never shown
OLD = "Scre" + "ener"
OLD_WORDS = ((f"{OLD}.in export", "Excel export"), (f"{OLD} export", "Excel export"), (f"{OLD} upload", "Excel upload"),
             (f"{OLD}'s", "the export's"), (f"{OLD}’s", "the export’s"), (OLD, "the export"))


def _unbrand(x):
    """Old wording in app-written words (source, checks, tie labels) -> today's; the old key (OLD lower-case) -> "export"."""
    if isinstance(x, str):
        if x == OLD:
            return model.EXPORT
        for a, b in OLD_WORDS:
            x = x.replace(a, b)
        return x
    if isinstance(x, list):
        return [_unbrand(v) for v in x]
    if isinstance(x, dict):
        return {("export" if k == OLD.lower() else k): _unbrand(v) for k, v in x.items()}
    return x


def _fix(x, *keys):
    """x with _unbrand applied to these keys, when x is a dict."""
    return {**x, **{k: _unbrand(x[k]) for k in keys if k in x}} if isinstance(x, dict) else x


REQUIRED = [*model.PL.values(), *model.BS.values(), "ebitda", "other_ca"]  # always numbers from parse_export


class Market(BaseModel):
    """Share price (Rs) and count (crore) from the export; null when the export left it out."""
    price: FiniteFloat | None = None
    shares: FiniteFloat | None = None
    price_hist: list[FiniteFloat | None] = []
    shares_hist: list[FiniteFloat | None] = []
    face_value: FiniteFloat | None = None  # Rs a share (META); saved before 4.4 = none, so no share-count check


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
    # fetched by ticker (5.1): {symbol, exchange, basis, fetched_at, price_at, industry, years {FY2024: "NSE filing" |
    # "Excel export"}, missing, mismatches, notes, documents}; words and dates only, no number reads it. None = an upload
    source: dict | None = None

    @model_validator(mode="before")
    @classmethod
    def _old_source(cls, d):
        return {**d, "source": _unbrand(d["source"])} if isinstance(d, dict) and d.get("source") else d

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
    the export adds payables, leases and cash-flow capex to its year (model.upgrade)."""
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
    model_config = ConfigDict(extra="allow")  # keep unknown keys from older saves instead of dropping them on save

    @model_validator(mode="before")
    @classmethod
    def _old_checks(cls, d):
        return _fix(d, "checks")


class Report(BaseModel):
    """An attached PDF: its page text is in models/_reports/<id>.json; `year` is the label it was attached for (FY2020).
    `kind` (4.2): an annual report (notes, flags, one-offs read only these), or a call transcript or investor
    presentation (read only to draft assumptions); saved before 4.2 = annual."""
    id: str = Field(pattern=r"^[0-9a-f]{12}$")
    file: str
    year: str
    pages: int
    kind: Literal["annual", "transcript", "presentation"] = "annual"
    model_config = ConfigDict(extra="allow")  # keep unknown keys from older saves instead of dropping them on save


class PeerRow(BaseModel):
    """One peer's comparison measures (model.peer_metrics), read from its NSE filings by rules when you compared; or
    why it couldn't be read (error)."""
    symbol: str = Field(pattern=r"^[A-Z0-9&-]{1,20}$")
    name: str = Field("", max_length=200)
    year: str | None = Field(None, max_length=20)  # its last reported year
    price: FiniteFloat | None = None
    at: str | None = Field(None, max_length=40)  # when its price was read
    source: str | None = Field(None, max_length=300)  # which years came from where, in words
    metrics: dict[str, FiniteFloat | None] | None = None
    error: str | None = Field(None, max_length=500)


class Peers(BaseModel):
    """5.2: the peer set. Rules list candidates, the AI's picks are a proposal (checked by rules), you tick and approve
    them (chosen, approved_at), and rules read each one's numbers (rows). Saved in the document; no version change
    (older documents simply have none)."""
    symbol: str | None = Field(None, pattern=r"^[A-Z0-9&-]{1,20}$")  # this company's NSE symbol, for the candidates
    candidates: list[dict] = Field([], max_length=40)  # words and sizes, as rules found them
    proposal: dict | None = None  # {picks [{symbol, name, reason, basis, checks, pass}], checks, basis, made_at, ai}
    chosen: list[str] = Field([], max_length=12)
    approved_at: str | None = None
    rows: list[PeerRow] = Field([], max_length=12)


NEW_DRIVERS = ("cogs_pct", "dpo")  # added in 3.4; scenarios saved before lack them


class ModelRequest(BaseModel):
    """The model document (version 6) minus what the engine ignores (excluded_years, saved_at)."""
    company: Company
    scenarios: dict[Scenario, dict[str, DriverPath]]
    active: Scenario = "base"
    n: int = 5
    valuation: Valuation = Valuation()
    filings: list[Filing] = []
    notes: dict = {}  # "oneoff:FY2020" (3.2b, words), "ar:<topic>:FY2021" (3.3); an approved capex note feeds capex
    # what the note's words are written from besides the numbers (inputs_hash); no number reads them
    excluded_years: list[str] = []
    # where each scenario's driver came from (4.2): {scenario: {driver: accepted proposal id | "history" | "manual"}};
    # a driver missing here is the rule default or an edit made before 4.2
    assumption_sources: dict[Scenario, dict[str, str]] = {}
    # AI explanations of forensic flags (4.3), one per flag key, rebuilt by the client from the approved flag_note
    # proposals: {key, year, proposal, summary, file, page, quote, from_numbers, ai}. Words only: no number reads them
    flag_notes: list[dict] = []
    peers: Peers | None = None  # 5.2; the table is rebuilt from rows at today's inputs on every projection and export
    # 5.3, optional (no version bump): the base forecast as it stood each time new annual results came in
    # (model.forecast_record + track_record), oldest first, scored against the actuals on every projection.
    # ponytail: untyped dicts, only ever written by track_record; every reader takes them with .get
    track: list[dict] = Field([], max_length=model.MAX_TRACK)

    @model_validator(mode="before")
    @classmethod
    def _old_words(cls, d):
        """Old wording in the proposals' checks and in tie labels (_unbrand); quotes and AI-written words stay."""
        if not isinstance(d, dict):
            return d
        d = dict(d)
        if isinstance(d.get("notes"), dict):
            d["notes"] = {k: _fix(v, "against") for k, v in d["notes"].items()}
        if isinstance(d.get("proposals"), list):
            d["proposals"] = [_fix(q, "checks") | ({"value": _fix(q["value"], "against")} if "value" in q else {})
                              if isinstance(q, dict) else q for q in d["proposals"]]
        return d

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
        return upgraded(self.company.model_dump(), [f.model_dump() for f in self.filings], self.notes)

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

    def peer_table(self, co):
        """The company against its saved peers (model.peer_table) at this model's price and share count; None
        without peers. Rules only: the peers' rows were read when you compared, nothing is fetched here."""
        if not (self.peers and self.peers.rows):
            return None
        m, v = co.get("market") or {}, self.valuation
        own = {"name": co["name"], "symbol": self.peers.symbol or (co.get("source") or {}).get("symbol"),
               "year": model.labels(co["dates"])[-1],
               "metrics": model.peer_metrics(co["hist"], v.price or m.get("price"), v.shares or m.get("shares"))}
        return model.peer_table(own, [r.model_dump() for r in self.peers.rows])

    def dcf(self, co, sc, n, out):
        ex = {s: model.expand(sc[s], n) for s in model.SCENARIOS}
        v = model.valuation(out, co["hist"], self.valuation.model_dump(), ex["base"], co["market"], inputs=ex, note=True)
        try:  # extreme but finite inputs (shares 1e-320, rates 1e308) can overflow; JSON can't carry inf/NaN
            json.dumps(v, allow_nan=False)
        except ValueError:
            raise HTTPException(422, "Those valuation inputs make the numbers too large to value. Try smaller values.")
        return v


class ModelDoc(ModelRequest):
    """The full model document as saved in the library. Version 3 (before valuation) loads with default inputs;
    versions 3 and 4 load with empty Phase 3 blocks; 3 to 5 with empty Phase 4 blocks."""
    version: Literal[3, 4, 5, 6]
    saved_at: str | None = None
    # ponytail: proposals are untyped dicts {id, kind (mapping | oneoff_note | ar_note | flag_note | assumption), field, value, unit, period,
    # source {file, page, quote, tag}, reasoning, checks [{name, pass, detail}], status (proposed | approved |
    # rejected), ai}; mapping adds "filing", oneoff_note "report"/"from_numbers", ar_note "report"/"pages"/"reply",
    # assumption (4.2) "report"/"pages"/"reply"/"from_history"/"outside" with value {base, bull, bear: {start, end}}.
    # The server re-checks every one it acts on; a pydantic Proposal model if anything but our own client writes them
    proposals: list[dict] = []
    # notes (in ModelRequest): "oneoff:FY2020": {proposal, summary, file, page, quote, from_numbers, ai} (3.2b);
    # "ar:segments:FY2021": {proposal, topic, year, file, rows, total, against, ai} (3.3)
    reports: list[Report] = []  # attached annual reports (3.2b); added within version 5, so it defaults to none
    # Phase 4 (version 6; assumption_sources and flag_notes are in ModelRequest, for the note's inputs hash).
    # ponytail: `note` is an untyped dict (ThesisNote on the client); a pydantic model if anything but our client writes it
    note: dict | None = None  # the thesis and verdict text (4.4): AI-written words with citations
    reviewed_at: str | None = None  # "Mark as reviewed" in the review bar; cleared when you change the model

    @model_validator(mode="after")
    def _migrate(self):
        self.version = 6  # v3 -> v4 added "valuation", v4 -> v5 the Phase 3 blocks, v5 -> v6 the Phase 4 ones
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


MOVED_REV = re.compile(r"\s*(?:revenue|turnover|sales|income from operations)", re.I)  # the label starts with it
MOVED_EBITDA = re.compile(r"\s*(?:ebitda|operating profit|profit before (?:depreciation|interest))", re.I)


def moved_out(notes, co):
    """The business that left the group, for model.upgrade: {revenue, ebitda (None = at the year's margin), reason,
    from} in Rs crore, or None. Yours ("adj:moved_out", typed with a reason) wins over an approved annual-report note
    ("ar:moved_out:<year>", AI-read, rule-checked); either only for the last reported year, the forecast's base."""
    notes, last = notes or {}, model.labels(co["dates"])[-1]
    m = notes.get("adj:moved_out")
    if isinstance(m, dict) and m.get("year") == last and str(m.get("reason") or "").strip():
        return {"revenue": m.get("revenue"), "ebitda": m.get("ebitda"), "reason": str(m["reason"]).strip()[:200], "from": "you"}
    n = notes.get(f"ar:moved_out:{last}")
    rows = n.get("rows") if isinstance(n, dict) else None
    if not rows:
        return None
    rev, ebitda = _moved_rows(rows)
    return {"revenue": rev.get("amount"), "ebitda": ebitda and ebitda.get("amount"),
            "reason": f"{n.get('file') or 'the annual report'} p.{rev.get('page')}, approved", "from": "annual report"}


def _moved_rows(rows):
    """(revenue row, EBITDA row or None) of a business-moved-out note, by their labels; the first row is the revenue
    when no label says so."""
    pick = lambda pat: next((r for r in rows if isinstance(r, dict) and pat.match(str(r.get("label") or ""))), None)  # noqa: E731
    return pick(MOVED_REV) or (rows[0] if rows else None), pick(MOVED_EBITDA)


def upgraded(co, filings=(), notes=None):
    """model.upgrade with what approved notes add: annual-report capex, and a business moved out of the base year."""
    return model.upgrade(co, filings, ar_capex(notes), moved_out(notes, co))


def _company_payload(co, excluded=(), filings=(), notes=None):
    """What the dashboard derives from the company. Ratios, defaults and one-offs use the upgraded history (with the
    filings' payables, leases and cash-flow capex); "company" stays as parsed, for the document."""
    labels, q, up = model.labels(co["dates"]), co.get("quarters"), upgraded(co, filings, notes)
    return {
        "company": {"name": co["name"], "dates": [d.isoformat() for d in co["dates"]], "hist": co["hist"],
                    "market": co.get("market") or Market().model_dump(),
                    "quarters": q and {"dates": [d.isoformat() for d in q["dates"]], "rows": q["rows"]},
                    "source": co.get("source")},
        "ttm": model.ttm(q), "ttm_prev": model.ttm(q, 4),  # last four quarters, and the four before them
        "years": labels,
        "hist": up["hist"], "sources": up["sources"],
        "ratios": model.ratios(up["hist"]),
        "defaults": (d := model.default_assumptions(up["hist"], exclude=set(excluded), labels=labels)),
        "default_ends": model.default_ends(up["hist"], d),  # a fast grower's defaults fade (end values), else {}
        "checks": model.data_checks(co),
        "oneoffs": (oneoffs := model.detect_oneoffs(up["hist"], labels)),
        # the note (4.1): rule checks, key numbers against their 3-year median, rolling revenue CAGRs; the forensic
        # radar (4.3) behind most of the rule checks
        "forensic": (radar := model.forensic(up["hist"], labels, notes)),
        "rule_checks": model.rule_checks(up["hist"], labels, oneoffs, model.data_checks(co), notes, radar),
        "key_numbers": model.key_numbers(up["hist"], labels),
        "cagrs": {"3": model.cagrs(up["hist"], labels, 3), "5": model.cagrs(up["hist"], labels, 5)},
        "valuation": model.VALUATION,  # defaults for a new document
        "drivers": model.DRIVERS,
        "layout": model.LAYOUT,
    }


@app.post("/api/parse")
async def parse(file: UploadFile):
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "That file is over 5 MB. An Excel export is usually under 100 KB.")
    try:
        co = model.parse_export(io.BytesIO(data))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception:  # corrupt / not an xlsx
        raise HTTPException(422, "Couldn't read that file as an Excel workbook. Upload a 10-year "
                                 "financials .xlsx with a 'Data Sheet' tab.")
    restated = restatements(co, MODELS)  # MODELS at call time (tests point it elsewhere)
    carry = restated and restated["carry"]
    if carry:  # the saved model's filings are read again by rules against this file: no AI call
        carry["filings"], _ = reread([Filing.model_validate(f) for f in carry["filings"]], load_mappings(MODELS), co)
    carry = carry or {}
    return _company_payload(co, (), carry.get("filings", ()), carry.get("notes")) | {"restated": restated}


def load_mappings(root=None, strict=False):
    """The user's approved tag mappings ({tag: std key}); none when the file is missing. A damaged file reads as none
    for parsing, but `strict` (before writing it) refuses it rather than replace the user's mappings."""
    root = root or MODELS  # read at call time, so a test that sets server.MODELS covers the routes too
    try:
        m = json.loads((root / MAPPINGS).read_bytes())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        m = None
    if not isinstance(m, dict):
        if strict:
            raise HTTPException(409, f"{MAPPINGS} in the models folder is damaged; fix or delete it, then try again.")
        return {}
    return {k: v for k, v in m.items() if isinstance(k, str) and isinstance(v, str)}


def reread(filings, m, co):
    """Each filing read again by rules from its kept raw file, with mappings `m` and ties against `co` -> (filings as
    dicts, files that weren't kept: attached before raw files were, so they need attaching again)."""
    out, missing = [], []
    for f in filings:
        raw = MODELS / FILINGS / f"{f.id}.xml"
        if not FILING_ID.fullmatch(f.id) or not raw.is_file():
            missing.append(f.file)
            out.append(f.model_dump())
            continue
        out.append({**f.model_dump(), **model.parse_xbrl(raw.read_bytes(), mappings=m, company=co)})
    return out, missing


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
    asked = model.unmapped_rows(f)[:MAX_ASK]  # ponytail: one round of the first 80; propose again after approving some
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
    m = load_mappings(MODELS, strict=True)
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
    out, missing = reread(req.filings, m, req.company and req.company.model_dump())
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
async def report(file: UploadFile, year: str = Form(...), kind: str = Form("annual")):
    """Read a PDF (annual report, call transcript or investor presentation) into page text by rules (pdftotext) and
    keep the text. The client adds {id, file, year, pages, kind} to its document's `reports`."""
    if kind not in ai.KINDS:
        raise HTTPException(422, f"Unknown document kind {kind!r}; one of {', '.join(ai.KINDS)}.")
    data = await file.read(MAX_PDF + 1)
    if len(data) > MAX_PDF:
        raise HTTPException(413, "That file is over 60 MB. Annual reports are usually 5-30 MB.")
    try:  # pdftotext takes seconds: keep serving other requests
        return await run_in_threadpool(keep_report, data, file.filename or "report.pdf", year, kind)
    except ValueError as e:
        raise HTTPException(503 if str(e) == ai.PDF_MISSING else 422, str(e))


def keep_report(data, name, year, kind):
    """A PDF's page text kept in the library (rules: pdftotext) -> the document's Report entry. ValueError if unreadable."""
    pages = ai.pdf_pages(data)
    rid = hashlib.sha1(data).hexdigest()[:12]
    _write(MODELS / REPORTS / f"{rid}.json", json.dumps({"file": name, "pages": pages}).encode())
    return {"id": rid, "file": name[:200], "year": year[:20], "pages": len(pages), "kind": kind}


class ExplainRequest(BaseModel):
    company: Company
    filings: list[Filing] = []
    notes: dict = {}  # approved capex notes change the history the flags come from, as on the dashboard
    year: str
    report: Report | None = None  # None: explain from the numbers only


def report_pages(r, annual=False):
    """An attached report's page text [(reading order, layout)] as kept by /api/report; `annual`: only an annual report
    will do (the notes, one-off and flag readers check the year and quote its notes)."""
    if annual and r.kind != "annual":
        raise HTTPException(422, f"{r.file} is a {ai.KINDS[r.kind]}; attach the annual report for this.")
    raw = MODELS / REPORTS / f"{r.id}.json"
    if not raw.is_file():
        raise HTTPException(422, f"The text of {r.file} isn't on this machine any more; attach it again.")
    return [tuple(p) for p in json.loads(raw.read_bytes())["pages"]]


NOTE_LINES = (("revenue", "Revenue"), ("ebitda", "EBITDA"), ("other_income", "Other income"), ("pbt", "PBT"),
              ("tax", "Tax"), ("pat", "Net profit"), ("capex", "Capex"), ("net_block", "Net block"),
              ("borrowings", "Borrowings"))


def _numbers(rows, lines):
    """The reported figures an explanation may use, one line per item, Indian grouping as the rest of the app."""
    return "\n".join(f"{name}: " + ", ".join(f"{y} {model._inr(h[k])}" if h.get(k) is not None else f"{y} n/a" for y, h in rows)
                     for k, name in lines)


@app.post("/api/oneoffs/explain")
def explain(req: ExplainRequest):
    """A words-only proposal (kind oneoff_note) for a year detect_oneoffs flags. With a report, rules pick the pages
    and check that the quote is on the cited page (a quote that isn't comes back rejected); without, it is marked
    as read from the numbers only. Approving it only pins the words: no number uses it."""
    if not ai.available():
        raise HTTPException(503, ai.NOT_SET)
    co = req.company.model_dump()
    labels, up = model.labels(co["dates"]), upgraded(co, [f.model_dump() for f in req.filings], req.notes)
    flags = [o for o in model.detect_oneoffs(up["hist"], labels) if o["year"] == req.year]
    if not flags:
        raise HTTPException(422, f"{req.year} isn't flagged as an unusual year.")
    i = labels.index(req.year)
    end = co["dates"][i].date()
    numbers = _numbers([(labels[j], up["hist"][j]) for j in range(max(0, i - 2), min(len(labels), i + 2))], NOTE_LINES)
    r = req.report
    try:
        if r is None:
            reply = ai.explain_oneoff(req.year, flags, numbers)
            checks = [{"name": "Source", "pass": None, "detail": "From the numbers only, no filing read."}]
            source = {"file": None, "page": None, "quote": None, "tag": None}
        else:
            pages = report_pages(r, annual=True)
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
    checks.append(ai.wording_check(summary))
    ok = all(c["pass"] is not False for c in checks)
    # the citation is part of the id: the same summary with another quote is another record (a rejected one stays)
    key = f"oneoff:{req.year}:{r and r.id}:{summary}:{source['page']}:{source['quote']}"
    return {"id": hashlib.sha1(key.encode()).hexdigest()[:12],
            "kind": "oneoff_note", "field": "oneoff", "value": summary, "unit": None, "period": req.year,
            "source": source, "report": r and r.id, "from_numbers": r is None,
            "reasoning": "; ".join(f["note"] for f in flags), "checks": checks,
            "status": "proposed" if ok else "rejected", "ai": True}


# ---------- forensic flags explained in words (4.3): rules found the flag, the LLM says why, rules check the words ----------

class FlagRequest(BaseModel):
    company: Company
    filings: list[Filing] = []
    notes: dict = {}
    key: str
    report: Report | None = None  # None: from the numbers only

FLAG_LINES = NOTE_LINES + (("cfo", "Cash from operations"), ("receivables", "Receivables"), ("inventory", "Inventory"),
                           ("cwip", "Capital WIP"), ("cash", "Cash"), ("investments", "Investments"))


@app.post("/api/flags/explain")
def explain_flag(req: FlagRequest):
    """A words-only proposal (kind flag_note) for a lit forensic flag. Rules re-run the radar (a flag that isn't lit is a
    422), pick the report's pages and check the quote is on the cited page and that every number in the words is one
    the app computed or one in the quote; a failure comes back rejected. Approving pins the words; no number reads them."""
    if not ai.available():
        raise HTTPException(503, ai.NOT_SET)
    co = req.company.model_dump()
    labels, up = model.labels(co["dates"]), upgraded(co, [f.model_dump() for f in req.filings], req.notes)
    flag = next((f for f in model.forensic(up["hist"], labels, req.notes) if f["key"] == req.key), None)
    if flag is None or flag["severity"] not in SEVERITY_WORD:
        raise HTTPException(422, f"{flag['title'] if flag else req.key} isn't flagged.")
    numbers = _numbers(list(zip(labels, up["hist"]))[-5:], FLAG_LINES)
    given = f"{flag['title']} {flag['fact']} {flag['detail']} {flag['rule']}\n{numbers}"
    r = req.report
    try:
        if r is None:
            reply = ai.explain_flag(flag, numbers)
            checks = [{"name": "Source", "pass": None, "detail": "From the numbers only, no filing read."}]
            source = {"file": None, "page": None, "quote": None, "tag": None}
        else:
            if r.year not in labels:
                raise HTTPException(422, f"{r.year} isn't one of the reported years in this model.")
            end, pages = co["dates"][labels.index(r.year)].date(), report_pages(r, annual=True)
            sent = ai.pick_flag_pages(pages, req.key, end)
            if not sent:
                raise HTTPException(422, f"No page of {r.file} mentions {flag['title'].lower()}. Explain from the numbers only instead.")
            reply = ai.explain_flag(flag, numbers, [(n, ai.page_text(pages[n - 1])) for n in sent])  # tables: rows kept whole
            checks = ai.quote_checks(reply, pages, sent, end)
            source = {"file": r.file, "page": reply["page"], "quote": reply["quote"].strip()[:900], "tag": None}
    except ai.LLMError as e:
        raise HTTPException(502, str(e))
    summary = reply["summary"].strip()
    checks += [ai.numbers_check(summary, given, source["quote"]), ai.wording_check(summary)]
    ok = all(c["pass"] is not False for c in checks)
    key = f"flag:{req.key}:{r and r.id}:{summary}:{source['page']}:{source['quote']}"
    return {"id": hashlib.sha1(key.encode()).hexdigest()[:12],
            "kind": "flag_note", "field": req.key, "value": summary, "unit": None, "period": labels[-1],
            "source": source, "report": r and r.id, "from_numbers": r is None,
            "reasoning": flag["detail"], "checks": checks, "status": "proposed" if ok else "rejected", "ai": True}


# ---------- drafting assumptions (4.2): rules pick the pages, the LLM proposes every driver, rules check each ----------

SHIFT = {"growth": 0.03, "ebitda_margin": 0.015}  # bull / bear around base, as seed() in web/src/lib.ts does
DRAFT_YEARS = 10  # "inside its history" = the range over the last 10 reported years


class DraftRequest(BaseModel):
    company: Company
    excluded_years: list[str] = []
    filings: list[Filing] = []
    notes: dict = {}
    reports: list[Report] = []
    n: int = Field(5, ge=1, le=15)
    scenarios: dict[Scenario, dict[str, DriverPath]] = {}  # check: the scenarios the accepted values go into
    proposals: list[dict] = []  # check: the proposals to accept, re-checked by rules


def _draft_ctx(req):
    """What the rules know before reading anything: the upgraded history, its ratios and ranges, the rule defaults,
    the drivers worth asking about (COGS % only on a COGS basis, payable days only once payables exist)."""
    co = req.company.model_dump()
    labels, up = model.labels(co["dates"]), upgraded(co, [f.model_dump() for f in req.filings], req.notes)
    hist, r = up["hist"], model.ratios(up["hist"])
    try:
        d = model.default_assumptions(hist, exclude=set(req.excluded_years), labels=labels)
    except ValueError as e:
        raise HTTPException(422, str(e))
    kinds = {k: kind for k, _, kind in model.DRIVERS}
    asked = [k for k, _, _ in model.DRIVERS if not (k == "cogs_pct" and not model.on_cogs(hist))
             and not (k == "dpo" and not up["sources"]["used"]["payables"])]
    ranges = {}
    for k in kinds:
        xs = [x[k] for x in r[-DRAFT_YEARS:] if x[k] is not None and math.isfinite(x[k])]
        ranges[k] = (min(xs), max(xs)) if xs else None
    unit = lambda k, v: v * 100 if kinds[k] == "pct" else v  # noqa: E731  the reply's units: percent for pct drivers
    rows = [{"key": k, "label": lb, "kind": kinds[k], "default": unit(k, d[k]),
             "hist": [(y, unit(k, x[k])) for y, x in list(zip(labels, r))[-6:] if x[k] is not None]}
            for k, lb, _ in model.DRIVERS if k in asked]
    dates = model.projected_dates(co, req.n)
    last = hist[-1]
    return {"hist": hist, "defaults": d, "ends": model.default_ends(hist, d), "kinds": kinds, "asked": asked, "ranges": ranges, "rows": rows,
            "years": (model.fy(dates[0], True), model.fy(dates[-1], True)), "n": req.n,
            "size": max(last["revenue"], model._debt(last)), "revenue": last["revenue"],
            "given": "\n".join(f"{x['key']} " + " ".join(f"{v:.1f}" for _, v in x["hist"]) + f" {x['default']:.1f}" for x in rows)}


def _history(k, ctx, pid=None):
    """A driver from history: the rule default (default_assumptions) for base, bull and bear seeded around it."""
    v, s, e = ctx["defaults"][k], SHIFT.get(k, 0.0), ctx["ends"].get(k)
    value = {c: {"start": v + d, "end": None if e is None else e + d} for c, d in (("base", 0.0), ("bull", s), ("bear", -s))}
    return {"id": pid or hashlib.sha1(f"assume:{k}:history:{v!r}".encode()).hexdigest()[:12], "kind": "assumption",
            "field": k, "value": value, "unit": ctx["kinds"][k], "period": "–".join(ctx["years"]),
            "source": {"file": None, "page": None, "quote": None, "tag": None}, "report": None, "from_history": True,
            "reasoning": "The documents say nothing about it, so the rule default from the reported years stays.",
            "checks": [{"name": "From history", "pass": None, "detail": "The rule default from the reported years; no AI number."}],
            "status": "proposed", "ai": False}


def _parse(x, kind):
    """The reply's base / bull / bear {start, end} in the engine's units, and the ones that don't parse."""
    value, bad = {}, []
    for s in ("base", "bull", "bear"):
        raw = x.get(s) if isinstance(x.get(s), dict) else {}
        out = {}
        for e in ("start", "end"):
            v = None if raw.get(e) is None else ai.amount(raw[e])
            if v is None and (e == "start" or raw.get(e) is not None):
                bad.append(f"{s} {e}")
            out[e] = None if v is None else v / 100 if kind == "pct" else v
        value[s] = out
    return value, bad


def _drafted(x, r, sent, pages, value, bad, ctx, proj):
    """One AI-drafted driver as a proposal, checked by rules (ai.assumption_checks); a failed check = rejected."""
    k, kind = x["key"], ctx["kinds"][x["key"]]
    reasoning, outside = str(x.get("reasoning") or "").strip()[:700], str(x.get("outside_history") or "").strip()[:400] or None
    given = ctx["given"] + " " + json.dumps({s: x.get(s) for s in ("base", "bull", "bear")})
    checks = ai.assumption_checks(k, kind, value, bad, {"page": x["page"], "quote": x["quote"], "pages": pages, "sent": sent,
                                                         "file": r.file}, outside, reasoning,
                                  dict(ctx, range=ctx["ranges"][k], given=given, project=proj))
    ok = all(c["pass"] is not False for c in checks)
    return {"id": hashlib.sha1(f"assume:{k}:{r.id}:{json.dumps(x, sort_keys=True)}".encode()).hexdigest()[:12],
            "kind": "assumption", "field": k, "value": value, "unit": kind, "period": "–".join(ctx["years"]),
            "source": {"file": r.file, "page": x["page"], "quote": x["quote"].strip()[:600], "tag": None},
            "report": r.id, "pages": sent, "reply": x, "from_history": False, "reasoning": reasoning, "outside": outside,
            "checks": checks, "status": "proposed" if ok else "rejected", "ai": True}


def _consistency(ctx, base):
    """The base set projected by the engine (first projected year label, rows), for the capex and payout checks."""
    a = {k: base.get(k, {"start": v, "end": None}) for k, v in ctx["defaults"].items()}
    try:
        return ctx["years"][0], model.project(ctx["hist"], model.expand(a, ctx["n"]), ctx["n"])
    except (ArithmeticError, ValueError):
        return None


def _checked(items, ctx, base):
    """[(reply item, report, sent pages, page texts)] -> proposals; the base set takes every value that parsed."""
    parsed = [(x, r, sent, pages, *_parse(x, ctx["kinds"][x["key"]])) for x, r, sent, pages in items]
    for x, _, _, _, value, bad in parsed:
        if not bad:
            base = dict(base, **{x["key"]: value["base"]})
    proj = _consistency(ctx, base)
    return [_drafted(x, r, sent, pages, value, bad, ctx, proj) for x, r, sent, pages, value, bad in parsed]


@app.post("/api/assumptions/draft")
def draft(req: DraftRequest):
    """Every driver for base, bull and bear: from the attached documents where the LLM finds them, each with a page and
    quote and checked by rules, else the rule default ("from history"). Without LLM_CMD or documents, all from
    history with a message. The client shows them against the current values; nothing changes until accepted."""
    ctx = _draft_ctx(req)
    keys = [k for k, _, _ in model.DRIVERS]
    hist = lambda why: {"proposals": [_history(k, ctx) for k in keys], "message": why, "pages": []}  # noqa: E731
    if not req.reports:
        return hist("No documents attached, so every driver comes from history (the rule defaults). Attach an annual "
                    "report, an earnings-call transcript or an investor presentation to draft from management's words.")
    if not ai.available():
        return hist("LLM_CMD isn't set, so every driver comes from history (the rule defaults). " + ai.NOT_SET)
    docs = {f"D{i + 1}": (r, report_pages(r)) for i, r in enumerate(req.reports)}
    picks = ai.pick_assume_pages([(lb, pages) for lb, (_, pages) in docs.items()])
    if not picks:
        return hist("No page of the attached documents talks about the years ahead (guidance, outlook, capacity, "
                    "margins, demand), so every driver comes from history.")
    sent = {lb: [n for b, n in picks if b == lb] for lb in docs}
    pages = [(lb, f"{docs[lb][0].year} {ai.KINDS[docs[lb][0].kind]}, {docs[lb][0].file}", n, docs[lb][1][n - 1][0])
             for lb, n in picks]
    try:
        reply = ai.draft_assumptions(req.company.name, ctx["years"], ctx["rows"], pages)
    except ai.LLMError as e:
        raise HTTPException(502, str(e))
    first = {}
    for x in reply["drivers"]:
        first.setdefault(x["key"], x)
    items = [(x, docs[x["doc"]][0], sent[x["doc"]], docs[x["doc"]][1]) if x["doc"] in docs
             else (x, Report(id="0" * 12, file=f"unknown document {x['doc'][:20]}", year="", pages=0), [], [])
             for x in first.values() if x["from"] == "documents" and x["key"] in ctx["asked"]]
    drafted = {p["field"]: p for p in _checked(items, ctx, {})}
    n_doc = len(drafted)
    return {"proposals": [drafted.get(k) or _history(k, ctx) for k in keys],
            "message": f"Read {len(picks)} pages from {len(docs)} document{'s' * (len(docs) > 1)}: {n_doc} driver"
                       f"{'s' * (n_doc != 1)} from the documents, {len(keys) - n_doc} from history.",
            "pages": [{"file": docs[lb][0].file, "kind": docs[lb][0].kind, "page": n} for lb, n in picks]}


@app.post("/api/assumptions/check")
def assumptions_check(req: DraftRequest):
    """Before accepting: the rules again on each proposal, from its saved reply and the stored page text (no LLM call),
    with the consistency checks run on the base case the accepted values would make. History ones come back with
    today's rule default."""
    ctx = _draft_ctx(req)
    base = {k: v.model_dump() for k, v in req.scenarios.get("base", {}).items()}
    items, ids, out = [], [], {}
    for p in req.proposals:
        k = p.get("field")
        if p.get("kind") != "assumption" or k not in ctx["kinds"]:
            raise HTTPException(422, "That isn't an assumption proposal.")
        if p.get("from_history"):
            out[p.get("id")] = _history(k, ctx, p.get("id"))
            continue
        r = next((r for r in req.reports if r.id == p.get("report")), None)
        x = p.get("reply")
        if r is None or not isinstance(x, dict) or ai._assume_shape([k])({"drivers": [x]}):
            raise HTTPException(422, f"The document {k} was drafted from isn't attached any more, or the proposal is damaged.")
        items.append((x, r, [n for n in p.get("pages") or [] if isinstance(n, int)], report_pages(r)))
        ids.append(p.get("id"))
    for pid, q in zip(ids, _checked(items, ctx, base)):
        out[pid] = dict(q, id=pid)
    return {"proposals": [out[p.get("id")] for p in req.proposals]}


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
        return report_pages(self.report, annual=True)


def _against(req, topic, i):
    """What a topic's sum must tie to, [(label, Rs crore)], from the export and the filings (rules)."""
    y = req.report.year
    h, up = req.company.hist[i], model.upgrade(req.company.model_dump(), [f.model_dump() for f in req.filings])
    u = up["hist"][i]
    if topic == "segments":
        return [(f"the export's {y} revenue", h["revenue"])]
    if topic == "maturity":
        return [(f"the export's {y} borrowings (incl. leases)", h["borrowings"])] + (
            [(f"{y} borrowings without leases (XBRL)", u["borrowings"])] if u.get("lease") else [])
    if topic == "capex":
        return [(f"the XBRL cash-flow capex for {y}", u["capex_cf"])] if y in up["sources"]["used"]["capex"] else []
    return None


def _ar_note(req, topic, reply, sent, pages):
    """The ar_note proposal for one topic's reply: values converted to Rs crore and checked by rules (ai.note_checks).
    A failed check comes back rejected (kept for audit)."""
    i, end = req.year()
    h, r = req.company.hist[i], req.report
    ag = _against(req, topic, i)
    rows, total, checks = ai.note_checks(topic, reply, pages, sent, end, ag)
    if topic == "moved_out":
        checks += _moved_checks(rows, h, r.year, model.labels(req.company.dates)[-1])
    ref = {"contingent": ("Net worth", h["share_cap"] + h["reserves"]), "related": ("Revenue", h["revenue"]),
           "moved_out": ("Revenue", h["revenue"])}.get(topic)
    against = (ag or [None])[0] or ref
    first = rows[0]
    ok = all(c["pass"] is not False for c in checks)
    value = {"rows": rows, "total": total, "against": against and {"label": against[0], "value": against[1]}}
    if topic == "auditor":  # words, checked against the quotes: the firm, the opinion, whether it changed
        value.update(auditor=reply["auditor"].strip()[:120], opinion=reply["opinion"], changed=reply["changed"])
    return {"id": hashlib.sha1(f"ar:{topic}:{r.id}:{json.dumps(reply, sort_keys=True)}".encode()).hexdigest()[:12],
            "kind": "ar_note", "field": topic, "value": value,
            "unit": {"pledge": "% of promoter shares", "auditor": None, "kpis": None}.get(topic, "Rs crore"), "period": r.year,
            "source": {"file": r.file, "page": first["page"], "quote": first["quote"], "tag": None},
            "report": r.id, "pages": sent, "reply": reply,
            "reasoning": f"{ai.TOPICS[topic][0]} read from PDF page{'s' if len(sent) > 1 else ''} "
                         f"{', '.join(map(str, sent))}" + (f"; printed in {reply['unit']}." if reply.get("unit") else "."),
            "checks": checks, "status": "proposed" if ok else "rejected", "ai": True}


def _moved_checks(rows, h, year, last):
    """Rules on a business moved out (beyond the quotes): model.move_out's (revenue above zero and below the year's,
    EBITDA no larger than that revenue), and whether the note is for the forecast's base year (only then is it used)."""
    rev, ebitda = _moved_rows(rows)
    m = model.move_out(h, {"revenue": rev and rev.get("amount"), "ebitda": ebitda and ebitda.get("amount")})
    return [{"name": "Fits the year", "pass": not isinstance(m, str),
             "detail": m if isinstance(m, str) else f"Revenue moved out Rs {model._inr(m['revenue_out'])} cr of the year's "
             f"Rs {model._inr(h['revenue'])} cr; EBITDA Rs {model._inr(m['ebitda_out'])} cr"
             + ("." if ebitda else " (not printed: taken at the year's own margin).")},
            {"name": "Base year", "pass": True if year == last else None,
             "detail": f"{year} is the last reported year, so approving it takes the business out of the forecast's base."
             if year == last else f"Only a note for {last}, the forecast's base, changes the forecast; this one is kept "
             "for the record."}]


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
        chars = len(ai.note_prompt(t, req.report.year, end, [(n, ai.page_text(pages[n - 1], t)) for n in sent])) if sent else 0
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
        reply = ai.extract_note(topic, req.report.year, end, [(n, ai.page_text(pages[n - 1], topic)) for n in sent])
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
    rep = req.report if req.report and req.report.id == p.get("report") else None
    if (p.get("kind") != "ar_note" or rep is None or not isinstance(p.get("reply"), dict) or p.get("field") not in ai.TOPICS
            or ai.note_shape(p["reply"], p["field"])):
        raise HTTPException(422, "That isn't an annual-report note proposal, or its report isn't attached.")
    req.report = rep
    sent = [n for n in p.get("pages") or [] if isinstance(n, int)]
    again = _ar_note(req, _topic(p.get("field")), p["reply"], sent, req.pages())
    failed = [c["detail"] for c in again["checks"] if c["pass"] is False]
    if failed:
        raise HTTPException(422, "The rules reject this note: " + " ".join(failed))
    return dict(again, id=p.get("id", again["id"]), status="approved")


# ---------- the research note's words (4.4): AI writes from the app's numbers, rules check every number ----------

def inputs_hash(req: ModelRequest):
    """What the note is written from: the company, every scenario's inputs, the horizon, the valuation inputs, what the
    filings add, and the words and sources behind its facts and citations (approved notes, flag notes, input sources,
    excluded years). A saved note with another hash was written for earlier inputs."""
    key = {"company": req.company.model_dump(mode="json"), "n": req.n, "valuation": req.valuation.model_dump(),
           "scenarios": {s: {k: v.model_dump() for k, v in a.items()} for s, a in req.scenarios.items()},
           "filings": [[f.id, f.facts] for f in req.filings], "notes": req.notes, "flag_notes": req.flag_notes,
           "sources": req.assumption_sources, "excluded": sorted(req.excluded_years)}
    return hashlib.sha1(json.dumps(key, sort_keys=True, default=str).encode()).hexdigest()[:12]


def _rs(x):
    """Rs a share as the note shows it: whole rupees from 100 up (Indian grouping), paise below."""
    return f"Rs {model._inr(x)}" if abs(x) >= 100 else f"Rs {model._inr(x, 2)}"


_pc = "{:.1%}".format
SEVERITY_WORD = {"high": "Red", "medium": "Amber", "low": "Amber (low)"}
IN_FACTS = ("growth", "ebitda_margin", "tax_rate", "capex_pct", "oi_pct")  # always stated, with where each came from
MAX_CITES = 24  # ponytail: quotes only, never whole pages; the approved quotes already say what the pages hold


def _thesis_facts(doc: "ModelDoc"):
    """({key: text}, {id: citation}) the note may use: the verdict numbers, what moves value, break-evens, key numbers,
    the margin's own range, rule checks (lit ones, and leverage even when it passed), inputs with their sources, and the
    quotes behind approved inputs and notes. Rules only."""
    co, sc, n, out = doc.projection()
    v, hist, labels = doc.dcf(co, sc, n, out), co["hist"], model.labels(co["dates"])
    years, last = [model.fy(d, True) for d in model.projected_dates(co, n)], labels[-1]
    ex, sv = model.expand(sc["base"], n), v["scenarios"]
    avg = lambda k: sum(ex[k]) / n  # noqa: E731
    price, value, bear, bull = v["price"], sv["base"]["per_share"], sv["bear"]["per_share"], sv["bull"]["per_share"]
    f = {}
    if price:
        f["price"] = f"Share price: {_rs(price)}"
    for s in ("base", "bear", "bull"):
        if sv[s]["per_share"] is not None:
            f[f"value_{s}"] = f"Our {s} value: {_rs(sv[s]['per_share'])} a share"
        elif sv[s]["error"] or v["error"]:
            f[f"value_{s}"] = f"Our {s} case has no value: {sv[s]['error'] or v['error']}"
    if value is not None and price:
        f["upside"] = f"{'Upside' if value > price else 'Downside'} to our base value: {_pc(abs(value / price - 1))}"
        f["gap"] = f"Price {'above' if price > value else 'below'} our base value by {_rs(abs(price - value))} a share"
        if bull is not None and price > bull:
            f["over_bull"] = f"Price above our bull value by {_rs(price - bull)} ({_pc(price / bull - 1)})"
        if bear is not None and price < bear:
            f["under_bear"] = f"Price below our bear value by {_rs(bear - price)} ({_pc(1 - price / bear)})"
    f["growth"] = f"Our base revenue growth, average {years[0]}–{years[-1]}: {_pc(avg('growth'))} a year"
    f["margin"] = f"Our base EBITDA margin, average {years[0]}–{years[-1]}: {_pc(avg('ebitda_margin'))}"
    if sv["base"].get("implied_growth") is not None:
        f["implied_growth"] = (f"Flat revenue growth the price needs for {n} years, other inputs at base (reverse DCF): "
                               f"{_pc(sv['base']['implied_growth'])} a year")
    elif price and value is not None:
        f["implied_growth"] = "No flat revenue growth between -30% and +80% a year gets our base value to the price"
    if not v["error"]:
        val, dv = doc.valuation, model.VALUATION
        f["wacc"] = f"Discount rate (WACC): {_pc(v['wacc'])}; terminal growth {_pc(v['g'])}"
        if val.wacc_override is not None:
            f["wacc"] += " (WACC typed by you)"
        else:  # the cost of equity's parts, and which of them nobody chose for this company
            names = {"rf": "the risk-free rate", "erp": "the premium", "beta": "beta"}
            dflt = [names[k] for k in names if getattr(val, k) == dv[k]]
            f["wacc"] += (f"; cost of equity {_pc(v['ke'])} = {_pc(val.rf)} risk-free + beta {val.beta:g} x {_pc(val.erp)} "
                          "premium" + (f" ({', '.join(dflt)}: the app default, not estimated for this company)" if dflt else
                                       " (set by you)"))
    if sv["base"]["tv_share"] is not None:
        f["tv_share"] = f"Share of our base enterprise value that is terminal value: {_pc(sv['base']['tv_share'])}"
    # growth history at the price's own horizon (n years), else the longest run the data has; plus the recent pace
    hz = min(n, len(hist) - 1)
    cs = model.cagrs(hist, labels, hz)
    if cs:
        b = max(cs, key=lambda c: c["value"])
        f[f"best{hz}"] = (f"Fastest {hz}-year revenue growth since {labels[0]}"
                          + (f" (the longest run in the data, shorter than the {n} years the price needs)" if hz < n else "")
                          + f": {_pc(b['value'])} a year ({b['from']}–{b['to']})")
    for y in sorted({3, hz}):
        cs = model.cagrs(hist, labels, y)
        if cs:
            f[f"last{y}"] = f"Revenue growth over the last {y} years ({cs[-1]['from']}–{cs[-1]['to']}): {_pc(cs[-1]['value'])} a year"
    p0 = out["base"][0]
    for k, name in (("revenue", "Revenue"), ("ebitda", "EBITDA"), ("pat", "Net profit")):
        if hist[-1].get(k) is not None:
            f[f"{k}_last"] = f"{name} {last}: {model._cr(hist[-1][k])}"
        f[f"{k}_next"] = f"{name} {years[0]}, our base: {model._cr(p0[k])}"
    show = {"pct": _pc, "x": "{:.2f}x".format, "days": "{:.0f} days".format}
    for k in model.key_numbers(hist, labels):
        if k["last"] is not None:
            f[f"kn_{k['key']}"] = (f"{k['label']} {k['year']}: {show[k['kind']](k['last'])}"
                                   + (f" (median of the 3 years before: {show[k['kind']](k['typical'])})" if k["typical"] is not None else ""))
    # the margin over the whole history: a cyclical's 3-year median is the wrong window
    ms = [(y, x["ebitda_margin"]) for y, x in zip(labels, model.ratios(hist)) if x["ebitda_margin"] is not None]
    if len(ms) >= 4:
        lo, hi = min(ms, key=lambda t: t[1]), max(ms, key=lambda t: t[1])
        f["range_margin"] = (f"EBITDA margin {labels[0]}–{last}: low {_pc(lo[1])} ({lo[0]}), median "
                             f"{_pc(statistics.median(m for _, m in ms))}, high {_pc(hi[1])} ({hi[0]})")
    if (c := hist[-1]["cash"]) > 2 * max(hist[-2]["cash"], 0.0) and c - hist[-2]["cash"] > 0.05 * hist[-1]["revenue"]:
        f["cash_jump"] = f"Cash {last}: {model._cr(c)}, up from {model._cr(hist[-2]['cash'])} in {labels[-2]}"
    if g := model.share_gap(co):
        f["shares"] = f"Share count: {g['text']}"
    if mo := co["sources"].get("moved_out"):
        f["moved_out"] = (f"Our {last} base leaves out {model._cr(mo['revenue_out'])} of revenue and {model._cr(mo['ebitda_out'])} "
                          f"of EBITDA of a business that left the group ({mo['reason']}); growth applies to the rest")
    nb = v.get("note") or {}
    unit = lambda key, x: f"{x:.0f} days" if key in ("dso", "dio", "dpo") else _pc(x)  # noqa: E731
    ours = lambda key: v["wacc"] if key == "wacc" else v["g"] if key == "g" else avg(key)  # noqa: E731
    for d in nb.get("impact", [])[:5]:
        ends = " and ".join(_rs(x) for x in (d["down"], d["up"]) if x is not None)
        step = f"{d['step']:.0f} days" if d["key"] in ("dso", "dio", "dpo") else f"{d['step'] * 100:g} pp"
        f[f"impact_{d['key']}"] = (f"{d['label']} {step} down and up from our {unit(d['key'], ours(d['key']))}: "
                                   f"our base value {ends} a share")
    for k, b in (nb.get("breakevens") or {}).items():
        name = {"growth": "Flat revenue growth", "ebitda_margin": "EBITDA margin", "wacc": "WACC", "g": "Terminal growth"}[k]
        if b["value"] is None:
            f[f"be_{k}"] = f"No {name.lower()} in the range searched gets our base value to the price"
            continue
        f[f"be_{k}"] = (f"{name} at which our base value equals the price: {_pc(b['value'])}"
                        + (" (our base case has no value, so this is far outside it)" if value is None
                           else f" (more than twice our {_pc(ours(k))}: far outside our base case)"
                           if ours(k) > 0 and b["value"] > 2 * ours(k) else ""))
        if k == "ebitda_margin" and len(ms) >= 4 and b["value"] > avg("ebitda_margin"):
            seen = [(y, m) for y, m in ms if m >= b["value"]]
            f["be_margin_seen"] = (f"Years since {labels[0]} with an EBITDA margin at or above the {_pc(b['value'])} the "
                                   "price needs: " + (", ".join(f"{y} ({_pc(m)})" for y, m in seen) or "none"))
    radar = model.forensic(hist, labels, doc.notes)
    for x in sorted(radar, key=lambda x: model.SEVERITY.index(x["severity"])):  # red first, as the risks rank
        if x["severity"] in SEVERITY_WORD:
            f[f"flag_{x['key']}"] = f"{SEVERITY_WORD[x['severity']]} rule check, {x['title']}: {x['fact']}. {x['detail']}"
        elif x["key"] in ("debt", "cover") and x["severity"] == "ok":  # leverage is a point for every note
            f[f"lev_{x['key']}"] = f"Passed rule check, {x['title']}: {x['fact']}. {x['detail']}"
    oneoffs = model.detect_oneoffs(hist, labels)
    for o in oneoffs:
        if o["year"] in labels[-3:]:
            f[f"oneoff_{o['metric']}_{o['year']}"] = f"Unusual year: {o['note']}"
    f.update(_track_facts(doc, co, v))

    props = {p.get("id"): p for p in doc.proposals}
    reports = {r.id: r for r in doc.reports}
    cites = {}

    def cite(what, src, report):
        file = src.get("file") or (reports[report].file if report in reports else None)
        if file and src.get("quote") and isinstance(src.get("page"), int) and len(cites) < MAX_CITES:
            cites[f"C{len(cites) + 1}"] = {"what": what, "file": file, "page": src["page"], "quote": src["quote"], "report": report}
            return f"C{len(cites)}"
    label = {k: lab for k, lab, _ in model.DRIVERS}
    srcs = doc.assumption_sources.get("base") or {}
    try:
        dflt = model.default_assumptions(hist, exclude=set(doc.excluded_years), labels=labels)
    except ValueError:
        dflt = {}
    fades = model.default_ends(hist, dflt) if dflt else {}
    window = [y for y in labels if y not in doc.excluded_years][-3:]  # the default's 3-year window
    for k in [*srcs, *(k for k in IN_FACTS if k not in srcs)]:
        a, pid = sc["base"].get(k), srcs.get(k)
        if a is None or k not in label:
            continue
        p = props.get(pid) or {}
        c = cite(f"Behind the approved input {label[k]} ({p.get('reasoning', '')[:200]}):", p.get("source") or {}, p.get("report")) \
            if p.get("kind") == "assumption" and not p.get("from_history") else None
        show_k = (lambda x: f"{x:,.0f} days") if k in ("dso", "dio", "dpo") else model._cr if k == "debt_change" else _pc
        path = show_k(a["start"]) + (f" fading to {show_k(a['end'])}" if a.get("end") is not None else "")
        rule = pid == "history" or p.get("from_history") or pid is None and k in dflt and abs(a["start"] - dflt[k]) < 1e-9 \
            and (a.get("end") is None if k not in fades else a.get("end") is not None and abs(a["end"] - fades[k]) < 1e-9)
        why = f"drafted from a document and approved, see {c}" if c else "the rule default from history" if rule else "set by you"
        if rule and not c:  # a flagged year inside the default's window: say it, and what leaving it out gives
            for o in oneoffs:
                if o["metric"] == k and o["year"] in window and o.get("unreliable"):  # no number to cite: it isn't spending
                    why += f"; includes {o['year']}, whose capex from the net-block change is unreliable"
                elif o["metric"] == k and o["year"] in window:
                    why += f"; includes {o['year']}'s flagged {_pc(o['value'])}"
                    with contextlib.suppress(ValueError):
                        why += (f"; {_pc(model.default_assumptions(hist, exclude={*doc.excluded_years, o['year']}, labels=labels)[k])}"
                                f" with {o['year']} left out")
        f[f"in_{k}"] = f"Base input {label[k]}: {path} ({why})"
    for x in doc.flag_notes:
        cite(f"Approved explanation of the {x.get('key')} flag (AI-written): {x.get('summary', '')[:300]}", x,
             (props.get(x.get("proposal")) or {}).get("report"))
    for key, x in doc.notes.items():
        if not isinstance(x, dict):
            continue
        rep = (props.get(x.get("proposal")) or {}).get("report")
        if key.startswith("oneoff:"):
            cite(f"Approved explanation of {key[7:]} (AI-written): {x.get('summary', '')[:300]}", x, rep)
        elif key.startswith("ar:auditor:") and x.get("opinion", "unmodified") == "unmodified" and not x.get("changed"):
            continue  # a clean opinion from the same firm isn't a point; the rule check already says it passed
        elif key.startswith("ar:"):
            for row in (x.get("rows") or [])[:4]:
                amt = f": {model._cr(row['amount'])}" if isinstance(row.get("amount"), (int, float)) else ""
                cite(f"Annual-report note, {x.get('topic')} {x.get('year')}, {row.get('label')}{amt}.",
                     dict(row, file=x.get("file")), rep)
    return co["name"], f, cites


def _track_facts(doc, co, v):
    """What the latest results changed, for the note (5.3): each line and missed driver against the forecast made
    before them, the value range and the growth the price needed then, warning signs lit or cleared since. {} until
    a forecast has been scored against reported years."""
    t = tracking(doc, co, v)
    s = next((r for r in reversed(t["records"]) if r["years"]), None) if t else None
    if not s:
        return {}
    y, was, now, f = s["years"][-1], t["was"], t["now"], {}
    yr, made = y["year"], (s["made_at"] or "")[:10]
    since = f" (forecast saved {made})" if made else ""
    for x in y["lines"]:
        if x["err"] is not None:
            f[f"trk_{x['key']}"] = (f"{x['label']} {yr}: {model._cr(x['actual'])} reported against our earlier forecast of "
                                    f"{model._cr(x['forecast'])}{since}, {_pc(abs(x['err']))} {'above' if x['err'] > 0 else 'below'} it")
    show = lambda k, x: f"{x:.0f} days" if k in ("dso", "dio", "dpo") else _pc(x)  # noqa: E731
    for x in y["drivers"]:
        if not x["hit"] or x["key"] in ("growth", "ebitda_margin"):
            f[f"trk_in_{x['key']}"] = (f"{x['label']} {yr}: {show(x['key'], x['actual'])} reported against the "
                                       f"{show(x['key'], x['forecast'])} we assumed ({'inside' if x['hit'] else 'outside'} our tolerance)")
    for k, x in (was.get("values") or {}).items():
        if x is not None:
            f[f"was_value_{k}"] = f"Our {k} value before the {yr} results: {_rs(x)} a share"
    if was.get("implied") is not None:
        f["was_implied"] = f"Flat revenue growth the price needed before the {yr} results: {_pc(was['implied'])} a year"
    if was.get("price"):
        f["was_price"] = f"Share price when the forecast before the {yr} results was saved: {_rs(was['price'])}"
    ids = lambda xs: {x.get("id"): x.get("name") for x in xs or [] if isinstance(x, dict)}  # noqa: E731
    old, cur = ids(was.get("flags")), ids(now["flags"])
    if lit := [n for k, n in cur.items() if k not in old]:
        f["trk_flags_new"] = f"Warning signs lit since the {yr} results came in: {', '.join(lit)}"
    if gone := [n for k, n in old.items() if k not in cur]:
        f["trk_flags_gone"] = f"Warning signs that cleared with the {yr} results: {', '.join(gone)}"
    return f


@app.post("/api/note/write")
def write_note(req: ModelDoc):
    """The note's words. The LLM gets only the computed facts and the approved quotes (_thesis_facts); rules check
    every number, reference and quote and the wording (ai.thesis_checks); a failure is sent back once with the reasons,
    then returned as rejected with what failed. Only this endpoint calls the LLM for the note; nothing reads the
    words back into a number. The note carries the inputs hash so the client can tell when it goes stale."""
    if not ai.available():
        raise HTTPException(503, ai.NOT_SET)
    name, facts, cites = _thesis_facts(req)
    cache = {}

    def texts(file, page):
        """The page's texts in every attached document of that name; [] if none is attached, None if none has its text."""
        found = None
        for r in (r for r in req.reports if r.file == file):
            if r.id not in cache:
                try:
                    cache[r.id] = report_pages(r)
                except HTTPException:  # the page text isn't on this machine any more
                    cache[r.id] = None
            if cache[r.id] is not None:
                found = (found or []) + (list(cache[r.id][page - 1]) if 1 <= page <= len(cache[r.id]) else [])
        return found if any(r.file == file for r in req.reports) else []

    prompt, why = ai.thesis_prompt(name, facts, cites), None
    try:
        for rounds in (1, 2):
            reply = ai.merge_repeats(ai.write_thesis(prompt, why))
            checks = ai.thesis_checks(reply, facts, cites, texts)
            failed = [c for c in checks if c["pass"] is False]
            if not failed:
                break
            why = "\n".join(f"- {c['name']}: {c['detail']}" for c in failed)
    except ai.LLMError as e:
        raise HTTPException(502, str(e))
    keep = ("headline", "thesis", "priced_in", "risks", "bull_trigger", "bear_trigger", "what_to_watch")
    return {**{k: reply[k] for k in keep}, "facts": facts, "cites": cites, "checks": checks, "rounds": rounds,
            "status": "rejected" if failed else "written", "inputs_hash": inputs_hash(req),
            "written_at": datetime.now().isoformat(timespec="seconds"), "ai": True}


@app.get("/api/sample")
def sample():
    from test_model import fake_export  # ponytail: synthetic demo company, swap for a real export later
    buf = io.BytesIO()
    fake_export(buf)
    buf.seek(0)
    return _company_payload(model.parse_export(buf))


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


class RestatedRequest(DefaultsRequest):
    year: str = Field(pattern=r"^FY\d{4}$")
    use: bool = True


@app.post("/api/restated")
def restated(req: RestatedRequest):
    """One click: a year a later filing restated, switched to the restated numbers (or back), by rules from the two
    rows the merge kept (model.use_restated). The dashboard payload for the new company; the client saves it."""
    try:
        co = model.use_restated(req.company.model_dump(), req.year, req.use)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _company_payload(co, req.excluded_years, [f.model_dump() for f in req.filings], req.notes)


@app.post("/api/company")
def refresh(req: DefaultsRequest):
    """Everything the dashboard derives from the company, again: after a filing is attached or removed."""
    return req.payload()


@app.post("/api/project")
def project(req: ModelRequest):
    co, sc, n, out = req.projection()
    v = req.dcf(co, sc, n, out)
    return {"years": [model.fy(d, True) for d in model.projected_dates(co, n)], "scenarios": out,
            "valuation": v, "inputs_hash": inputs_hash(req), "peers": req.peer_table(co), "tracking": tracking(req, co, v)}


@app.post("/api/export")
def export(req: ModelRequest):
    co, sc, n, _ = req.projection()
    safe = re.sub(r"[^\w\- ]+", "", co["name"], flags=re.ASCII).strip() or "company"  # headers are latin-1
    return Response(model.to_excel(co, sc, n, req.active, req.valuation.model_dump(), req.peer_table(co)),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{safe} model.xlsx"'})


# ---------- add a company by ticker (5.1): exchange filings by rules, no AI ----------

CACHE = "_cache"  # what the exchange sent, models/_cache/<site>/ ("_": never a slug); prices 15 min, lists 6 h, files kept
FETCH_YEARS, FETCH_QUARTERS = 10, 8  # annual and quarterly results filings read per company
_clients, _clients_lock = {}, threading.Lock()


def nse(root=None):
    """One polite client per library folder (one request a second, shared by every request)."""
    root = root or MODELS
    with _clients_lock:  # two first requests at once must not make two clients (and twice the request rate)
        if root not in _clients:
            _clients[root] = sources.Client(root / CACHE / "nse")
        return _clients[root]


def _sym(s):
    try:
        return sources.symbol(s)
    except ValueError as e:
        raise HTTPException(422, str(e))


class SearchRequest(BaseModel):
    q: str = Field(max_length=100)


class SymbolRequest(BaseModel):
    symbol: str = Field(max_length=40)


class FetchRequest(SymbolRequest):
    company: Company | None = None  # Refresh: the open model's company; its years the filings don't cover are kept
    documents: bool = True  # the latest annual report and call transcript too
    fresh: bool = False  # Refresh: "anything new?" needs NSE's answer, not a list kept from before
    separate: bool = False  # "Keep separate": don't fill years from an earlier Excel upload of the same company


@app.post("/api/nse/search")
def nse_search(req: SearchRequest):
    """Companies on NSE matching a name or symbol (POST: only this app's pages can make the server go online)."""
    try:
        return {"results": sources.search(nse(), req.q), "error": None}
    except sources.Offline as e:
        return {"results": [], "error": str(e)}


@app.post("/api/nse/price")
def nse_price(req: SymbolRequest):
    """Today's price and share count (cached 15 minutes). stale: NSE didn't answer and this is the last one kept."""
    try:
        q = sources.quote(nse(), _sym(req.symbol))
    except sources.Offline as e:
        raise HTTPException(503, str(e))
    return {"price": q["price"], "shares": q["shares"], "face_value": q["face_value"], "as_of": q["as_of"],
            "at": _ago(q["age"]), "stale": q["age"] >= sources.PRICE_AGE}


def _ago(age):
    return datetime.fromtimestamp(datetime.now().timestamp() - (age or 0)).isoformat(timespec="seconds")


def _norm(name):
    """A company name for matching an export to the exchange's: 'Tata Consultancy Services Ltd.' = '... Limited'."""
    return re.sub(r"\b(limited|ltd|the|india|co|company)\b|[^a-z0-9]", "", (name or "").lower())


def _saved_company(name, root=None):
    """The newest saved Excel upload whose name matches, as a dict, or None. A version that was itself added by
    ticker isn't one: its filed years would be compared with themselves."""
    root, want = root or MODELS, _norm(name)
    for m in list_models(root):  # newest first, every version
        if _norm(m["company"]) == want:
            with contextlib.suppress(HTTPException):
                co = load_model(m["id"], root).company
                if not (co.source or {}).get("symbol"):
                    return co.model_dump()
    return None


# NSE's basic industries (or industries) of lenders and insurers, which this model doesn't fit. ponytail: by NSE's
# names; not the "Financial Services" sector, which also holds exchanges, depositories, AMCs and brokers that fit.
LENDER = re.compile(r"\bbanks?\b|non banking|housing finance|microfinance|\b(life|general) insurance\b|financial institution", re.I)


def _spans(years):
    """[(FY2019, why), (FY2020, why)...] -> "FY2019 to FY2022: why" lines, consecutive years with one reason joined."""
    out = []
    for y, why in sorted(years):
        if out and out[-1][2] == why and int(y[2:]) == int(out[-1][1][2:]) + 1:
            out[-1][1] = y
        else:
            out.append([y, y, why])
    return [f"{a}{'' if a == b else f' to {b}'}: {why}" for a, b, why in out]


def fetch_company(sym, old=None, documents=True, today=None, years=FETCH_YEARS, quarters=FETCH_QUARTERS, fresh=False,
                  separate=False):
    """Build a company from NSE's filings, step by step: yields {"step"} (plain words), {"company": payload} once the
    numbers are ready, {"report"} per document kept, {"note"} for what failed, then {"done"}. Every number comes from the
    filings by rules (model.from_filings); an export company (the open model's, an earlier upload of the same company,
    or the optional local source) fills only the years the filings lack. fresh: Offline unless NSE itself answered
    the filings list (Refresh and "Check all" ask what's new). A bank, NBFC or insurer stops at the quote (model.Lender).
    separate: an earlier Excel upload of the same company is left alone ("Keep separate"), and the new model is named
    "<name> (NSE)" so the library keeps the two apart."""
    c, today = nse(), today or datetime.now()
    yield {"step": f"Finding {sym} on NSE…"}
    q = sources.quote(c, sym)
    name = q["name"]
    kind = q.get("basic_industry") or q.get("industry") or ""
    if LENDER.search(kind):
        raise model.Lender(f"{name} is a lender or insurer ({kind}). Banks, NBFCs and insurers aren’t supported yet, "
                           "because their accounts don’t fit this model, so an Excel export won’t work either.")
    yield {"step": f"Listing {name}’s results filings…"}
    fs = sources.filings(c, sym, fresh)
    annual = [f for f in fs if f["kind"] == "annual"]
    cons = bool(annual) and any(f["consolidated"] for f in annual if f["end"] == annual[0]["end"])
    basis = "consolidated" if cons else "standalone"
    ann = [f for f in annual if f["consolidated"] == cons][:years]
    qtr = [f for f in fs if f["kind"] == "quarter" and f["consolidated"] == cons][:quarters]
    notes, read, mappings = [], [], load_mappings(MODELS)

    def grab(f, label):
        try:
            data, _ = c.get(f["url"], None, sources.MAX_XBRL)  # a filed document never changes: cached for good
            x = model.parse_xbrl(data, mappings=mappings)
        except (sources.Offline, ValueError) as e:
            c.path(f["url"]).unlink(missing_ok=True)  # a block page or a bad file: fetched again next time
            notes.append(f"{label} results couldn’t be read: {e}")
            return None
        fid = hashlib.sha1(data).hexdigest()[:12]
        _write(MODELS / FILINGS / f"{fid}.xml", data)  # re-read by rules when a mapping is approved, like an upload
        return {"id": fid, "file": f"NSE {sym} {label} {basis}.xml", **x}

    if ann:
        yield {"step": f"Reading {len(ann)} annual results ({model.fy(ann[-1]['end'])} to {model.fy(ann[0]['end'])})…"}
    for i, f in enumerate(ann):
        yield {"detail": f"{model.fy(f['end'])} ({i + 1} of {len(ann)})"}
        if (x := grab(f, model.fy(f["end"]))) and x["kind"] == "annual":
            read.append(x)
    quarters = []
    if qtr:
        yield {"step": f"Reading the latest {len(qtr)} quarterly results…"}
    for i, f in enumerate(qtr):
        yield {"detail": f"{f['end']:%b %Y} ({i + 1} of {len(qtr)})"}
        if (x := grab(f, f"{f['end']:%b %Y} quarter")) and x["kind"] == "quarter":
            quarters.append(x)

    prev = (old or {}).get("source") or {}  # a refreshed model that was fetched before keeps saying where years came from
    twin = None if old else _saved_company(name)
    other, whose = (old, "this model") if old else (None if separate else twin, "your earlier Excel upload")
    local = False
    if other is None and local_source is not None:
        label = getattr(local_source, "LABEL", "a local source")
        yield {"step": f"Reading older years from {label}…"}
        try:
            other, whose, local = local_source.company(sym, MODELS / CACHE), label, True
        except Exception as e:  # noqa: BLE001  ponytail: optional local source; any failure only means no older years
            notes.append(f"{label[:1].upper()}{label[1:]} couldn’t be read: "
                         f"{e if isinstance(e, (sources.Offline, ValueError)) else f'its layout looks different ({type(e).__name__})'}")
    try:
        filed, skipped = model.from_filings(name, read, quarters + read, q, least=1 if other else 2)
        why = None
    except model.Lender:
        raise
    except ValueError as e:
        filed, skipped, why = None, [], str(e)
    listed = sources._date((q.get("listed") or "")[:11])
    yield {"step": "Putting the history together…"}
    filled, mism, merged = [], [], []
    if filed and other:
        co, filled, mism, merged = model.merge(filed, other)
        if not local:
            co["name"] = other["name"]  # the saved model keeps its name, so the library keeps one row for the company
    elif filed:
        co = filed
    elif other:
        co = {**other, "market": {**(other.get("market") or {}), **{k: q[k] for k in ("price", "shares", "face_value") if q[k]}},
              "quarters": model.filing_quarters(quarters + read) or other.get("quarters")}
    else:
        more = [why]
        if listed and listed.year >= today.year - 2:
            more.append(f"{name} listed on NSE in {listed:%b %Y}, so few results are filed yet.")
        if notes:
            more.append("Some filings couldn’t be read, so trying again may help.")
        raise ValueError(" ".join([*more, "Upload an Excel export instead."]))
    notes += merged
    labels = model.labels(co["dates"])
    have = set(labels)
    no_bs = {s["year"] for s in skipped}
    last = int(labels[-1][2:])
    gaps = [(f"FY{y}", "NSE’s results filings for these years carry no balance sheet in XBRL"
             if f"FY{y}" in no_bs else f"listed on NSE in {listed:%b %Y}, so no results before that"
             if listed and listed.year >= y else "no results filing in XBRL on NSE (it starts in 2018-19)")
            for y in range(last - FETCH_YEARS + 1, last + 1) if f"FY{y}" not in have]
    if prev:  # what an earlier fetch found still holds (merge never compares a filed year with itself)
        new = {(m["year"], m["line"]) for m in mism}
        mism = [m for m in prev.get("mismatches") or [] if (m["year"], m["line"]) not in new] + mism
    source = {"symbol": sym, "exchange": "NSE", "basis": basis, "industry": q.get("industry"),
              "fetched_at": today.isoformat(timespec="seconds"), "price_at": _ago(q["age"]),
              "years": {y: (prev.get("years") or {}).get(y, model.EXPORT) if y in filled or not filed
                        or (prev.get("years") or {}).get(y) == model.RESTATED_USE else "NSE filing" for y in labels},
              "missing": _spans(gaps), "from": (prev.get("from") if old and prev else whose)
              if filled or (not filed and other) else None,
              "mismatches": [{**m, "filing": round(m["filing"], 2), "export": round(m["export"], 2)} for m in mism],
              "notes": notes, "documents": [],
              # restated years with both rows (model.use_restated); an earlier fetch's stay until compared again
              "restated": (new_r := co.pop("restated", None) or []) + [
                  r for r in prev.get("restated") or [] if r.get("year") not in {x["year"] for x in new_r}]}
    co["source"] = source
    if separate and twin:
        co["name"] = f"{co['name']} (NSE)"
    payload = _company_payload(co, (), read)
    restated = restatements(co, MODELS)
    payload["restated"], payload["fetched"] = restated, {"filings": read}
    yield {"company": payload}
    if not documents:
        yield {"done": True}
        return

    yield {"step": "Looking for the annual report and the latest call transcript…"}
    try:
        ars = sources.annual_reports(c, sym)
        docs = sources.documents(c, sym, today)
    except sources.Offline as e:
        yield {"note": f"The documents list couldn’t be read: {e}"}
        ars, docs = [], []
    source["documents"] = [{"date": d["date"].date().isoformat(), "kind": d["kind"], "title": d["title"], "url": d["url"]}
                           for d in docs[:8]] + [{"date": None, "kind": "annual", "title": f"Annual report {a['year']}",
                                                 "url": a["url"]} for a in ars[:3]]
    yield {"documents": source["documents"]}
    want = []
    if ars and ars[0]["pdf"]:
        want.append((ars[0]["url"], f"the {ars[0]['year']} annual report", ars[0]["year"], "annual",
                     f"NSE {sym} annual report {ars[0]['year']}.pdf"))
    elif ars:
        yield {"note": f"The {ars[0]['year']} annual report on NSE is a zip file; download it from NSE and attach it "
                       "on the Checks page."}
    else:
        yield {"note": "NSE has no annual report for this company yet (it may have listed this year)."}
    t = next((d for d in docs if d["kind"] == "transcript"), None)
    if t:
        want.append((t["url"], f"the {t['date']:%d %b %Y} call transcript", sources.fy_of(t["date"]), "transcript",
                     f"NSE {sym} call transcript {t['date']:%Y-%m-%d}.pdf"))
    else:
        yield {"note": "No earnings-call transcript filed on NSE in the last two years."}
    for url, what, year, kind, file in want:
        yield {"step": f"Downloading {what}…"}
        try:
            data, _ = c.get(url, None, MAX_PDF)
            yield {"detail": f"reading {len(data) / 1048576:.1f} MB of pages"}
            yield {"report": keep_report(data, file, year, kind)}
        except (sources.Offline, ValueError) as e:
            c.path(url).unlink(missing_ok=True)  # an unreadable or cut-off file: fetched again next time
            yield {"note": f"Couldn’t keep {what}: {e}"}
    yield {"done": True}


@app.post("/api/nse/fetch")
def nse_fetch(req: FetchRequest):
    """fetch_company as a stream of JSON lines, so the page can show each step and stop it (closing the request stops
    it at the next step; what was downloaded stays cached, so trying again is quick)."""
    sym = _sym(req.symbol)
    return _stream(fetch_company(sym, req.company.model_dump() if req.company else None, req.documents, fresh=req.fresh,
                                 separate=req.separate),
                   f"building {sym}", "upload an Excel export instead")


def _stream(events, doing, instead):
    """A generator of events as JSON lines; a failure ends the stream with {"error"} (the status line is already sent),
    "final" when trying again won't change it (no such symbol, too few years) and "lender" for a bank or insurer."""
    def lines():
        try:
            for ev in events:
                yield json.dumps(jsonable_encoder(ev), allow_nan=False) + "\n"
        except (sources.Offline, ValueError) as e:
            yield json.dumps({"error": str(e), "final": isinstance(e, (ValueError, sources.NotFound)),
                              "lender": isinstance(e, model.Lender)}) + "\n"
        except HTTPException as e:
            yield json.dumps({"error": str(e.detail)}) + "\n"
        except Exception as e:  # noqa: BLE001
            yield json.dumps({"error": f"Something went wrong {doing}: {type(e).__name__}. Try again, or {instead}."}) + "\n"
    return StreamingResponse(lines(), media_type="application/x-ndjson")


# ---------- tracking new results (5.3): rules only, no AI ----------

def _lit(req, co):
    """The warning signs lit now (red and amber rule checks): [{id, name}]."""
    labels = model.labels(co["dates"])
    checks = model.rule_checks(co["hist"], labels, model.detect_oneoffs(co["hist"], labels),
                               model.data_checks(req.company.model_dump()), req.notes)
    return [{"id": c["id"], "name": c["name"]} for c in checks if c["status"] in ("red", "amber")]


def track_record(doc: "ModelDoc", new_years=(), now=None):
    """The base forecast as it stands, before new results replace the company: model.forecast_record plus the value
    range, the growth the price needs, the lit warning signs and whether a note was written."""
    co, sc, n, out = doc.projection()
    ex = {s: model.expand(sc[s], n) for s in model.SCENARIOS}
    cover = _coverage(out, co, ex, doc.valuation.model_dump())
    return {**model.forecast_record(co, ex["base"], out["base"]), "made_at": doc.saved_at,
            "recorded_at": (now or datetime.now()).isoformat(timespec="seconds"), "new_years": list(new_years),
            "values": cover["values"], "price": cover["price"], "implied": cover["implied"], "growth": cover["growth"],
            "flags": _lit(doc, co), "note": bool(doc.note), "kept": []}


def with_results(doc: "ModelDoc", company, filings=(), now=None):
    """The document with a refreshed company when it brings new reported years or a later quarter, else None. New
    years first record the forecast they replace (track_record); the assumptions never change here. Returns (doc or
    None, new year labels, the new last quarter end or None)."""
    new = Company.model_validate(company)
    have = {str(d)[:7] for d in doc.company.dates}
    years = [y for y, d in zip(model.labels(new.dates), new.dates) if str(d)[:7] not in have and d > doc.company.dates[-1]]
    q_end = lambda c: c.quarters.dates[-1] if c.quarters and c.quarters.dates else None  # noqa: E731
    q = q_end(new) if q_end(new) and (not q_end(doc.company) or q_end(new) > q_end(doc.company)) else None
    if not years and not q:
        return None, [], None
    d = doc.model_copy(deep=True)
    if years and not any(r.get("last") == model.labels(doc.company.dates)[-1] for r in d.track):
        d.track = [*d.track, track_record(doc, years, now)][-model.MAX_TRACK:]
    d.company = new.model_copy(update={"name": doc.company.name})  # the library keeps one row per company
    d.reviewed_at = None  # new numbers: back to draft, as any change of filings does in the app
    ids = {f.id for f in d.filings}
    d.filings = [*d.filings, *(Filing.model_validate(f) for f in filings if f["id"] not in ids)]
    return d, years, q


def tracking(req, co, v):
    """The saved forecasts scored against the years now reported (model.track), the rules proposals the latest results
    raise (model.track_proposals, against today's rule defaults) and what changed since: value range, the growth the
    price needs, warning signs. None until a forecast has been recorded."""
    if not req.track:
        return None
    labels = model.labels(co["dates"])
    try:
        d = model.default_assumptions(co["hist"], exclude=set(req.excluded_years), labels=labels)
    except ValueError:
        d = {}
    scored = model.track(req.track, co)
    base = {k: p.model_dump() for k, p in req.scenarios["base"].items()}
    rec, sv = req.track[-1], v["scenarios"]
    odd = {(o["metric"], o["year"]) for o in model.detect_oneoffs(co["hist"], labels)}
    return {**scored, "proposals": model.track_proposals(scored, req.track, base, d, odd),
            "was": {k: rec.get(k) for k in ("last", "made_at", "recorded_at", "new_years", "values", "price", "implied", "flags", "note")},
            "now": {"values": {s: sv[s]["per_share"] for s in model.SCENARIOS}, "price": v["price"],
                    "implied": sv["base"].get("implied_growth"), "flags": _lit(req, co)}}


class ApplyRequest(BaseModel):
    doc: ModelDoc
    company: Company
    filings: list[Filing] = []


@app.post("/api/track/apply")
def track_apply(req: ApplyRequest):
    """Refresh found results: the document with the new company, its filings and (for new years) the forecast they
    replace, recorded. Nothing is fetched and no assumption changes; the client saves it as usual."""
    d, years, q = with_results(req.doc, req.company.model_dump(mode="json"), [f.model_dump() for f in req.filings])
    return {"doc": d and d.model_dump(mode="json"), "years": years, "quarter": q and q.isoformat()[:10]}


def check_all(today=None):
    """Every company added by ticker, newest version each: fetch its results (fetch_company, no documents), and when
    there are new ones save today's version with them (with_results). Yields {step}, {result: {id, company, status
    new | none | skipped | failed, text}}, {done}. Stopping keeps what was saved so far."""
    todo = latest_models(MODELS)
    for i, m in enumerate(todo):
        row = {"id": m["id"], "company": m["company"]}
        try:
            doc = load_model(m["id"])
        except HTTPException:
            continue
        sym = (doc.company.source.get("symbol") if doc.company.source else None)
        if not sym:
            yield {"result": {**row, "status": "skipped", "text": "From an Excel export, so there is no NSE symbol to check."}}
            continue
        yield {"step": f"Checking {m['company']} ({i + 1} of {len(todo)})…"}
        try:
            p = next(e["company"] for e in fetch_company(_sym(sym), doc.company.model_dump(), False, today, fresh=True)
                     if "company" in e)
            d, years, q = with_results(doc, p["company"], p["fetched"]["filings"], today)
        except (sources.Offline, ValueError, HTTPException, StopIteration) as e:
            yield {"result": {**row, "status": "failed", "text": f"Couldn’t check: {getattr(e, 'detail', None) or e}"}}
            continue
        if d is None:
            yield {"result": {**row, "status": "none", "text": "No new results."}}
            continue
        mid, at = save_model(d, now=today)
        what = f"{', '.join(years)} results" if years else f"the quarter to {q:%b %Y}"
        yield {"result": {**row, "id": mid, "saved_at": at, "status": "new",
                          "text": f"Added {what}. Your assumptions haven’t changed."}}
    yield {"done": True}


@app.post("/api/track/check")
def track_check():
    """check_all as JSON lines; closing the request stops it after the company in hand."""
    return _stream(check_all(), "checking for new results", "use Refresh on each company")


# ---------- watchlist (5.4): the coverage page's prices and history, rules only ----------

WATCH = "watch.json"  # library root (list_models reads only */*.json): {"symbols": [...], "history": {slug: [...]}}
WATCH_MAX = 100  # tickers watched without a model
HISTORY_MAX = 750  # ponytail: one point a day per company (about three years), oldest dropped; a file per company past that
TRIES = 2  # failed price checks in a row before the rest are left for later (NSE down or refusing)


def _watch(root=None, strict=False):
    """The watch file, or an empty one. strict: a damaged file is a 409, so a write never replaces it."""
    p = (root or MODELS) / WATCH
    try:
        w = json.loads(p.read_bytes())
        if isinstance(w, dict) and isinstance(w.get("symbols"), list) and isinstance(w.get("history"), dict):
            return w
    except FileNotFoundError:
        return {"symbols": [], "history": {}}
    except (OSError, ValueError):
        pass
    if strict:
        raise HTTPException(409, f"{WATCH} in the models folder is damaged; move it away and try again.")
    return {"symbols": [], "history": {}}


def _live(root, sym):
    """The last NSE quote kept for a symbol, however old, without going online; None when there's none or no price."""
    if not sym:
        return None
    try:
        q = sources.quote(nse(root), sources.symbol(sym), cached=True)
    except (sources.Offline, ValueError):
        return None
    return q if q["price"] else None


def watchlist(root=None):
    """Watched tickers with their cached price, and the daily price-against-value history per company."""
    root = root or MODELS
    w = _watch(root)
    out = []
    for x in w["symbols"]:
        q = _live(root, x.get("symbol"))
        out.append({"symbol": x.get("symbol"), "name": x.get("name"), "added_at": x.get("added_at"),
                    "price": q and q["price"], "at": q and _ago(q["age"]), "industry": q and q["industry"]})
    return {"watch": out, "history": w["history"]}


def watch_add(sym, root=None, now=None):
    root = root or MODELS
    w = _watch(root, strict=True)
    if any(x.get("symbol") == sym for x in w["symbols"]):
        return w
    if len(w["symbols"]) >= WATCH_MAX:
        raise HTTPException(422, f"The watchlist holds {WATCH_MAX} tickers; remove one first.")
    q = sources.quote(nse(root), sym)  # the name, and proof the symbol trades
    w["symbols"].append({"symbol": sym, "name": q["name"], "added_at": (now or datetime.now()).isoformat(timespec="seconds")})
    _write(root / WATCH, json.dumps(w).encode())
    return w


def snapshot(rows, root=None, now=None):
    """Today's point (price, bear, base, bull per share) for each company's newest version; replaces an earlier one
    from today, so a company has at most one point a day."""
    root = root or MODELS
    w, day = _watch(root, strict=True), (now or datetime.now()).date().isoformat()
    for m in rows:
        v = m.get("values") or {}
        if m.get("price") is None or v.get("base") is None:
            continue
        r = lambda x: None if x is None else round(x, 2)  # noqa: E731
        pts = [p for p in w["history"].get(slug_of(m["id"]), []) if p[0] != day]
        w["history"][slug_of(m["id"])] = (pts + [[day, r(m["price"]), r(v.get("bear")), r(v["base"]), r(v.get("bull"))]])[-HISTORY_MAX:]
    _write(root / WATCH, json.dumps(w).encode())


def slug_of(model_id):
    return model_id.split("/")[0]


def latest_models(root=None):
    """list_models, newest version of each company only."""
    seen, out = set(), []
    for m in list_models(root):
        if slug_of(m["id"]) not in seen:
            seen.add(slug_of(m["id"]))
            out.append(m)
    return out


def refresh_prices(root=None, now=None):
    """Today's NSE price for every company added by ticker and every watched ticker whose cached quote is over 15
    minutes old (one request a second), then today's history point. Yields {step}, {failed: {symbol, text}}, then
    {done, checked, missed, stopped, left}. Nothing here calls the LLM or changes a saved model."""
    root = root or MODELS
    syms = list(dict.fromkeys([m["symbol"] for m in latest_models(root) if m.get("symbol")] +
                              [x.get("symbol") for x in _watch(root)["symbols"] if x.get("symbol")]))
    c, checked, failed, run, stopped = nse(root), 0, 0, 0, False
    todo = [s for s in syms if not ((q := _live(root, s)) and q["age"] < sources.PRICE_AGE)]
    for i, s in enumerate(todo):
        yield {"step": f"Checking today’s prices on NSE: {s} ({i + 1} of {len(todo)})…"}
        try:
            if sources.quote(c, sources.symbol(s))["age"] >= sources.PRICE_AGE:  # the site failed; the cache answered
                raise sources.Offline("NSE didn’t answer, so the price shown is the last one kept.")
            checked, run = checked + 1, 0
        except (sources.Offline, ValueError) as e:
            failed, run = failed + 1, run + 1
            yield {"failed": {"symbol": s, "text": str(e)}}
            if run >= TRIES:
                stopped = True
                break
    snapshot(latest_models(root), root, now)
    yield {"done": True, "checked": checked, "missed": failed, "stopped": stopped, "left": len(todo) - checked - failed}


@app.get("/api/watch")
def watch_list():
    return watchlist()


@app.post("/api/watch")
def watch_post(req: SymbolRequest):
    """Watch a ticker without modelling it (its name and price come from NSE once, now)."""
    try:
        watch_add(_sym(req.symbol))
    except sources.Offline as e:
        raise HTTPException(503, str(e))
    return watchlist()


@app.delete("/api/watch/{symbol}")
def watch_delete(symbol: str):
    sym, w = _sym(symbol), _watch(strict=True)
    w["symbols"] = [x for x in w["symbols"] if x.get("symbol") != sym]
    _write(MODELS / WATCH, json.dumps(w).encode())
    return watchlist()


@app.post("/api/watch/prices")
def watch_prices():
    """refresh_prices as JSON lines; closing the request stops it after the price in hand."""
    return _stream(refresh_prices(), "checking prices", "the prices shown are the last ones kept")


# ---------- peers (5.2): rules find candidates, the AI picks by business mix, rules check and compare ----------

PEER_YEARS = 4  # annual filings read per peer: only FY2023 on make years; older years from an Excel upload when there is one


class PeersRequest(SymbolRequest):
    notes: dict = {}  # pick: the model's approved notes; segment names from an annual-report note go to the AI


class PeerFetchRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=12)


def peer_candidates(sym):
    """Yields progress, {"company": what NSE says this company is}, then {"candidates"} (sources.candidates)."""
    c = nse()
    yield {"step": f"Finding {sym}’s sector on NSE…"}
    q = sources.quote(c, sym, sources.LIST_AGE)
    yield {"company": {k: q[k] for k in ("name", "sector", "industry", "basic_industry")} | {"symbol": sym}}
    if not q["sector"]:
        yield {"note": f"NSE gives no sector for {sym}, so there are no candidates by rules. Add peers yourself below."}
    yield from sources.candidates(c, sym, q)


@app.post("/api/peers/candidates")
def peers_candidates(req: SymbolRequest):
    """Rule candidates as a stream of JSON lines (each quote is a request, one a second; cached for 6 hours)."""
    return _stream(peer_candidates(_sym(req.symbol)), "finding peers", "add peers yourself")


def _segments(notes):
    """{year, names} from the newest approved annual-report segments note, or None."""
    segs = sorted((k, v) for k, v in (notes or {}).items() if k.startswith("ar:segments:") and isinstance(v, dict))
    if not segs:
        return None
    k, v = segs[-1]
    names = [str(r.get("label"))[:80] for r in v.get("rows") or [] if isinstance(r, dict) and r.get("label")][:12]
    return {"year": k.removeprefix("ar:segments:"), "names": names} if names else None


@app.post("/api/peers/pick")
def peers_pick(req: PeersRequest):
    """The AI picks 4 to 8 of the rule candidates by business mix; rules check each pick. A proposal: nothing is used
    until you approve the set. The candidates are listed again by rules from the cache, never taken from the request."""
    if not ai.available():
        raise HTTPException(503, ai.NOT_SET)
    sym = _sym(req.symbol)
    try:
        ev = list(peer_candidates(sym))
    except sources.Offline as e:
        raise HTTPException(503, str(e))
    own, cands = next(e["company"] for e in ev if "company" in e), ev[-1]["candidates"]
    if not cands:
        raise HTTPException(422, f"No candidates by rules for {sym}, so there is nothing for the AI to pick from. "
                                 "Add peers yourself.")
    seg = _segments(req.notes)
    try:
        reply = ai.pick_peers(own, cands, seg)
    except ai.LLMError as e:
        raise HTTPException(502, str(e))
    picks, count = ai.peer_checks(reply, own, cands, seg)
    return {"candidates": cands, "proposal": {
        "id": hashlib.sha1(json.dumps(reply, sort_keys=True).encode()).hexdigest()[:12], "kind": "peers",
        "picks": picks, "checks": [count], "basis": "segments" if seg else "classification",
        "made_at": datetime.now().isoformat(timespec="seconds"), "ai": True}}


def peer_rows(symbols):
    """Each peer's numbers by rules, as it comes (5.1's fetch: filings, older years from an earlier upload or the
    optional local source; no quarters, no documents). Yields steps, then {"row"} per peer."""
    for i, sym in enumerate(symbols):
        yield {"step": f"Reading {sym} ({i + 1} of {len(symbols)})…"}
        try:
            payload = None
            for ev in fetch_company(sym, documents=False, years=PEER_YEARS, quarters=0):
                if "step" in ev or "detail" in ev:  # its own steps, as this peer's progress
                    yield {"detail": (ev.get("detail") or ev["step"]).rstrip("…")}
                payload = ev.get("company", payload)
            co, src = payload["company"], payload["company"]["source"]
            m = co["market"]
            yrs = {}
            for y, w in src["years"].items():
                yrs.setdefault(w, []).append(y)
            yield {"row": {"symbol": sym, "name": co["name"], "year": payload["years"][-1], "price": m.get("price"),
                           "at": src["price_at"], "source": "; ".join(f"{_spans_text(v)}: {w}" for w, v in yrs.items()),
                           "metrics": model.peer_metrics(payload["hist"], m.get("price"), m.get("shares"))}}
        except (sources.Offline, ValueError) as e:  # fetch_company's upload advice is for adding a company, not a peer
            yield {"row": {"symbol": sym, "name": sym, "error": str(e).replace(" Upload an Excel export instead.", "")[:500]}}


def _spans_text(ys):
    return ys[0] if len(ys) == 1 else f"{ys[0]} to {ys[-1]}"


@app.post("/api/peers/fetch")
def peers_fetch(req: PeerFetchRequest):
    """peer_rows as a stream of JSON lines; closing the request stops it after the current peer's request."""
    syms = list(dict.fromkeys(_sym(s) for s in req.symbols))
    return _stream(peer_rows(syms), "reading the peers", "try again later")


# ---------- local model library: models/<company-slug>/<YYYY-MM-DD>.json, one file per company per day ----------

def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60].strip("-")
    return s or "company-" + hashlib.sha1(name.encode()).hexdigest()[:8]  # non-Latin names


def model_file(model_id, root=None):
    """The file for an id, only ever inside root. Anything else is rejected, never resolved."""
    root = root or MODELS
    if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id):
        raise HTTPException(422, "That isn't a valid model id.")
    p = (root / f"{model_id}.json").resolve()
    if not p.is_relative_to(root.resolve()):  # e.g. a symlinked folder pointing elsewhere
        raise HTTPException(422, "That isn't a valid model id.")
    return p


def save_model(doc: ModelDoc, root=None, now=None):
    """Write today's version for this company (replacing any earlier one from today). Returns (id, saved_at)."""
    root = root or MODELS
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


def load_model(model_id, root=None):
    root = root or MODELS
    p = model_file(model_id, root)
    try:
        return ModelDoc.model_validate_json(p.read_bytes())
    except FileNotFoundError:
        raise HTTPException(404, "No saved model with that id. It may have been deleted.")
    except ValidationError:
        raise HTTPException(422, "That saved model is damaged or from an older version of the app.")


def list_models(root=None):
    """Every saved version, most recent first. Unreadable files are skipped."""
    root = root or MODELS
    out = []
    for p in root.glob("*/*.json"):
        model_id = f"{p.parent.name}/{p.stem}"
        try:
            doc = load_model(model_id, root)
            co, sc, n = doc.args()
            ex = {s: model.expand(sc[s], n) for s in model.SCENARIOS}
            projs = {s: model.project(co["hist"], ex[s], n) for s in model.SCENARIOS}
            last = projs[doc.active][-1]["revenue"]
            labels = model.labels(co["dates"])
            checks = model.rule_checks(co["hist"], labels, model.detect_oneoffs(co["hist"], labels),
                                       model.data_checks(doc.company.model_dump()), doc.notes)
            sym = (doc.company.source or {}).get("symbol")
            live = _live(root, sym)
            if live and doc.valuation.price is None:  # today's price, from the cache only (a typed price stays)
                co["market"] = {**co["market"], "price": live["price"]}
            cover = _coverage(projs, co, ex, doc.valuation.model_dump())
            rec = doc.track[-1] if doc.track else {}
            q = co.get("quarters") or {}
        except Exception:  # noqa: BLE001
            continue  # ponytail: skip any unreadable file, never fail the whole list
        out.append({"id": model_id, "company": doc.company.name, "active": doc.active, "n": n,
                    "saved_at": doc.saved_at, "year": model.fy(model.projected_dates(co, n)[-1], True),
                    "revenue": last if last is not None and math.isfinite(last) else None,
                    "flags": sum(c["status"] in ("red", "amber") for c in checks), "reviewed_at": doc.reviewed_at,
                    # results that came in since you last marked it reviewed (5.3)
                    "symbol": sym, "price_saved": doc.company.market.price,
                    "price_at": _ago(live["age"]) if live else (doc.company.source or {}).get("price_at"),
                    "price_live": bool(live), "results_to": max([str(co["dates"][-1])[:10], *[str(d)[:10] for d in (q.get("dates") or [])[-1:]]]),
                    "new_results": rec.get("new_years") if rec and _before(doc.reviewed_at, rec.get("recorded_at")) else None,
                    **cover})
    # ponytail: parses and projects every file per listing; fine for hundreds, add an index file past that
    return sorted(out, key=lambda m: m["saved_at"] or "", reverse=True)


def _before(a, b):
    """ISO time a (or none) earlier than b. The browser writes UTC ("...Z"), the server local time without a zone, so
    both are compared as local times."""
    t = lambda x: (lambda d: d.astimezone().replace(tzinfo=None) if d.tzinfo else d)(datetime.fromisoformat(x))  # noqa: E731
    try:
        return not a or bool(b) and t(a) < t(b)
    except ValueError:
        return False


def _coverage(projs, co, ex, val):
    """The landing row: price, bear/base/bull value per share, base's reverse DCF against its own average growth,
    or why there's no value. Only base gets the reverse DCF (about 50 runs), not the grids or the note."""
    v = model.valuation(projs, co["hist"], val, ex["base"], co["market"], inputs={"base": ex["base"]})
    sv = v["scenarios"]
    g = ex["base"]["growth"]
    return {"price": v["price"], "values": {s: sv[s]["per_share"] for s in model.SCENARIOS},
            "implied": sv["base"].get("implied_growth"), "growth": sum(g) / len(g),
            "why": None if sv["base"]["per_share"] is not None else
            "no share count" if not v["shares"] else "the WACC doesn't clear terminal growth" if v["error"] else
            "final-year free cash flow is negative" if sv["base"]["error"] else "no value per share"}


RESTATED = (("revenue", "Revenue"), ("ebitda", "EBITDA"), ("pat", "Net profit"), ("total_assets", "Total assets"),
            ("borrowings", "Borrowings"))
RESTATE_TOL = 0.005  # 0.5%: exports round lines to whole crores or 2 decimals, so less is noise


def restatements(co, root=None):
    """Reported years in a freshly imported file that moved by more than 0.5% against the latest saved model of the
    same company: {id, saved_at, changes: [{year, line, old, new}], carry: {filings, proposals, notes, reports}}, or None when nothing of it is saved."""
    root = root or MODELS
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
        # what was attached, proposed and approved there carries over, so re-importing never loses it
        carry = {k: [x.model_dump(mode="json") if isinstance(x, BaseModel) else x for x in getattr(doc, k)]
                 for k in ("filings", "proposals", "reports")} | {"notes": doc.notes}
        return {"id": model_id, "saved_at": doc.saved_at, "changes": changes, "carry": carry}
    return None


def delete_model(model_id, root=None):
    root = root or MODELS
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


mimetypes.add_type("application/manifest+json", ".webmanifest")  # the install manifest


class AppPages(StaticFiles):
    """web/dist, plus the app's own page addresses (/c/tcs/valuation...): any other path without a file extension gets
    index.html, so a page opened from its URL, a reload or a new tab works. /api never falls back: a wrong API path is a
    404, not a page, and a missing asset (a dot in its name) stays a 404."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            name = path.rsplit("/", 1)[-1]
            if e.status_code != 404 or path.split("/", 1)[0] == "api" or "." in name:
                raise
            return await super().get_response("index.html", scope)


dist = Path(__file__).parent / "web" / "dist"
if dist.exists():
    app.mount("/", AppPages(directory=dist, html=True), name="web")
