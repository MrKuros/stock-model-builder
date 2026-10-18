"""Company data from the exchange by ticker, by rules (no AI): NSE's search, quote, results XBRL filings, annual reports
and call transcripts. A polite client: browser-like headers, a cookie from the home page first, at most one request a
second, small timeouts, an allow-list of hosts (redirects never leave it), size caps, and a local cache under the
library folder (models/_cache), so everything fetched once works offline."""
import contextlib
import csv
import hashlib
import http.client
import http.cookiejar
import io
import json
import math
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime
from pathlib import Path

NSE = "https://www.nseindia.com"
HOSTS = frozenset({"www.nseindia.com", "nsearchives.nseindia.com"})
SYMBOL = re.compile(r"[A-Z0-9&-]{1,20}")  # NSE symbols: TCS, M&M, BAJAJ-AUTO
QUERY = re.compile(r"[A-Za-z0-9&.\- ]{1,40}")
PRICE_AGE, LIST_AGE = 15 * 60, 6 * 3600  # seconds a cached quote / list stays fresh; a downloaded file never expires
MAX_JSON, MAX_XBRL, MAX_PDF = 8 << 20, 5 << 20, 60 << 20
GAP, TIMEOUT = 1.0, 20  # seconds between requests (one client per library, shared by every request); per request
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
HEADERS = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept-Encoding": "gzip, deflate"}
PAGE = {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none"}
API = {"Accept": "application/json, text/plain, */*", "Referer": NSE + "/"}


class Offline(Exception):
    """The site couldn't be reached or refused, and nothing usable is cached. The message is for the user."""


class NotFound(Offline):
    """The site answered 404: no such page or symbol. Trying again won't change it."""


def symbol(s):
    """An NSE symbol, strictly (A-Z, 0-9, & and -, at most 20), or ValueError: nothing else ever reaches a URL."""
    s = (s or "").strip().upper()
    if not SYMBOL.fullmatch(s):
        raise ValueError("An NSE symbol is letters, digits, & or - (like TCS, M&M or BAJAJ-AUTO).")
    return s


def allowed(url, hosts=HOSTS):
    u = urllib.parse.urlsplit(url or "")
    return u.scheme == "https" and u.hostname in hosts and u.port is None


class _Stay(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts):
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl, self.hosts):
            raise urllib.error.HTTPError(newurl, code, "redirect off the allow-list", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Client:
    """GETs from an allow-listed site through a cache folder. `home` is fetched once first for its cookies."""

    def __init__(self, cache: Path, hosts=HOSTS, home=NSE + "/", gap=GAP, name="NSE"):
        self.cache, self.hosts, self.home, self.gap, self.name = cache, hosts, home, gap, name
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
                                                  _Stay(hosts))
        # one request at a time per host, `gap` apart: a long report download from the archive host never holds up
        # a search or a price on the main site (a stopped download still runs to its end in its thread)
        self.locks = {h: threading.RLock() for h in hosts}
        self.last, self.warm = dict.fromkeys(hosts, 0.0), False

    def path(self, url):
        return self.cache / (hashlib.sha1(url.encode()).hexdigest()[:24] + ".bin")

    def get(self, url, max_age=LIST_AGE, limit=MAX_JSON, cached=False, check=None, stale=True):
        """(bytes, age in seconds): the cached copy while fresh (max_age None = forever), else the site's; when the site
        fails (or sends something `check` rejects, like a block page), a stale copy is better than nothing, unless
        stale=False (the caller must know the site really answered). Offline when there's neither. cached=True never
        goes online. Only what passes `check` is ever written to the cache."""
        if not allowed(url, self.hosts):
            raise Offline(f"Not fetched: {urllib.parse.urlsplit(url or '').hostname or url!r} isn't one of the sites this app reads.")
        p = self.path(url)
        age = time.time() - p.stat().st_mtime if p.is_file() else None
        if age is not None and (cached or max_age is None or age < max_age):
            return p.read_bytes(), age
        if cached:
            raise Offline("Not checked yet.")
        try:
            data = self.fetch(url, limit)
            if check and not check(data):
                raise Offline(f"{self.name} sent a page instead of data (it may be blocking automated requests). "
                              "Try again in a minute.")
        except Offline:
            if age is not None and stale:
                return p.read_bytes(), age
            raise
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
        return data, 0.0

    def json(self, url, max_age=LIST_AGE, cached=False, stale=True):
        data, age = self.get(url, max_age, cached=cached, check=_is_json, stale=stale)
        try:
            return json.loads(data), age
        except ValueError:
            self.path(url).unlink(missing_ok=True)  # a block page cached before pages were checked: never serve it again
            raise Offline(f"{self.name} sent a page instead of data (it may be blocking automated requests). "
                          "Try again in a minute.") from None

    def fetch(self, url, limit):
        host = urllib.parse.urlsplit(url).hostname
        if not self.warm:
            with self.locks.get(self._home_host(), threading.RLock()):
                if not self.warm:
                    self._cookies()
        with self.locks[host]:  # one request at a time per host, at least `gap` apart
            try:
                return self._raw(url, limit, API)
            except urllib.error.HTTPError as e:
                if e.code not in (401, 403) or not self.home:
                    raise (NotFound if e.code == 404 else Offline)(self._why(e)) from None
                with self.locks.get(self._home_host(), threading.RLock()):
                    self._cookies()  # an expired cookie: a fresh one, then once more
                try:
                    return self._raw(url, limit, API)
                except (OSError, http.client.HTTPException) as e2:
                    raise Offline(self._why(e2)) from None
            except (OSError, http.client.HTTPException) as e:  # URLError, timeouts, resets, a cut-off chunked body
                raise Offline(self._why(e)) from None

    def _home_host(self):
        return urllib.parse.urlsplit(self.home or "").hostname

    def _cookies(self):
        """The home page's cookies, as a browser would have them. NSE's home page often refuses clients that aren't
        browsers while its API still answers, so a refusal here is ignored."""
        self.warm = True
        if self.home:
            with contextlib.suppress(OSError, http.client.HTTPException, Offline):
                self._raw(self.home, 2 << 20, PAGE)

    def _why(self, e):
        """The failure in plain words (no socket error numbers)."""
        if isinstance(e, urllib.error.HTTPError):
            if e.code in (401, 403):
                return f"{self.name} refused the request; it sometimes blocks automated requests for a while. Try again in a few minutes."
            if e.code == 404:
                return f"{self.name} doesn’t have that page."
            return f"{self.name} had a problem answering (error {e.code}). Try again in a minute."
        if isinstance(e, TimeoutError) or "timed out" in str(getattr(e, "reason", e)):
            return f"{self.name} didn’t answer in time. Try again in a minute."
        if isinstance(e, http.client.HTTPException):
            return f"{self.name} cut the download short. Try again."
        return f"Couldn’t reach {self.name}. Check the internet connection."

    def _raw(self, url, limit, kind):
        host = urllib.parse.urlsplit(url).hostname
        wait = self.last.get(host, 0.0) + self.gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            with self.opener.open(urllib.request.Request(url, headers=HEADERS | kind), timeout=TIMEOUT) as r:
                if not allowed(r.geturl(), self.hosts):
                    raise Offline(f"{self.name} sent the request elsewhere; not followed.")
                data = r.read(limit + 1)
                enc = (r.headers.get("Content-Encoding") or "").lower()
                n = r.headers.get("Content-Length") or ""
        finally:
            self.last[host] = time.monotonic()
        if len(data) > limit:
            raise Offline(f"{url.rsplit('/', 1)[-1][:60]} is over {limit >> 20} MB, so it wasn't downloaded.")
        if n.isdigit() and int(n) != len(data):  # the connection closed early: never keep half a file
            raise Offline(f"{self.name} cut the download short. Try again.")
        if enc in ("gzip", "deflate"):
            d = zlib.decompressobj(zlib.MAX_WBITS | 32 if enc == "gzip" else zlib.MAX_WBITS)
            try:
                data = d.decompress(data, limit + 1)
            except zlib.error:
                raise Offline(f"{self.name} sent a damaged download; try again.") from None
            if len(data) > limit or d.unconsumed_tail:
                raise Offline(f"{url.rsplit('/', 1)[-1][:60]} is over {limit >> 20} MB, so it wasn't downloaded.")
            if not d.eof:
                raise Offline(f"{self.name} sent a damaged download; try again.")
        return data


