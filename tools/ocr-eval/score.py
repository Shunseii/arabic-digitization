"""Score each model's transcriptions against a reference.

    .venv/bin/python score.py [--ref gemini-3.1-pro-preview] [--ref-dir data/ref]

Reference: by default the current production output (Gemini 3.1 Pro preview).
Pages with a hand-corrected file in data/ref/<file_id>.md use that instead, and
are reported separately as "gold" so a model can beat Gemini there.

Text is compared after stripping Markdown and HTML (ruby glosses are kept as
text), punctuation and whitespace runs, so layout differences don't count.

Metrics (lower is better unless noted):
- cer      character error rate on letters + diacritics
- cer_base character error rate with diacritics removed (letters only)
- wer_base word error rate with diacritics removed: the share of words that
           are wrong, missing or extra (the plain "is the text right" score)
- dia_err  share of the reference's letters whose diacritics differ, among
           letters both texts agree on
- invented diacritics the model added on letters the reference left bare,
           per 100 letters
- dropped  reference diacritics the model left out, per 100 letters
- struct   share of pages whose header/footnote structure matches (higher is
           better): "---" divider present, "### الحاشية" present iff in ref
"""
import argparse, glob, json, os, re, statistics

from rapidfuzz.distance import Levenshtein

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "out")

MARKS = set(chr(c) for c in range(0x064B, 0x0653)) | {"ٰ"}
DROP = re.compile(r"[ـ‌-‏؜]")  # tatweel, bidi/zero-width
KEEP = re.compile(r"[^؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿0-9 ]")
PUNCT = re.compile(r"[،؛؟٪-٭۔﴾﴿۝۞]")


def normalize(md: str) -> str:
    t = re.sub(r"<rt>(.*?)</rt>", r" \1 ", md)
    t = re.sub(r"<[^>]+>", " ", t)
    t = DROP.sub("", t)
    t = PUNCT.sub(" ", t)
    t = KEEP.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def strip_marks(t: str) -> str:
    return "".join(c for c in t if c not in MARKS)


def clusters(t: str):
    """[(base_char, frozenset(marks))] for each non-mark character."""
    out = []
    for c in t:
        if c in MARKS:
            if out:
                out[-1][1].add(c)
        else:
            out.append((c, set()))
    return [(b, frozenset(m)) for b, m in out]


def dia_stats(ref: str, hyp: str):
    rc, hc = clusters(ref), clusters(hyp)
    rb, hb = "".join(b for b, _ in rc), "".join(b for b, _ in hc)
    letters = sum(1 for b, _ in rc if b != " ")
    diff = invented = dropped = compared = 0
    for op in Levenshtein.opcodes(rb, hb):
        if op.tag != "equal":
            continue
        for i, j in zip(range(op.src_start, op.src_end), range(op.dest_start, op.dest_end)):
            (b, rm), (_, hm) = rc[i], hc[j]
            if b == " ":
                continue
            compared += 1
            if rm != hm:
                diff += 1
            invented += len(hm - rm) if not rm else 0
            dropped += len(rm - hm)
    return {"dia_err": diff / max(compared, 1),
            "invented": 100 * invented / max(letters, 1),
            "dropped": 100 * dropped / max(letters, 1)}


def structure_ok(ref_md: str, hyp_md: str) -> bool:
    has_div = re.search(r"^---\s*$", hyp_md, re.M) is not None
    ref_fn = "الحاشية" in ref_md
    hyp_fn = "الحاشية" in hyp_md
    return has_div and ref_fn == hyp_fn


def score(ref_md: str, hyp_md: str):
    r, h = normalize(ref_md), normalize(hyp_md)
    rb, hb = strip_marks(r), strip_marks(h)
    return {"cer": Levenshtein.distance(r, h) / max(len(r), 1),
            "cer_base": Levenshtein.distance(rb, hb) / max(len(rb), 1),
            "wer_base": Levenshtein.distance(rb.split(), hb.split()) / max(len(rb.split()), 1),
            **dia_stats(r, h),
            "struct": float(structure_ok(ref_md, hyp_md))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="gemini-3.1-pro-preview")
    ap.add_argument("--ref-dir", default=os.path.join(HERE, "data", "ref"))
    ap.add_argument("--per-page", action="store_true")
    a = ap.parse_args()

    rows = json.load(open(os.path.join(HERE, "data", "sample.json")))
    titles = {r["file_id"]: r["book_title"] for r in rows}
    gold = {os.path.basename(p)[:-3] for p in glob.glob(os.path.join(a.ref_dir, "*.md"))}

    def ref_text(fid):
        p = os.path.join(a.ref_dir, f"{fid}.md") if fid in gold else os.path.join(OUT, a.ref, f"{fid}.md")
        return open(p).read() if os.path.exists(p) else None

    models = sorted(d for d in os.listdir(OUT) if os.path.isdir(os.path.join(OUT, d)))
    keys = ["cer", "cer_base", "wer_base", "dia_err", "invented", "dropped", "struct"]
    report = {}
    for m in models:
        per = {}
        for fid in titles:
            hyp_p = os.path.join(OUT, m, f"{fid}.md")
            ref = ref_text(fid)
            if ref is None or not os.path.exists(hyp_p):
                continue
            if m == a.ref and fid not in gold:
                continue
            per[fid] = score(ref, open(hyp_p).read())
        if not per:
            continue
        groups = {"all": list(per), "gold": [f for f in per if f in gold]}
        report[m] = {g: ({k: statistics.mean(per[f][k] for f in fs) for k in keys} | {"n": len(fs)})
                     for g, fs in groups.items() if fs}
        if a.per_page:
            for fid, s in sorted(per.items(), key=lambda kv: -kv[1]["cer"]):
                print(f"  {m:32} {titles[fid][:24]:24} cer={s['cer']:.3f} dia={s['dia_err']:.3f}")

    for g in ("all", "gold"):
        lines = [(m, r[g]) for m, r in report.items() if g in r]
        if not lines:
            continue
        print(f"\n== {g} pages (reference: {'hand-corrected' if g == 'gold' else a.ref + ' + any hand-corrected'})")
        print(f"{'model':34} {'n':>3} {'cer':>7} {'cer_base':>9} {'wer_base':>9} {'dia_err':>8} {'invented':>9} {'dropped':>8} {'struct':>7}")
        for m, s in sorted(lines, key=lambda x: x[1]["cer"]):
            print(f"{m:34} {s['n']:>3} {s['cer']:>7.3f} {s['cer_base']:>9.3f} {s['wer_base']:>9.3f} {s['dia_err']:>8.3f} "
                  f"{s['invented']:>9.2f} {s['dropped']:>8.2f} {s['struct']:>7.2f}")


if __name__ == "__main__":
    main()
