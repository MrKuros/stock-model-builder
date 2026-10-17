"""Reading and judging with a language model, provider-neutral and with no SDK: the shell command in LLM_CMD gets
the prompt on stdin and prints the reply on stdout. model.py never imports this module. Nothing returned here
becomes a number by itself: callers turn it into a proposal that rules check and the user approves."""
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import unicodedata
from datetime import date

from model import _cr  # Rs crore with Indian grouping (ai may use model; model never imports ai)

TIMEOUT = 180  # seconds per call
NOT_SET = "Set LLM_CMD to a command that reads a prompt on stdin and prints the reply, then restart."


class LLMError(Exception):
    """The command is missing, failed, timed out, or twice gave no usable JSON. The message is for the user."""


def available():
    return bool(os.environ.get("LLM_CMD", "").strip())


def llm(prompt: str) -> str:
    """One call: run LLM_CMD with the prompt on stdin, return its stdout."""
    cmd = os.environ.get("LLM_CMD", "").strip()
    if not cmd:
        raise LLMError(NOT_SET)
    try:
        # ponytail: run in a fresh empty folder, so an agent-like command never starts beside the repo or models/;
        # it doesn't stop absolute paths, so the command itself should have no tools (see the handoff notes)
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run(shlex.split(cmd), input=prompt, capture_output=True, text=True, timeout=TIMEOUT, cwd=d)
    except subprocess.TimeoutExpired:
        raise LLMError(f"LLM_CMD gave no reply within {TIMEOUT} seconds.") from None
    except (OSError, ValueError) as e:  # not found, not executable, unbalanced quotes
        raise LLMError(f"Couldn't run LLM_CMD ({e}).") from None
    if r.returncode:
        raise LLMError(f"LLM_CMD exited with code {r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")
    return r.stdout


def first_json(text):
    """The first JSON object or array in a reply (models wrap JSON in prose or code fences); ValueError if none."""
    dec = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch in "[{":
            try:
                return dec.raw_decode(text, i)[0]
            except (ValueError, RecursionError):  # RecursionError: thousands of nested brackets
                continue
    raise ValueError("no JSON object or array in the reply")


def ask_json(prompt, shape):
    """Ask for JSON only. `shape(value)` returns None when the value is usable, else what's wrong with it. A bad reply
    is retried once with the problem named; a second bad one raises LLMError."""
    ask = prompt + "\n\nReply with the JSON only, no other text."
    why = None
    for _ in range(2):
        reply = llm(ask if why is None else f"{ask}\n\nYour previous reply was not usable: {why}. Try again.")
        try:
            v = first_json(reply)
            why = shape(v)
        except ValueError as e:
            why = str(e)
        if why is None:
            return v
    raise LLMError(f"The model's reply wasn't usable JSON twice ({why}). Try again, or use another LLM_CMD.")


def _mapping_shape(v):
    if not isinstance(v, list):
        return "expected a JSON array"
    for x in v:
        if not (isinstance(x, dict) and isinstance(x.get("tag"), str) and isinstance(x.get("reasoning", ""), str)
                and (x.get("std_key") is None or isinstance(x["std_key"], str))):
            return 'each item must be {"tag": string, "std_key": string or null, "reasoning": string}'
    return None


def propose_mappings(unmapped, keys, filing):
    """[{tag, std_key | None, reasoning}] for a filing's unmapped facts, given the std keys {key: meaning}."""
    lines = "\n".join(f"- {u['tag']} = {u['value']} {u.get('unit') or ''} (context {u['context']})" for u in unmapped)
    known = "\n".join(f"- {k}: {m}" for k, m in keys.items())
    prompt = (
        "You map XBRL facts from an Indian listed company's financial results filing (Ind AS, NSE/BSE results "
        f"taxonomy) to a fixed list of statement lines. The filing is a {filing.get('kind')} to "
        f"{filing.get('period_end')}; amounts are in Rs crore.\n\n"
        f"These facts were not recognised:\n{lines}\n\nThe statement lines (std_key: meaning):\n{known}\n\n"
        f"Lines the filing already reports under their standard tags: {', '.join(filing.get('facts', {})) or 'none'}.\n\n"
        "For each fact, give the std_key it is the same line as, or null when it is a breakdown, a segment, a "
        "subtotal of something else, a ratio, or not one of these lines. Never map a fact to a line the filing "
        "already reports under its standard tag. Give one short sentence of reasoning.\n"
        'Answer as a JSON array: [{"tag": "...", "std_key": "..." or null, "reasoning": "..."}].')
    return ask_json(prompt, _mapping_shape)


# ---------- annual-report PDFs: page text by rules (system pdftotext), shared by one-off notes and later AR notes ----------

PDF_MISSING = "Reading PDFs needs pdftotext (poppler-utils). Install it, then restart."
PDF_TIMEOUT = 120  # seconds per pdftotext run; a 350-page report takes ~2 s


def pdf_available():
    return shutil.which("pdftotext") is not None


