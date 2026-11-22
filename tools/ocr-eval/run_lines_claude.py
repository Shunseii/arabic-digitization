"""Line positions (T151) from Claude: same prompt and inputs as run_lines_cloud.py.

    .venv/bin/python run_lines_claude.py claude-sonnet-5 [--limit N] [--only FILE_ID]

Key: /run/user/1000/ad-secrets/anthropic (read once from 1Password; never
printed) or ANTHROPIC_API_KEY. Thinking is off, as in the production fallback.
Writes data/lines/anthropic_<model>/<file_id>.json plus overlays.
"""
import argparse, base64, io, json, os, sys, time  # noqa: E401
from concurrent.futures import ThreadPoolExecutor

import anthropic
from PIL import Image

from lines_cv import draw
from run_cloud import DATA
from run_lines_cloud import PROMPT, extract_json, numbered_lines

# Claude downsizes images to ~1568 px on the long edge (~1.15 MP) and answers
# in pixels of what it sees, so send exactly that size and ask for pixels.
MAX_EDGE, MAX_PIXELS = 1568, 1_150_000

CLAUDE_COORDS = """Coordinates: integers in pixels of this image, which is {w} x {h} pixels,
as [x0, y0, x1, y1] with x0<x1 and y0<y1 (x from the left edge, y from the top)."""


def api_key():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    return open("/run/user/1000/ad-secrets/anthropic").read().strip()


def image_block(path):
    """The page shrunk to Claude's working size; returns (block, width, height)."""
    im = Image.open(path).convert("RGB")
    scale = min(1.0, MAX_EDGE / max(im.size), (MAX_PIXELS / (im.width * im.height)) ** 0.5)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    block = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.b64encode(buf.getvalue()).decode()}}
    return block, im.width, im.height


def claude_prompt(w, h):
    start = PROMPT.index("Coordinates:")
    end = PROMPT.index("Use one box")
    return PROMPT[:start] + CLAUDE_COORDS.format(w=w, h=h) + "\n" + PROMPT[end:]


def run(model, rows, workers):
    client = anthropic.Anthropic(api_key=api_key())
    slug = f"anthropic_{model}"
    outdir = os.path.join(DATA, "lines", slug)
    os.makedirs(outdir, exist_ok=True)

    def one(row):
        fid = row["file_id"]
        dest = os.path.join(outdir, f"{fid}.json")
        if os.path.exists(dest):
            return "skip"
        img_p = os.path.join(DATA, "pages", f"{fid}.jpg")
        lines = numbered_lines(open(os.path.join(DATA, "out", "gemini-3.1-pro-preview", f"{fid}.md")).read())
        listing = "\n".join(f"{i}. {t}" for i, t in enumerate(lines, 1))
        block, sw, sh = image_block(img_p)
        t0 = time.time()
        try:
            msg = client.messages.create(
                model=model,
                max_tokens=8000,
                system=claude_prompt(sw, sh),
                # Sonnet 5.5 turns thinking off with "between_tools"; it rejects "disabled".
                thinking={"type": "between_tools" if model == "claude-sonnet-5-5" else "disabled"},
                messages=[{"role": "user", "content": [block, {"type": "text", "text": f"Text lines:\n{listing}"}]}],
            )
        except anthropic.APIError as e:
            print(f"FAIL {fid}: {str(e)[:300]}", file=sys.stderr)
            return "fail"
        text = "".join(b.text for b in msg.content if b.type == "text")
        try:
            parsed = extract_json(text)
        except json.JSONDecodeError:
            parsed = None
        if parsed:
            for item in parsed.get("lines", []) or []:
                item["boxes"] = [[round(b[0] * 1000 / sw), round(b[1] * 1000 / sh), round(b[2] * 1000 / sw), round(b[3] * 1000 / sh)]
                                 for b in (item.get("boxes") or []) if isinstance(b, list) and len(b) == 4
                                 and all(isinstance(v, (int, float)) for v in b)]
        json.dump({"lines": lines, "pred": parsed, "sent_size": [sw, sh], "raw": None if parsed else text[:2000],
                   "secs": round(time.time() - t0, 1),
                   "usage": {"in": msg.usage.input_tokens, "out": msg.usage.output_tokens}},
                  open(dest, "w"), ensure_ascii=False)
        if parsed:
            img = Image.open(img_p)
            W, H = img.size
            boxes = [[b[0] * W / 1000, b[1] * H / 1000, b[2] * W / 1000, b[3] * H / 1000]
                     for item in parsed.get("lines", []) for b in (item.get("boxes") or [])
                     if isinstance(b, list) and len(b) == 4 and b[2] > b[0] and b[3] > b[1]]
            draw(img, boxes, os.path.join(DATA, "lines", "overlay", slug, f"{fid}.jpg"), color=(200, 90, 20))
        return "ok" if parsed else "bad-json"

    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, rows))
    print(model, {k: res.count(k) for k in set(res)})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    rows = json.load(open(os.path.join(DATA, "sample.json")))
    if a.only:
        rows = [r for r in rows if r["file_id"] == a.only]
    if a.limit:
        rows = rows[: a.limit]
    run(a.model, rows, a.workers)
