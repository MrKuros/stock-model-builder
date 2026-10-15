"""Run: uv run uvicorn server:app  (serves the API and the built web/dist front end)."""
import io
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, FiniteFloat

import model

MAX_UPLOAD = 5 * 1024 * 1024  # Screener exports are ~50 KB
app = FastAPI()


@app.exception_handler(RequestValidationError)
def _invalid(_, exc):
    # the default handler echoes inputs back, and a NaN among them can't be JSON-encoded
    msgs = "; ".join(f"{'.'.join(map(str, e['loc'][1:]))}: {e['msg']}" for e in exc.errors())
    return JSONResponse({"detail": f"Invalid request: {msgs}"}, status_code=422)


class Company(BaseModel):
    name: str
    dates: list[datetime]
    hist: list[dict[str, float | None]]


class DriverPath(BaseModel):
    start: FiniteFloat
    end: FiniteFloat | None = None  # None = flat; else a straight fade from start to end over the projection


Scenario = Literal["base", "bull", "bear"]


class ModelRequest(BaseModel):
    """The model document (version 3) minus what the engine ignores (excluded_years, saved_at)."""
    company: Company
    scenarios: dict[Scenario, dict[str, DriverPath]]
    active: Scenario = "base"
    n: int = 5

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
        return self.company.model_dump(), sc, self.n

    def projection(self):
        co, sc, n = self.args()
        out = {s: model.project(co["hist"], model.expand(sc[s], n), n) for s in model.SCENARIOS}
        for s, proj in out.items():
            if any(v is not None and not math.isfinite(v) for row in proj for v in row.values()):
                raise HTTPException(422, f"Those {s} assumptions make the numbers too large to project. "
                                         "Try smaller values.")
        return co, sc, n, out


def _company_payload(co):
    return {
        "company": {"name": co["name"], "dates": [d.isoformat() for d in co["dates"]], "hist": co["hist"]},
        "years": [model.fy(d) for d in co["dates"]],
        "ratios": model.ratios(co["hist"]),
        "defaults": model.default_assumptions(co["hist"]),
        "checks": model.data_checks(co),
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
    return _company_payload(co)


@app.get("/api/sample")
def sample():
    from test_model import fake_screener  # ponytail: synthetic demo company, swap for a real export later
    buf = io.BytesIO()
    fake_screener(buf)
    buf.seek(0)
    return _company_payload(model.parse_screener(buf))


@app.post("/api/project")
def project(req: ModelRequest):
    co, _, n, out = req.projection()
    return {"years": [model.fy(d, True) for d in model.projected_dates(co, n)], "scenarios": out}


@app.post("/api/export")
def export(req: ModelRequest):
    co, sc, n, _ = req.projection()
    safe = re.sub(r"[^\w\- ]+", "", co["name"], flags=re.ASCII).strip() or "company"  # headers are latin-1
    return Response(model.to_excel(co, sc, n, req.active),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{safe} model.xlsx"'})


dist = Path(__file__).parent / "web" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