def pdf_pages(data: bytes):
    """[(reading-order text, layout text)] per page, from the system pdftotext. Reading order keeps a sentence in
    one piece on multi-column pages (sent to the model); -layout keeps table rows together (quotes are checked
    against both). ValueError with a message for the user when it isn't a readable, text-bearing PDF."""
    if not data.startswith(b"%PDF-"):
        raise ValueError("That isn't a PDF. Attach the annual report as a .pdf file.")
    if not pdf_available():
        raise ValueError(PDF_MISSING)
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "report.pdf")
        with open(src, "wb") as f:
            f.write(data)
        out = []
        for flags in ([], ["-layout"]):
            try:
                r = subprocess.run(["pdftotext", "-q", "-enc", "UTF-8", *flags, src, "-"], capture_output=True,
                                   timeout=PDF_TIMEOUT)
            except subprocess.TimeoutExpired:
                raise ValueError(f"pdftotext took over {PDF_TIMEOUT} seconds on that PDF.") from None
            if r.returncode:
                raise ValueError("pdftotext couldn't read that PDF (damaged or password-protected?).")
            pages = r.stdout.decode("utf-8", "replace").split("\f")
            out.append(pages[:-1] if pages and not pages[-1].strip() else pages)  # a form feed ends every page
    raw, lay = out
    if len(raw) != len(lay) or not any(p.strip() for p in raw):
        raise ValueError("No text could be read from that PDF (a scanned report?). Explain from the numbers instead.")
    return list(zip(raw, lay))


_PUNCT = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
                        "−": "-", "­": None, " ": " "})


def norm(s):
    """Case, whitespace, curly quotes, dashes and ligatures (NFKC) don't count when matching a quote."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s).translate(_PUNCT)).strip().lower()


def year_re(end: date):
    """How an Indian annual report writes the financial year ending `end` (31 Mar 2020): 2019-20, FY 2020, FY20,
    March 31, 2020, 31st March, 2020. Matched against norm() text."""
    y, m, d = end.year, end.strftime("%B").lower(), end.day
    return re.compile(rf"\b{y - 1}\s?-\s?(?:{y % 100:02d}|{y})\b|\bfy\s?'?(?:{y}|{y % 100:02d})\b"
                      rf"|\b{d}(?:st|nd|rd|th)?\s{m},?\s{y}\b|\b{m}\s{d}(?:st|nd|rd|th)?,?\s{y}\b")


# words that point at the page explaining each one-off metric (model.ONEOFF keys); "exceptional" counts for all
ONEOFF_WORDS = {"oi_pct": ("other income", "fair value", "impairment", "write-off", "write off", "profit on sale"),
                "tax_rate": ("tax expense", "deferred tax", "effective tax", "tax rate", "minimum alternate tax",
                             "tax credit", "tax holiday"),
                "capex_pct": ("purchase of property, plant", "capital expenditure", "capex", "acquisition",
                              "right-of-use", "amalgamation", "merger", "business combination"),
                "ebitda_margin": ("margin", "impairment", "provision", "write-off", "write off", "one-off")}
COMMON_WORDS = (("exceptional", 3), ("one-time", 3), ("one time", 3), ("one-off", 3), ("non-recurring", 3))
# ponytail: a one-off explanation quotes a sentence (5 words at least); a note item quotes a table row, which can be
# as short as "Bank guarantees 1,234" and must also contain its amount, so 3 words is enough there
MIN_QUOTE_WORDS, MIN_NOTE_WORDS = 5, 3
MAX_PAGES, MAX_PAGE_CHARS = 4, 8000  # ponytail: the 4 best-scoring pages, cut to 8k characters each (~10k tokens)


def pick_pages(pages, metrics, end: date):
    """Rules choose what the model reads: page numbers (1-based) of up to 4 pages that mention exceptional /
    one-time items or the flagged line and the year, best first. A page needs a word hit, not just the year."""
    words = [*COMMON_WORDS, *((w, 2) for k in metrics for w in ONEOFF_WORDS.get(k, ()))]
    yr, scored = year_re(end), []
    for i, (raw, _) in enumerate(pages):
        t = norm(raw)
        hits = sum(min(t.count(w), 5) * wt for w, wt in words)
        if hits:
            scored.append((hits + min(len(yr.findall(t)), 5), -i))
    return [-i + 1 for _, i in sorted(scored, reverse=True)[:MAX_PAGES]]


def mentions_year(pages, end: date):
    """Pages that name the financial year: a report for that year names it on many pages."""
    yr = year_re(end)
    return sum(1 for raw, _ in pages if yr.search(norm(raw)))


def year_counts(pages, end: date):
    """{-1, 0, 1: pages naming the year before, the year, the year after}: a report names its own year most."""
    shift = lambda k: end.replace(year=end.year + k, day=28 if (end.month, end.day) == (2, 29) else end.day)  # noqa: E731
    return {k: mentions_year(pages, shift(k)) for k in (-1, 0, 1)}


def year_check(pages, end: date):
    """Rule: the report is for the year: at least 3 pages name it, and more than name either neighbouring year (the
    FY2021 report names FY2020 on a third of its pages, as comparatives)."""
    n = year_counts(pages, end)
    ok = n[0] >= 3 and n[0] > max(n[-1], n[1])
    k = max((-1, 1), key=lambda k: n[k])
    other = end.replace(year=end.year + k, day=28 if (end.month, end.day) == (2, 29) else end.day)
    detail = f"{n[0]} pages name the year" + (f", {n[k]} the year to {other:%d %b %Y}." if n[k] else ".")
    if not ok:
        detail += (f" Is this the report for the year to {other:%d %b %Y}?" if n[k] >= n[0] and n[k]
                   else " Is this the right year's report?")
    return {"name": "Report for the year", "pass": ok, "detail": detail}


def on_page(quote, texts):
    """The quote occurs in one of a page's texts (normalised), starting and ending on word / number boundaries: a
    quote cut inside a number ("(21,23" of "(21,234.56)", "Rs 5" of "Rs 500") isn't on the page."""
    q = norm(quote or "")
    pat = re.compile(r"(?<![\w.,])" + re.escape(q) + r"(?![\w]|[.,]\d)")
    return bool(q) and any(pat.search(norm(t)) for t in texts)