def _is_json(data):
    try:
        json.loads(data)
        return True
    except ValueError:
        return False


# ---------- what the exchange publishes, as plain lists ----------

def _date(s, fmt="%d-%b-%Y"):
    try:
        return datetime.strptime((s or "").strip().title(), fmt)
    except ValueError:
        return None


def search(c, q):
    """[{symbol, name}] for a name or symbol, listed shares only (EQ and SME series)."""
    q = " ".join((q or "").split())
    if not QUERY.fullmatch(q):
        return []
    d, _ = c.json(f"{NSE}/api/NextApi/globalSearch/equity?symbol={urllib.parse.quote(q.lower())}", 24 * 3600)
    out = []
    for x in (d.get("data") if isinstance(d, dict) else None) or []:
        if isinstance(x, dict) and isinstance(x.get("symbol"), str) and SYMBOL.fullmatch(x["symbol"]):
            out.append({"symbol": x["symbol"], "name": str(x.get("companyName") or x["symbol"])[:120]})
    return out[:12]


SERIES = ("EQ", "BE", "SM", "ST")  # main board; trade-for-trade (new listings often start here); SME boards


def quote(c, sym, max_age=PRICE_AGE, cached=False):
    """{name, price (Rs), shares (crore), face_value, industry, sector, isin, listed, as_of, age} from NSE's quote,
    trying the series a share may trade in (NSE answers 404 for a series it doesn't trade in). cached=True: the last
    quote kept, however old, never online. NotFound when no series has it."""
    for series in SERIES:
        try:
            d, age = c.json(f"{NSE}/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N"
                            f"&series={series}&symbol={urllib.parse.quote(sym)}", max_age, cached)
        except Offline as e:
            if cached or isinstance(e, NotFound):
                continue
            raise
        try:
            e = d["equityResponse"][0]
            meta, trade, sec = e.get("metaData") or {}, e.get("tradeInfo") or {}, e.get("secInfo") or {}
        except (KeyError, IndexError, TypeError, AttributeError):
            continue
        if meta.get("companyName"):
            break
    else:
        raise NotFound(f"NSE has no company with the symbol {sym}. Check the spelling, or type its name.")
    num = lambda v: float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None  # noqa: E731
    price = num(trade.get("lastPrice")) or num(meta.get("closePrice")) or num(meta.get("previousClose"))
    issued, ffmc = num(trade.get("issuedSize")), num(trade.get("ffmc"))
    return {"name": str(meta["companyName"])[:200], "price": price, "shares": issued and issued / 1e7,
            "face_value": num(trade.get("faceValue")), "industry": sec.get("industryInfo") or sec.get("basicIndustry"),
            "basic_industry": sec.get("basicIndustry"), "sector": sec.get("sector"), "ffmc": ffmc and ffmc / 1e7,
            "isin": meta.get("isinCode"), "listed": sec.get("listingDate"),
            "series": series, "as_of": e.get("lastUpdateTime"), "age": age}


