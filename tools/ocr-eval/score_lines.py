"""Score line positions (T151): does each numbered line of our transcription get
a box that really contains that text?

    .venv/bin/python score_lines.py

Checker: Nuqta's line-mode rows (data/lines/nuqta-lines), each a printed row
with its own reading. A predicted box is checked by joining the readings of
the rows whose centre falls inside it and comparing that to the line's text
(letters only, fuzzy partial match >= 70). Pages where Nuqta found fewer than
5 rows (photos it could not segment) are skipped for the checker.

Methods:
- VLM boxes (data/lines/<model>/): the model is given our numbered lines and
  returns boxes. "covered" = share of lines that got any valid box;
  "correct" = share of all lines whose box holds the right text.
- nuqta-lines (text matching, no model call at view time): each numbered
  line is matched to the run of consecutive Nuqta rows whose readings best
  match it; "covered" = share matched at >= 70.
"""
import glob, json, os, re, statistics

from rapidfuzz import fuzz

from score import normalize, strip_marks

HERE = os.path.dirname(os.path.abspath(__file__))
L = os.path.join(HERE, "data", "lines")
THRESH = 70


def letters(t):
    return strip_marks(normalize(t)).replace(" ", "")


def checker(fid):
    p = os.path.join(L, "nuqta-lines", f"{fid}.json")
    if not os.path.exists(p):
        return None
    rows = json.load(open(p))["lines"]
    return rows if len(rows) >= 5 else None


def box_text(rows, box, W, H):
    x0, y0, x1, y1 = box[0] * W / 1000, box[1] * H / 1000, box[2] * W / 1000, box[3] * H / 1000
    inside = [r["text"] for r in rows
              if x0 <= (r["bbox"][0] + r["bbox"][2]) / 2 <= x1 and y0 <= (r["bbox"][1] + r["bbox"][3]) / 2 <= y1]
    return " ".join(inside)


def page_size(fid):
    from PIL import Image
    return Image.open(os.path.join(HERE, "data", "pages", f"{fid}.jpg")).size


def score_vlm(model_dir):
    cov, cor, pages = [], [], 0
    for p in glob.glob(os.path.join(model_dir, "*.json")):
        fid = os.path.basename(p)[:-5]
        rec = json.load(open(p))
        lines, pred = rec["lines"], rec.get("pred") or {}
        by_n = {}
        for item in pred.get("lines", []) or []:
            boxes = [b for b in (item.get("boxes") or [])
                     if isinstance(b, list) and len(b) == 4 and all(isinstance(v, (int, float)) for v in b)
                     and b[2] > b[0] and b[3] > b[1]]
            if isinstance(item.get("n"), int) and boxes:
                by_n[item["n"]] = boxes
        cov.append(sum(1 for n in range(1, len(lines) + 1) if n in by_n) / max(len(lines), 1))
        rows = checker(fid)
        if rows is None:
            continue
        pages += 1
        W, H = page_size(fid)
        ok = 0
        for n, text in enumerate(lines, 1):
            if n not in by_n:
                continue
            got = " ".join(box_text(rows, b, W, H) for b in by_n[n])
            if got and fuzz.partial_ratio(letters(text), letters(got)) >= THRESH:
                ok += 1
        cor.append(ok / max(len(lines), 1))
    return {"pages": len(cov), "covered": statistics.mean(cov) if cov else 0,
            "checked_pages": pages, "correct": statistics.mean(cor) if cor else 0}


def score_text_match():
    """Place each numbered line on a run of consecutive Nuqta rows by text."""
    from run_lines_cloud import numbered_lines
    cov = []
    for p in glob.glob(os.path.join(L, "nuqta-lines", "*.json")):
        fid = os.path.basename(p)[:-5]
        rows = checker(fid)
        if rows is None:
            continue
        ref = os.path.join(HERE, "data", "out", "gemini-3.1-pro-preview", f"{fid}.md")
        lines = numbered_lines(open(ref).read())
        row_letters = [letters(r["text"]) for r in rows]
        hit = 0
        for text in lines:
            t = letters(text)
            if not t:
                continue
            best = 0
            for i in range(len(rows)):
                joined = ""
                for j in range(i, min(i + 8, len(rows))):
                    joined += row_letters[j]
                    best = max(best, fuzz.ratio(t, joined))
                    if len(joined) > 1.3 * len(t):
                        break
            hit += best >= THRESH
        cov.append(hit / max(len(lines), 1))
    return {"pages": len(cov), "covered": statistics.mean(cov) if cov else 0}


if __name__ == "__main__":
    print(f"{'method':34} {'pages':>5} {'covered':>8} {'checked':>8} {'correct':>8}")
    for d in sorted(glob.glob(os.path.join(L, "*"))):
        name = os.path.basename(d)
        if name in ("cv", "overlay", "nuqta-lines") or not os.path.isdir(d):
            continue
        s = score_vlm(d)
        print(f"{name:34} {s['pages']:>5} {s['covered']:>8.2f} {s['checked_pages']:>8} {s['correct']:>8.2f}")
    s = score_text_match()
    print(f"{'nuqta rows + text match':34} {s['pages']:>5} {s['covered']:>8.2f} {'-':>8} {'-':>8}")