def sentences(s):
    # ponytail: a full stop followed by a capital starts a sentence; "Ltd. The" counts two, fine for a limit
    return len(re.findall(r"[.!?](?=\s+[A-Z(\"']|\s*$)", s.strip())) or 1


def _note_shape(cited):
    def shape(v):
        if not isinstance(v, dict) or not isinstance(v.get("summary"), str) or not v["summary"].strip():
            return 'expected {"summary": string' + (', "page": number, "quote": string}' if cited else "}")
        if sentences(v["summary"]) > 2 or len(v["summary"]) > 700:
            return "the summary must be at most two sentences"
        if cited and not (isinstance(v.get("page"), int) and isinstance(v.get("quote"), str) and v["quote"].strip()):
            return '"page" must be a page number and "quote" the exact text copied from that page'
        return None
    return shape


def explain_oneoff(year, flags, numbers, pages=None):
    """Words only: why `year` was unusual. With `pages` [(page number, text)] from the annual report the reply is
    {summary, page, quote}, the quote copied from that page; without, {summary} from the numbers alone."""
    what = "\n".join(f"- {f['note']}" for f in flags)
    prompt = (f"An Indian listed company's {year} stood out from its own history:\n{what}\n\n"
              f"Its reported figures (Rs crore):\n{numbers}\n\n")
    if pages:
        text = "\n\n".join(f"=== PAGE {n} ===\n{t[:MAX_PAGE_CHARS]}" for n, t in pages)
        prompt += (f"Pages from its annual report (only these were read):\n{text}\n\n"
                   "Using only these pages, say in at most two sentences (under 80 words) what made the year unusual (an exceptional "
                   "item, an acquisition, a tax change...). Give the page number it is on and a quote of 5 to 40 "
                   "words copied character for character from that page as evidence. If the pages don't explain it, "
                   "say so in the summary and quote the closest relevant sentence.\n"
                   'Answer as a JSON object: {"summary": "...", "page": number, "quote": "..."}.')
    else:
        prompt += ("No filing was read. From these numbers alone, say in at most two sentences (under 80 words) what most likely made "
                   "the year unusual, and say it is a reading of the numbers, not a reported fact.\n"
                   'Answer as a JSON object: {"summary": "..."}.')
    return ask_json(prompt, _note_shape(bool(pages)))


def quote_checks(reply, pages, sent, end: date):
    """Rules on a cited explanation: the page was one the model was given, the quote is on it (normalised), long
    enough to mean something, and the report is for that year. [{name, pass, detail}]."""
    page, quote = reply.get("page"), norm(reply.get("quote") or "")
    on = isinstance(page, int) and 1 <= page <= len(pages) and on_page(quote, pages[page - 1])
    return [
        {"name": "Page was read", "pass": page in sent,
         "detail": f"Page {page} was among the pages sent ({', '.join(map(str, sent))})." if page in sent
         else f"Page {page} wasn't among the pages sent ({', '.join(map(str, sent))})."},
        {"name": "Quote is on the page", "pass": on,
         "detail": f"The quote occurs on page {page}." if on
         else f"The quote doesn't occur on page {page}, so the explanation is rejected."},
        {"name": "Quote long enough", "pass": len(quote.split()) >= MIN_QUOTE_WORDS,
         "detail": f"{len(quote.split())} words (at least {MIN_QUOTE_WORDS})."},
        year_check(pages, end),
    ]


# ---------- annual-report notes (3.3): rules pick the pages per topic, the LLM extracts, rules check every value ----------