def filings(c, sym, fresh=False):
    """Results XBRL filings: [{end, kind (annual | quarter), consolidated, url, filed}], newest first, one per period
    and basis (the latest filed). Before 2025 from the results list (XBRL from 2018-19 on; earlier rows have none);
    from the March 2025 quarter on from the integrated filings (SEBI's combined format), whose March filing holds the
    year. fresh=True: Offline rather than an out-of-date list kept from before, when the caller asks "anything new?"."""
    out, stale = [], not fresh
    for period in ("Annual", "Quarterly"):
        d, _ = c.json(f"{NSE}/api/corporates-financial-results?index=equities&symbol={urllib.parse.quote(sym)}&period={period}",
                      stale=stale)
        for x in d if isinstance(d, list) else []:
            end = _date(x.get("toDate"))
            if end and allowed(x.get("xbrl")) and x["xbrl"].endswith(".xml"):
                out.append({"end": end, "kind": "annual" if x.get("period") == "Annual" else "quarter",
                            "consolidated": x.get("consolidated") == "Consolidated", "url": x["xbrl"],
                            "filed": _date(x.get("filingDate"), "%d-%b-%Y %H:%M") or end})
    d, _ = c.json(f"{NSE}/api/integrated-filing-results?index=equities&symbol={urllib.parse.quote(sym)}"
                  "&type=Integrated%20Filing-%20Financials", stale=stale)
    for x in (d.get("data") if isinstance(d, dict) else None) or []:
        end = _date(x.get("qe_Date"))
        if end and allowed(x.get("xbrl")) and x["xbrl"].endswith(".xml"):
            out.append({"end": end, "kind": "annual" if end.month == 3 else "quarter",
                        "consolidated": x.get("consolidated") == "Consolidated", "url": x["xbrl"],
                        "filed": _date(x.get("broadcast_Date"), "%d-%b-%Y %H:%M:%S") or end})
    best = {}
    for f in out:  # the Q4 row of the quarterly list is the annual filing again: the annual kind wins
        k = (f["end"], f["consolidated"])
        b = best.get(k)
        if b is None or (f["kind"] == "annual", f["filed"]) > (b["kind"] == "annual", b["filed"]):
            best[k] = f
    return sorted(best.values(), key=lambda f: (f["end"], f["consolidated"]), reverse=True)


