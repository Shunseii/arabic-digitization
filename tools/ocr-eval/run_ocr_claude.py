"""Full-page OCR with Claude, same prompt and request shape as the API's
fallback (apps/api/src/ocr.ts runClaude), for scoring with score.py.

    .venv/bin/python run_ocr_claude.py claude-sonnet-5-5 [--limit N]

Writes data/out/anthropic_<model>/<file_id>.md and usage.jsonl.
"""
import argparse, base64, json, os, sys, time  # noqa: E401
from concurrent.futures import ThreadPoolExecutor

import anthropic

from run_cloud import DATA, mime, system_prompt, with_book_notes
from run_lines_claude import api_key


def run(model, rows, workers):
    client = anthropic.Anthropic(api_key=api_key())
    outdir = os.path.join(DATA, "out", f"anthropic_{model}")
    os.makedirs(outdir, exist_ok=True)
    base = system_prompt()

    def one(row):
        fid = row["file_id"]
        dest = os.path.join(outdir, f"{fid}.md")
        if os.path.exists(dest):
            return "skip"
        img = os.path.join(DATA, "pages", f"{fid}.jpg")
        t0 = time.time()
        try:
            msg = client.messages.create(
                model=model,
                max_tokens=16000,
                system=with_book_notes(base, row.get("ocr_instructions")),
                thinking={"type": "between_tools" if model == "claude-sonnet-5-5" else "disabled"},
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime(img),
                                                 "data": base64.b64encode(open(img, "rb").read()).decode()}},
                    {"type": "text", "text": "Transcribe this page."}]}],
            )
        except anthropic.APIError as e:
            print(f"FAIL {fid}: {str(e)[:300]}", file=sys.stderr)
            return "fail"
        text = "".join(b.text for b in msg.content if b.type == "text")
        open(dest, "w").write(text.strip() + "\n")
        with open(os.path.join(outdir, "usage.jsonl"), "a") as f:
            f.write(json.dumps({"file_id": fid, "in": msg.usage.input_tokens, "out": msg.usage.output_tokens,
                                "secs": round(time.time() - t0, 1)}) + "\n")
        return "ok"

    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, rows))
    print(model, {k: res.count(k) for k in set(res)})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    rows = json.load(open(os.path.join(DATA, "sample.json")))
    run(a.model, rows[: a.limit] if a.limit else rows, a.workers)