# topic: (title, what to extract, words that point at its page (word, weight); a page needs a word of weight >= 3)
TOPICS = {
    "segments": ("Segment revenue", "the revenue from operations of each reportable business segment for the year "
                 "(external revenue; not geographies, not segment results, not the total)",
                 (("segment information", 4), ("operating segment", 3), ("reportable segment", 3),
                  ("segment revenue", 3), ("segment result", 3), ("revenue from operations", 1))),
    "maturity": ("Debt maturity", "the borrowings (and lease liabilities, if the table includes them) falling due in "
                 "each period as at the year end, one item per period (within 1 year, 1-5 years, after 5 years...)",
                 (("contractual maturities", 4), ("maturity profile", 4), ("maturity analysis", 4),
                  ("liquidity risk", 3), ("repayment", 1), ("borrowings", 1), ("lease liabilities", 1))),
    "capex": ("Capex", "from the cash flow statement for the year: purchase of property, plant and equipment "
              "(including capital work in progress) and, if shown on its own line, purchase of intangible assets",
              (("purchase of property, plant", 4), ("acquisition of property, plant", 4),
               ("cash flows from investing activities", 3), ("cash flow from investing activities", 3),
               ("purchase of intangible", 2))),
    "contingent": ("Contingent liabilities", "each contingent liability as at the year end (claims not acknowledged "
                   "as debt, tax demands, guarantees...), not commitments",
                   (("contingent liabilities", 4), ("acknowledged as debt", 4), ("commitments and contingencies", 4),
                    ("contingent liability", 3), ("contingencies", 3), ("guarantees", 1))),
    "related": ("Related-party transactions", "the largest related-party transactions of the year, at most 8: label "
                "each with the party (or group of parties) and the nature, e.g. 'Holding company: dividend paid'",
                (("related party", 3), ("related parties", 3), ("key management personnel", 2),
                 ("transactions with", 1))),
    # 4.3 forensic radar: a share, not money, and words with quotes
    "pledge": ("Promoter pledge", "the share of the promoter and promoter group's shares pledged or otherwise "
               "encumbered at the year end, as a percentage of their own holding: one item (if only a percentage of "
               "total share capital is printed, use it and say so in the label; if the report says no shares are "
               "pledged, give 0 and quote that sentence)",
               (("pledged", 4), ("encumbered", 4), ("promoter group", 3), ("shareholding pattern", 2), ("promoter", 1))),
    "auditor": ("Auditor's report", "from the independent auditor's report on the consolidated financial statements: "
                "the audit firm, the kind of opinion and whether the auditor changed this year",
                (("independent auditor", 4), ("basis for opinion", 4), ("qualified opinion", 4), ("true and fair view", 3),
                 ("statutory auditor", 3), ("firm's registration", 3), ("firm registration", 3), ("chartered accountants", 2),
                 ("key audit matters", 2), ("auditor", 1))),
}
TOPIC_PAGES = 3  # ponytail: the 3 best pages per topic, cut to 8k characters; a missed note means attach + read again
UNITS = {"crore": 1.0, "lakh": 0.01, "million": 0.1, "billion": 100.0, "thousand": 1e-4, "rupees": 1e-7}
# unit words as whole words on norm() text ("cr" must not match "credit", "lac" not "place")
UNIT_RE = {u: re.compile(p) for u, p in {
    "crore": r"\b(?:crores?|cr)\b", "lakh": r"\b(?:lakhs?|lacs?)\b", "million": r"\b(?:millions?|mn)\b",
    "billion": r"\b(?:billions?|bn)\b", "thousand": r"\bthousands?\b|'000\b|\b000s\b"}.items()}
# a table heading that names the unit: "(Rs in lakh)", "(All amounts in ₹ crore)", "Amounts in INR million"; some
# PDFs print the rupee sign as a backtick ("(` crore)", TCS)
UNIT_HEAD = re.compile(r"(?:\brs\.?|₹|`|\binr\b|\brupees\b|\bamounts?\s+(?:are\s+)?in)\s*(?:in\s*)?(?:rs\.?\s*|₹\s*|inr\s*)?"
                       r"(crores?|cr|lakhs?|lacs?|millions?|mn|billions?|bn|thousands?|'000)\b")
HEAD_UNIT = {"cr": "crore", "la": "lakh", "mi": "million", "mn": "million", "bi": "billion", "bn": "billion",
             "th": "thousand", "'0": "thousand"}
TIE = {"segments": 0.02, "maturity": 0.05, "capex": 0.02}  # sums agree with the statements within these


def pick_topic_pages(pages, topic, end: date):
    """Page numbers (1-based) of up to 3 pages for the topic, best first: word hits, then the consolidated notes
    (Screener's figures are consolidated) and the year. A page needs a strong word, not just the year."""
    words, yr, scored = TOPICS[topic][2], year_re(end), []
    for i, (raw, _) in enumerate(pages):
        t = norm(raw)
        if not any(w in t for w, wt in words if wt >= 3):
            continue
        hits = sum(min(t.count(w), 5) * wt for w, wt in words)
        group = 3 * ("consolidated" in t) - 3 * ("standalone financial statements" in t or "standalone statement" in t)
        scored.append((hits + group + min(len(yr.findall(t)), 3), -i))
    best = [-i + 1 for _, i in sorted(scored, reverse=True)]
    if topic == "auditor":  # the opinion and the firm sit on different pages: keep a slot for the signature page
        sign = [n for n in best if re.search(r"firm'?s? registration", norm(pages[n - 1][0]))][:1]
        return [*[n for n in best if n not in sign][:TOPIC_PAGES - len(sign)], *sign]
    return best[:TOPIC_PAGES]


PROSE_TOPICS = {"auditor"}  # read in reading order: -layout interleaves a two-column auditor's report mid-sentence


def page_text(page, topic=None):
    """What the model reads of a page: the -layout text (table rows stay on one line), runs of spaces cut to two; a
    prose topic gets the reading-order text instead."""
    return re.sub(r"[ \t]{3,}", "  ", page[0 if topic in PROSE_TOPICS else 1])[:MAX_PAGE_CHARS]