def annual_reports(c, sym):
    """[{year (FY2026), url, pdf}], newest first. Older ones are zips (pdf False), which this app doesn't open."""
    d, _ = c.json(f"{NSE}/api/annual-reports?index=equities&symbol={urllib.parse.quote(sym)}")
    out = []
    for x in (d.get("data") if isinstance(d, dict) else None) or []:
        y, url = str(x.get("toYr") or ""), x.get("fileName")
        if re.fullmatch(r"\d{4}", y) and allowed(url):
            out.append({"year": f"FY{y}", "url": url, "pdf": url.lower().endswith(".pdf")})
    return sorted(out, key=lambda x: x["year"], reverse=True)


DOCS = (("transcript", "transcript"), ("presentation", "presentation"))


def documents(c, sym, today=None):
    """Call transcripts and investor presentations filed in the last two years: [{date, kind, title, url}], newest
    first. By rules: an analyst / con. call announcement whose text names a transcript or a presentation."""
    today = today or datetime.now()
    since = today.replace(year=today.year - 2)
    d, _ = c.json(f"{NSE}/api/corporate-announcements?index=equities&symbol={urllib.parse.quote(sym)}"
                  f"&from_date={since:%d-%m-%Y}&to_date={today:%d-%m-%Y}")
    out = []
    for x in d if isinstance(d, list) else []:
        text = f"{x.get('desc') or ''} {x.get('attchmntText') or ''}".lower()
        kind = next((k for word, k in DOCS if word in text), None)
        when = _date(x.get("an_dt"), "%d-%b-%Y %H:%M:%S") or _date(x.get("an_dt"))
        url = x.get("attchmntFile")
        if kind and when and allowed(url) and url.lower().endswith(".pdf"):
            out.append({"date": when, "kind": kind, "title": str(x.get("attchmntText") or x.get("desc") or "")[:200],
                        "url": url})
    return sorted(out, key=lambda x: x["date"], reverse=True)


def fy_of(d):
    """The Indian financial year a date falls in: 14 Oct 2026 -> FY2027."""
    return f"FY{d.year + 1 if d.month > 3 else d.year}"


# ---------- peers (5.2): companies in the same NSE sector, close in size, by rules ----------

SECTOR_LIST = "https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv"
SIZE_LIST = NSE + "/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20TOTAL%20MKT"
BAND = 10  # a candidate's market cap within 1/10x to 10x of the company's comes first
CANDIDATES = 15  # candidates listed, the same industry first, then the closest in size
QUOTED = 30  # same-sector companies within BAND quoted for their industry (one a second), the closest in size first
INDUSTRY_AGE = 7 * 24 * 3600  # a quote kept this long is good enough for an industry and a size


def universe(c):
    """{symbol: {symbol, name, sector, ffmc (free-float market cap, Rs crore, or None)}} for the Nifty Total Market
    index: about 750 companies (the Nifty 500 and the Microcap 250), sector from NSE's own classification.
    ponytail: smaller companies aren't in it, so they are added by hand on the peers list."""
    head = lambda b: b.decode("utf-8-sig", "replace").startswith("Company Name,Industry,Symbol")  # noqa: E731
    raw, _ = c.get(SECTOR_LIST, 24 * 3600, check=head)
    text = raw.decode("utf-8-sig", "replace")
    if not head(raw):  # a block page cached before pages were checked
        c.path(SECTOR_LIST).unlink(missing_ok=True)  # a block page cached as data: never serve it again
        raise Offline("NSE sent a page instead of its list of companies. Try again in a minute.")
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        sym = (r.get("Symbol") or "").strip()
        if SYMBOL.fullmatch(sym):
            out[sym] = {"symbol": sym, "name": (r.get("Company Name") or sym).strip()[:120],
                        "sector": (r.get("Industry") or "").strip(), "ffmc": None}
    d, _ = c.json(SIZE_LIST)
    for x in ((d.get("data") if isinstance(d, dict) else None) or {}).get("data") or []:
        v = x.get("ffmc") if isinstance(x, dict) else None
        if x.get("symbol") in out and isinstance(v, (int, float)) and v > 0:
            out[x["symbol"]]["ffmc"] = v / 1e7
    return out


