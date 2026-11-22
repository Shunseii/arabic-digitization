"""Ask a vision model where each transcribed line sits on the scan (T151 shape).

    python3 run_lines_cloud.py <model> [--limit N] [--only FILE_ID]

Input per page: the scan plus our current transcription split into numbered
lines (header, matn lines, footnote lines; dividers dropped, ruby glosses
stripped). The model returns JSON boxes on a 0-1000 grid. Output:
data/lines/<model-slug>/<file_id>.json and an overlay in
data/lines/overlay/<model-slug>/<file_id>.jpg.
"""
import argparse, base64, json, os, re, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

from run_cloud import ACCOUNT, DATA, MODELS, REPO, mime, token

# Called straight on Google AI Studio (what production uses), not via Cloudflare.
DIRECT = {"gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite"}


def google_key():
    for line in open(os.path.join(REPO, "apps/api/.dev.vars")):
        if line.startswith("GOOGLE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("GOOGLE_API_KEY missing from apps/api/.dev.vars")

PROMPT = """You locate text lines on a scanned page of an Arabic book.

You get the page image and a numbered list of the page's text lines (a line may
be a whole paragraph that wraps over several printed rows, and a paragraph can
continue into another column). For every numbered line, return the box or boxes
on the image that contain exactly that text.

Coordinates: integers on a 0-1000 grid over the whole image, as
[x0, y0, x1, y1] with x0<x1 and y0<y1 (x from the left edge, y from the top).
Use one box per contiguous region; give several boxes only when the line's text
is split across columns.

Return ONLY JSON, no prose, no code fences:
{"lines": [{"n": 1, "boxes": [[x0, y0, x1, y1]]}, ...]}
Include every number from the list exactly once."""


# Strict schema (T151 found Flash broke its JSON on 5/20 pages without one).
SCHEMA = {"type": "OBJECT", "required": ["lines"], "properties": {"lines": {"type": "ARRAY", "items": {
    "type": "OBJECT", "required": ["n", "boxes"], "properties": {
        "n": {"type": "INTEGER"},
        "boxes": {"type": "ARRAY", "items": {"type": "ARRAY", "items": {"type": "INTEGER"}}}}}}}}


def numbered_lines(md: str):
    out = []
    for line in md.splitlines():
        line = re.sub(r"<rt>.*?</rt>", "", line)
        line = re.sub(r"<[^>]+>", "", line).strip()
        if not line or line == "---":
            continue
        out.append(line)
    return out


def body_for(fmt, model, img_b64, mt, lines):
    listing = "\n".join(f"{i}. {t}" for i, t in enumerate(lines, 1))
    user = f"Text lines:\n{listing}"
    if fmt == "gemini":
        return {"systemInstruction": {"parts": [{"text": PROMPT}]},
                "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": mt, "data": img_b64}}, {"text": user}]}],
                "generationConfig": {"maxOutputTokens": 8000, "responseMimeType": "application/json",
                                     "responseSchema": SCHEMA,
                                     "thinkingConfig": {"thinkingLevel": "low"}}}
    return {"messages": [{"role": "system", "content": PROMPT},
                         {"role": "user", "content": [
                             {"type": "image_url", "image_url": {"url": f"data:{mt};base64,{img_b64}"}},
                             {"type": "text", "text": user}]}],
            "max_tokens": 8000, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False}}


def extract_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0)) if m else None


def run(model, rows, tok, workers):
    from lines_cv import draw
    from PIL import Image
    direct = model in DIRECT
    fmt = "gemini" if direct else MODELS[model]
    hosted = model.startswith("@cf/") or direct
    slug = ("google-direct_" + model) if direct else model.lstrip("@").replace("/", "_")
    outdir = os.path.join(DATA, "lines", slug)
    os.makedirs(outdir, exist_ok=True)
    if direct:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        headers = {"x-goog-api-key": google_key(), "Content-Type": "application/json"}
    else:
        url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run" + (f"/{model}" if hosted else "")
        headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}

    def one(row):
        fid = row["file_id"]
        dest = os.path.join(outdir, f"{fid}.json")
        if os.path.exists(dest):
            return "skip"
        img_p = os.path.join(DATA, "pages", f"{fid}.jpg")
        lines = numbered_lines(open(os.path.join(DATA, "out", "gemini-3.1-pro-preview", f"{fid}.md")).read())
        body = body_for(fmt, model, base64.b64encode(open(img_p, "rb").read()).decode(), mime(img_p), lines)
        payload = json.dumps(body if hosted else {"model": model, "input": body}).encode()
        err = None
        for attempt in range(2):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=payload, method="POST", headers=headers)
                data = json.load(urllib.request.urlopen(req, timeout=300))
                r = data.get("result", data)
                if fmt == "gemini":
                    text = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"] if not p.get("thought"))
                else:
                    text = r["choices"][0]["message"].get("content") if "choices" in r else r.get("response", "")
                    if isinstance(text, dict):
                        text = json.dumps(text)
                parsed = extract_json(text or "")
                rec = {"lines": lines, "pred": parsed, "raw": None if parsed else text,
                       "secs": round(time.time() - t0, 1), "usage": r.get("usage") or r.get("usageMetadata")}
                json.dump(rec, open(dest, "w"), ensure_ascii=False)
                if parsed:
                    img = Image.open(img_p)
                    W, H = img.size
                    boxes = [[b[0] * W / 1000, b[1] * H / 1000, b[2] * W / 1000, b[3] * H / 1000]
                             for item in parsed.get("lines", []) for b in item.get("boxes", [])
                             if isinstance(b, list) and len(b) == 4 and b[2] > b[0] and b[3] > b[1]]
                    draw(img, boxes, os.path.join(DATA, "lines", "overlay", slug, f"{fid}.jpg"), color=(30, 90, 230))
                return "ok" if parsed else "bad-json"
            except urllib.error.HTTPError as e:
                err = f"{e.code} {e.read().decode()[:300]}"
            except Exception as e:
                err = repr(e)[:300]
            time.sleep(5)
        print(f"FAIL {fid}: {err}", file=sys.stderr)
        return "fail"

    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, rows))
    print(model, {k: res.count(k) for k in set(res)})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=list(MODELS) + sorted(DIRECT))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    rows = json.load(open(os.path.join(DATA, "sample.json")))
    if a.only:
        rows = [r for r in rows if r["file_id"] == a.only]
    if a.limit:
        rows = rows[: a.limit]
    run(a.model, rows, None if a.model in DIRECT else token(), a.workers)