def note_prompt(topic, year, end: date, pages):
    """The prompt for one topic, `pages` [(page number, text)]. Also used, without a call, to show its size."""
    title, what, _ = TOPICS[topic]
    text = "\n\n".join(f"=== PAGE {n} ===\n{t}" for n, t in pages)
    if topic == "auditor":
        return (f"Pages from an Indian listed company's annual report for {year} (the year to {end:%d %B %Y}); only "
                f"these were read:\n{text}\n\n"
                "From the independent auditor's report on the consolidated financial statements (the standalone one if "
                "there is no consolidated one), give: the audit firm's name as printed; the opinion, one of "
                '"unmodified" (a clean true-and-fair opinion), "qualified", "adverse" or "disclaimer"; and whether the '
                "pages say the auditor changed this year (appointed for the first time, resigned or rotated in): true or "
                "false. Back each with a quote copied character for character from its page (3 to 40 words): an item "
                'labelled "Opinion" (the words that state the opinion: "give a true and fair view" for a clean one, the '
                'qualification, adverse or disclaimer words otherwise), one labelled "Auditor" (where the firm is named) and, if it '
                'changed, one labelled "Change". If the pages don\'t show the auditor\'s report, answer {"found": false}.\n'
                'Answer as a JSON object: {"found": true, "auditor": "...", "opinion": "unmodified", "changed": false, '
                '"items": [{"label": "Opinion", "page": 12, "quote": "..."}]}.')
    return (f"Pages from an Indian listed company's annual report for {year} (the year to {end:%d %B %Y}); only "
            f"these were read:\n{text}\n\n"
            f"Extract {what}. Use the consolidated figures when the report has both, and the column for the year to "
            f"{end:%d %B %Y}, not the previous year. For every item give the amount exactly as printed (a number, "
            "in the report's unit), the page number it is on, and a quote copied character for character from that "
            "page that contains the amount (the table row or sentence, 3 to 40 words). "
            + ('The amount is a percentage (12.5 for 12.5%); give the unit "percent". ' if topic == "pledge" else
               'Give the unit the amounts are in: "crore", "lakh", "million", "billion", "thousand" or "rupees". ')
            + "Never convert, add up or estimate; "
            'if the pages don\'t show it, answer {"found": false}.\n'
            'Answer as a JSON object: {"found": true, "unit": "crore", "items": [{"label": "...", "amount": 123.4, '
            '"page": 12, "quote": "..."}]}.')


OPINIONS = ("unmodified", "qualified", "adverse", "disclaimer")


def note_shape(v, topic=None):
    if not isinstance(v, dict) or not isinstance(v.get("found", True), bool):
        return 'expected {"found": true, ...} or {"found": false}'
    if v.get("found") is False:
        return None
    items = v.get("items")
    if not isinstance(items, list) or not items or len(items) > 20:
        return '"items" must be a list of 1 to 20 items'
    if topic == "auditor":
        # ponytail: Indian reports say "unqualified"; a missing "changed" is no claim of a change (checked as a note)
        if isinstance(v.get("opinion"), str):
            v["opinion"] = {"unqualified": "unmodified", "clean": "unmodified"}.get(v["opinion"].strip().lower(), v["opinion"].strip().lower())
        if v.get("changed") is None:
            v["changed"] = False
        if not (isinstance(v.get("auditor"), str) and v["auditor"].strip() and v.get("opinion") in OPINIONS
                and isinstance(v.get("changed"), bool)):
            return f'"auditor" must be the firm, "opinion" one of {", ".join(OPINIONS)}, "changed" true or false'
        if not all(isinstance(x, dict) and isinstance(x.get("label"), str) and isinstance(x.get("page"), int)
                   and isinstance(x.get("quote"), str) for x in items):
            return 'each item must be {"label": string, "page": number, "quote": string}'
        return None
    if v.get("unit") not in (("percent",) if topic == "pledge" else UNITS):
        return '"unit" must be "percent"' if topic == "pledge" else f'"unit" must be one of {", ".join(UNITS)}'
    for x in items:
        if not (isinstance(x, dict) and isinstance(x.get("label"), str) and isinstance(x.get("page"), int)
                and isinstance(x.get("quote"), str) and isinstance(x.get("amount"), (int, float, str))):
            return 'each item must be {"label": string, "amount": number, "page": number, "quote": string}'
    return None


def extract_note(topic, year, end: date, pages):
    """{found, unit, items: [{label, amount, page, quote}]} for the topic from `pages` [(page number, text)]; the
    auditor topic answers {found, auditor, opinion, changed, items: [{label, page, quote}]}."""
    return ask_json(note_prompt(topic, year, end, pages), lambda v: note_shape(v, topic))