def candidates(c, sym, q):
    """Peer candidates for `sym` (q = its quote), by rules: the same NSE sector, the closest in free-float market cap
    (within BAND either way first), each quoted for its industry, then same basic industry first, same industry next.
    Yields {"step"} / {"detail"} as it goes, a {"note"} when none shares its industry, then {"candidates": [{symbol,
    name, sector, industry, basic_industry, price, shares, mcap, size, why}]}. Every same-sector company within BAND
    is quoted (up to QUOTED), so a small same-industry one isn't cut before its industry is known.
    ponytail: the sector is the ceiling: a coal miner's real peers in Metals & Mining are never candidates; the note
    says to add them by hand."""
    total = q["price"] * q["shares"] if q.get("price") and q.get("shares") else None
    sector, own = q.get("sector"), q.get("ffmc") or total  # NSE's index list gives free-float caps only: the first cut
    if not sector:
        yield {"candidates": []}
        return
    yield {"step": f"Reading NSE’s list of {sector} companies…"}
    same = [x for s, x in universe(c).items() if x["sector"] == sector and s != sym and x["ffmc"]]
    gap = (lambda x: abs(math.log(x["ffmc"] / own))) if own else (lambda x: -x["ffmc"])
    out_band = (lambda x: gap(x) > math.log(BAND)) if own else (lambda x: False)  # noqa: E731
    same.sort(key=lambda x: (out_band(x), gap(x)))
    near = [x for x in same if not out_band(x)][:QUOTED]
    ask = near + [x for x in same if out_band(x)][:max(0, CANDIDATES - len(near))]
    out = []
    if ask:
        yield {"step": f"Checking {len(ask)} {sector} companies close in size for their industry…"}
    for i, x in enumerate(ask):
        yield {"detail": f"{x['name']} ({i + 1} of {len(ask)})"}
        try:
            p = quote(c, x["symbol"], INDUSTRY_AGE)  # industry and size; a week-old quote is fine for choosing
        except Offline:
            continue  # no quote: data not fetchable, so not a candidate
        mcap = p["price"] * p["shares"] if p["price"] and p["shares"] else None
        size = mcap / total if mcap and total else None  # what the page shows: full market caps
        tier = 0 if p["basic_industry"] and p["basic_industry"] == q.get("basic_industry") else \
            1 if p["industry"] and p["industry"] == q.get("industry") else 2
        why = (f"Same industry ({p['basic_industry']})" if tier == 0 else f"Same industry group ({p['industry']})"
               if tier == 1 else f"Same sector ({sector}), industry {p['basic_industry'] or p['industry'] or 'not given'}")
        out.append({"symbol": x["symbol"], "name": p["name"], "sector": sector, "industry": p["industry"],
                    "basic_industry": p["basic_industry"], "price": p["price"], "shares": p["shares"],
                    "mcap": mcap, "size": size,
                    "why": why + (f" · {size:.1f}x its size" if size and size >= 1 else f" · {size:.2f}x its size"
                                  if size else ""), "_tier": tier, "_gap": abs(math.log(size)) if size else gap(x)})
    out.sort(key=lambda x: (x["_tier"], x["_gap"]))
    if out and out[0]["_tier"] > 1:
        what = q.get("basic_industry") or q.get("industry")
        yield {"note": f"No other {sector} company on NSE’s list shares {q.get('name') or sym}’s industry"
                       f"{f' ({what})' if what else ''}, so these are the same sector only. Add its real peers yourself below."}
    yield {"candidates": [{k: v for k, v in x.items() if not k.startswith("_")} for x in out[:CANDIDATES]]}