def amount(v):
    """A printed amount as a float: 1,64,177 / (34) / -34 / 2,719.50; None when it doesn't parse."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if abs(v) < 1e15 else None
    s = str(v).strip().replace(",", "").replace(" ", "")
    neg = s.startswith("(") and s.endswith(")")
    try:
        x = float(s.strip("()"))
    except ValueError:
        return None
    return (-x if neg else x) if abs(x) < 1e15 else None  # also None for "inf", "1e999" and "nan"


def in_quote(x, quote):
    """The amount, as printed, occurs in the quote (Indian or Western grouping, brackets for negatives)."""
    nums = [amount(n) for n in re.findall(r"\d[\d,]*(?:\.\d+)?", quote)]
    return any(n is not None and abs(n - abs(x)) <= 0.005 + 1e-9 * abs(x) for n in nums)


NUM = re.compile(r"\(?-?\d[\d,]*(?:\.\d+)?\)?")


def row_of(quote, layout):
    """A quote that starts with a number may start mid-row, after the current year's column: it gets the amounts
    printed just before it on its -layout line, up to the row's label (a word). A quote that starts with its label
    is the row (before it may be the other column of a two-column page)."""
    t = "\n".join(norm(line) for line in layout.split("\n"))
    m = re.search("[ \n]".join(map(re.escape, norm(quote).split())), t) if norm(quote) else None
    if not m or not re.match(r"[\d(\-]", m.group()):
        return m.group() if m else norm(quote)
    before = t[t.rfind("\n", 0, m.start()) + 1:m.start()]
    return re.search(r"[\d(),.\- ]*$", before).group() + m.group()


def first_amount(row, v):
    """The first amount printed in a table row: bracketed, with a thousands comma, or 3+ digits, so note numbers
    (5, 12, 4.1) and years are skipped; a number equal to `v` counts too. None when there is none."""
    for s in NUM.findall(row):
        n = amount(s)
        if n is None or re.fullmatch(r"(?:19|20)\d\d", s):
            continue
        if "(" in s or "," in s or len(s.lstrip("(-").split(".")[0]) >= 3 or abs(abs(n) - abs(v)) <= 0.005 + 1e-9 * abs(v):
            return n
    return None


def note_checks(topic, reply, pages, sent, end: date, against=None):
    """Rules on an extracted note: every item's page was sent, its quote is on that page, its amount parses and is in
    its quote, the unit is printed on a cited page, the report is for the year, and the sum ties to one of `against`
    [(label, Rs crore)] where the topic has a tie (TIE). Returns (rows in Rs crore, total, checks)."""
    if topic == "auditor":
        return auditor_checks(reply, pages, sent, end)
    unit, items = reply["unit"], reply["items"]
    rows, bad_page, bad_quote, short, bad_num, bad_col, col_known = [], [], [], [], [], [], 0
    for x in items:
        page, quote, v = x["page"], norm(x["quote"]), amount(x["amount"])
        valid = 1 <= page <= len(pages)
        if page not in sent:
            bad_page.append(x["label"])
        if not (valid and on_page(quote, pages[page - 1])):
            bad_quote.append(x["label"])
        elif len(quote.split()) < MIN_NOTE_WORDS:
            short.append(x["label"])
        # a pledge of 0 is quoted as words ("no shares are pledged"), not as a number
        nil = topic == "pledge" and v == 0 and re.search(r"\b(?:nil|none|no|not)\b", quote)
        if v is None or not (nil or in_quote(v, x["quote"])) or (topic == "pledge" and not 0 <= v <= 100):
            bad_num.append(x["label"])
        elif topic == "capex":
            # ponytail: Ind AS statements print the current year's column first; a layout that doesn't would fail here
            first = first_amount(row_of(x["quote"], pages[page - 1][1]) if valid else quote, v)
            col_known += first is not None
            if first is not None and abs(abs(first) - abs(v)) > 0.005 + 1e-9 * abs(v):
                bad_col.append(x["label"])
        if v is not None and topic != "segments":
            v = abs(v)  # capex, debt due, claims and transactions are sizes; a cash outflow prints in brackets
        rows.append({"label": x["label"].strip()[:120], "amount": None if v is None else v * UNITS.get(unit, 1.0), "raw": x["amount"],
                     "page": page, "quote": x["quote"].strip()[:400]})
    cited = sorted({x["page"] for x in items if 1 <= x["page"] <= len(pages)})
    text = {p: norm(pages[p - 1][0]) for p in cited}
    heads = {p: {HEAD_UNIT[h[:2]] for h in UNIT_HEAD.findall(text[p])} for p in cited}
    said = set().union(*heads.values())
    # rules settle the unit: a table heading on a cited page wins; with none, the claimed unit must be printed there
    if unit == "percent":
        unit_seen = any("%" in t or "percent" in t for t in text.values())
        why = "" if unit_seen else " But no cited page prints a percentage."
    elif said:
        unit_seen = said == {unit}
        why = ("" if unit_seen else f" But cited pages say {' and '.join(sorted(said))} in their headings." if len(said) > 1
               else f" But page {next(p for p in cited if heads[p])} says Rs in {next(iter(said))}.")
    elif unit == "rupees":
        unit_seen = not any(r.search(t) for t in text.values() for r in UNIT_RE.values())
        why = "" if unit_seen else " But a cited page names a larger unit."
    else:
        unit_seen = any(UNIT_RE[unit].search(t) for t in text.values())
        why = "" if unit_seen else f" But no cited page says {unit}."
    n_items = len(items)
    what = lambda bad: ", ".join(bad[:4]) + (f" and {len(bad) - 4} more" if len(bad) > 4 else "")  # noqa: E731
    vals = [r["amount"] for r in rows if r["amount"] is not None]
    total = (max(vals, default=0.0) if unit == "percent" else sum(vals))  # a pledge is one share, not a sum
    checks = [
        {"name": "Pages were read", "pass": not bad_page,
         "detail": f"Every item cites one of the pages sent ({', '.join(map(str, sent))})." if not bad_page
         else f"{what(bad_page)} cite a page that wasn't sent ({', '.join(map(str, sent))})."},
        {"name": "Quotes are on their pages", "pass": not (bad_quote or short),
         "detail": ("The quote occurs on the cited page." if n_items == 1 else f"All {n_items} quotes occur on the cited pages.")
         if not (bad_quote or short) else " ".join(
             ([f"The quote for {what(bad_quote)} doesn't occur on its page."] if bad_quote else [])
             + ([f"The quote for {what(short)} is under {MIN_NOTE_WORDS} words."] if short else [])) + " So the note is rejected."},
        {"name": "Numbers are in their quotes", "pass": not bad_num,
         "detail": ("The amount parses and appears in its quote." if n_items == 1 else f"All {n_items} amounts parse and appear in their quotes.") if not bad_num
         else f"The amount for {what(bad_num)} doesn't parse or isn't in its quote"
         + (", or isn't between 0 and 100." if topic == "pledge" else ".")},
        {"name": "Unit", "pass": unit_seen,
         "detail": ("A percentage of promoter shares, kept as printed." if unit == "percent"
                    else f"Amounts in {unit}, converted to Rs crore by rules (x {UNITS[unit]:g}).") + why},
        year_check(pages, end),
    ]
    if topic == "capex":
        checks.append({"name": "Current-year column", "pass": False if bad_col else True if col_known else None,
                       "detail": f"{what(bad_col)} isn't the first amount in its row (the current year's column), so "
                       "it may be the previous year's." if bad_col else "Each amount is the first in its row, the "
                       "current year's column." if col_known else "No row shows which column the amount is from."})
    if topic in TIE:
        tol, cands = TIE[topic], [(k, v) for k, v in against or () if v]
        if not cands:
            checks.append({"name": "Ties to the statements", "pass": None,
                           "detail": "No cash-flow capex from an XBRL filing for this year to compare with."
                           if topic == "capex" else "Nothing to compare with for this year."})
        else:
            k, v = min(cands, key=lambda c: abs(total / c[1] - 1))  # the closest (borrowings with or without leases)
            gap = total / v - 1
            checks.append({"name": "Ties to the statements", "pass": abs(gap) <= tol,
                           "detail": f"Sum {_cr(total)} vs {k} {_cr(v)}: {gap:+.1%} (within {tol:.0%} needed)."})
    return rows, total, checks


# what each opinion looks like in the auditor's own words (norm() text); an unmodified one must not read "except for"
OPINION_WORDS = {"unmodified": r"true and fair view", "qualified": r"qualified opinion|except for the (?:effects?|possible)",
                 "adverse": r"adverse opinion|do not give a true and fair view", "disclaimer": r"disclaimer of opinion|do not express an opinion"}
CHANGE_WORDS = r"\bappoint|\bresign|\brotat|\bceased?\b|\bvacat|\breplac"


def auditor_checks(reply, pages, sent, end: date):
    """Rules on the auditor's-report note: pages sent, quotes on their pages, the opinion is what the quotes say, the
    firm is named on a cited page, a claimed change is quoted, the report is for the year. (rows, 0.0, checks)."""
    items, op = reply["items"], reply["opinion"]
    rows = [{"label": x["label"].strip()[:120], "amount": None, "raw": None, "page": x["page"],
             "quote": x["quote"].strip()[:400]} for x in items]
    ok = lambda x: 1 <= x["page"] <= len(pages) and on_page(norm(x["quote"]), pages[x["page"] - 1])  # noqa: E731
    bad_page = [x["label"] for x in items if x["page"] not in sent]
    bad_quote = [x["label"] for x in items if not ok(x) or len(norm(x["quote"]).split()) < MIN_NOTE_WORDS]
    quotes = [norm(x["quote"]) for x in items if ok(x)]
    said = any(re.search(OPINION_WORDS[op], q) for q in quotes) and not (
        op == "unmodified" and any(re.search(OPINION_WORDS["qualified"], q) for q in quotes))
    firm = re.sub(r"[^a-z0-9& ]", " ", norm(reply["auditor"])).split()
    cited = [norm(pages[x["page"] - 1][0]) + " " + norm(pages[x["page"] - 1][1]) for x in items if 1 <= x["page"] <= len(pages)]
    named = bool(firm) and any(all(w in re.sub(r"[^a-z0-9& ]", " ", t).split() for w in firm) for t in cited)
    changed = reply["changed"]
    quoted = any(re.search(CHANGE_WORDS, q) for q in quotes)
    checks = [
        {"name": "Pages were read", "pass": not bad_page,
         "detail": f"Every quote cites one of the pages sent ({', '.join(map(str, sent))})." if not bad_page
         else f"{', '.join(bad_page)} cite a page that wasn't sent."},
        {"name": "Quotes are on their pages", "pass": not bad_quote,
         "detail": "Every quote occurs on its page." if not bad_quote
         else f"The quote for {', '.join(bad_quote)} isn't on its page (or is under {MIN_NOTE_WORDS} words), so the note is rejected."},
        {"name": "Opinion matches the quotes", "pass": said,
         "detail": f"A quote reads as {'an' if op[0] in 'aeiou' else 'a'} {op} opinion." if said
         else f"No quote reads as {'an' if op[0] in 'aeiou' else 'a'} {op} opinion."},
        {"name": "Firm is named", "pass": named,
         "detail": f"{reply['auditor'].strip()[:80]} is printed on a cited page." if named
         else f"{reply['auditor'].strip()[:80]} isn't printed on any cited page."},
        {"name": "Change of auditor", "pass": quoted if changed else None,
         "detail": ("A quote names the appointment or resignation." if quoted else "A change is claimed, but no quote shows it.")
         if changed else "No change claimed; rules can't prove a negative, so this is a note."},
        year_check(pages, end),
    ]
    return rows, 0.0, checks


# ---------- forensic flags explained in words (4.3): rules found the flag; the LLM only says why, with a quote ----------

# words that point at the page explaining each forensic flag (model.forensic keys); a page needs one of them
FLAG_WORDS = {"cash": ("cash generated from operations", "working capital", "trade receivables", "cash flow from operating"),
              "dso": ("trade receivables", "receivables", "credit period", "unbilled", "collection"),
              "dio": ("inventories", "inventory", "stock", "raw materials"),
              "cwip": ("capital work-in-progress", "capital work in progress", "capex", "commissioning", "expansion"),
              "other_income": ("other income", "interest income", "dividend income", "fair value", "exceptional"),
              "tax": ("tax expense", "deferred tax", "effective tax", "tax rate", "minimum alternate tax", "new tax regime"),
              "debt": ("borrowings", "debt", "term loan", "debentures", "repayment"),
              "cover": ("finance costs", "interest", "borrowings"),
              "nwc": ("working capital", "trade receivables", "inventories", "advances"),
              "mscore": ("trade receivables", "revenue recognition", "depreciation", "accruals"),
              "contingent": ("contingent liabilities", "claims not acknowledged"),
              "related": ("related party", "related parties"),
              "pledge": ("pledged", "encumbered", "promoter"),
              "auditor": ("auditor", "audit", "opinion")}
FLAG_WORDS["cash5"] = FLAG_WORDS["cash"]


def pick_flag_pages(pages, key, end: date):
    """Up to 4 pages for a forensic flag, best first: the flag's words (capped 5 hits each), exceptional items, then the
    year. A page needs a word hit, not just the year."""
    words = [*COMMON_WORDS, *((w, 2) for w in FLAG_WORDS.get(key, ()))]
    yr, scored = year_re(end), []
    for i, (raw, _) in enumerate(pages):
        t = norm(raw)
        hits = sum(min(t.count(w), 5) * wt for w, wt in words)
        if hits:
            scored.append((hits + min(len(yr.findall(t)), 5), -i))
    return [-i + 1 for _, i in sorted(scored, reverse=True)[:MAX_PAGES]]


def explain_flag(flag, numbers, pages=None):
    """Words only: why a forensic rule lit, from the annual report's `pages` [(page number, text)] with a quote, or
    from the numbers alone. {summary, page, quote} or {summary}."""
    prompt = (f"A rule check on an Indian listed company's reported figures lit up:\n- {flag['title']}: {flag['detail']}\n"
              f"- Rule: {flag['rule']}\n\nIts reported figures (Rs crore):\n{numbers}\n\n")
    rule = ("Every number you write must appear above or inside your quote, written exactly as it appears there (so quote "
            "the table row or sentence that holds the figures you use, and leave out figures from other rows); don't work "
            "out new ones. Don't say whether to buy or sell.")
    if pages:
        text = "\n\n".join(f"=== PAGE {n} ===\n{t[:MAX_PAGE_CHARS]}" for n, t in pages)
        prompt += (f"Pages from its annual report (only these were read):\n{text}\n\n"
                   "Using only these pages, say in at most two sentences (under 80 words) what explains the flag, or "
                   "that the pages don't. Give the page number and a quote of 5 to 80 words copied character for "
                   "character from that page as evidence; it may run across consecutive table rows, as printed. "
                   f"{rule}\n"
                   'Answer as a JSON object: {"summary": "...", "page": number, "quote": "..."}.')
    else:
        prompt += ("No filing was read. From these numbers alone, say in at most two sentences (under 80 words) what "
                   f"most likely explains the flag, and say it is a reading of the numbers, not a reported fact. {rule}\n"
                   'Answer as a JSON object: {"summary": "..."}.')
    return ask_json(prompt, _note_shape(bool(pages)))


_MON = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
# years, FY labels and dates ("31 March 2026", "March 31, 2026") aren't figures
FY_RE = re.compile(rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+{_MON}|\b{_MON}\s+\d{{1,2}}(?:st|nd|rd|th)?\b,?"
                   r"|\b(?:fy\s?'?)?(?:19|20)\d\d(?:\s?-\s?\d\d(?:\d\d)?)?\b|\bfy\s?'?\d\d\b", re.I)
PROSE_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def numbers_check(summary, given, quote=None):
    """Rule: every number in AI prose is one the app gave it (its computed figures and flag text, `given`) or one in the
    cited quote, at the precision written ("29%" matches 0.2913 and 29.13; "1,234" matches 1,234.4). Years and
    financial-year labels and page references ("page 185") pass; so do counts up to 12 ("5 years"). {name, pass, detail}."""
    pool = {n for t in (given, quote or "") for n in (amount(x) for x in PROSE_NUM.findall(FY_RE.sub(" ", t))) if n is not None}
    pool |= {x * 100 for x in pool}
    bad = []
    for raw in PROSE_NUM.findall(FY_RE.sub(" ", re.sub(r"\b(?:pages?|p\.)\s*\d+", " ", summary, flags=re.I))):
        x = amount(raw)
        if x is None or (x == int(x) and x <= 12):
            continue  # ponytail: small counts pass unchecked; "10 years" can't be told from a computed 10
        dp = len(raw.split(".")[1]) if "." in raw else 0
        if not any(abs(round(abs(p), dp) - x) <= 10 ** -dp / 2 + 1e-9 for p in pool):
            bad.append(raw)
    return {"name": "Numbers match", "pass": not bad,
            "detail": "Every number in the text is one the app computed or one in the quote." if not bad
            else f"{', '.join(bad[:4])} {'is' if len(bad) == 1 else 'are'} neither computed by the app nor in the quote, "
                 "so the explanation is rejected."}
