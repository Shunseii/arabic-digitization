"""Run candidate OCR models on Workers AI over the sampled pages.

    python3 run_cloud.py <model> [--limit N] [--only FILE_ID]

Models (see MODELS below) are called through the Workers AI REST API with the
same system prompt the API uses (apps/api/src/ocr.ts), plus each book's
ocr_instructions. Output goes to data/out/<model-slug>/<file_id>.md, with token
usage in data/out/<model-slug>/usage.jsonl. Existing outputs are skipped.

Auth: the wrangler login (`npx wrangler auth token`), held in memory only.
"""
import argparse, base64, json, os, re, subprocess, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
REPO = os.path.dirname(os.path.dirname(HERE))
ACCOUNT = "9759ed7a233a1a22e2f01031de0f160a"

# model id -> request format ("gemini" = generateContent body, "chat" = OpenAI chat)
MODELS = {
    "google/gemini-3.1-pro": "gemini",
    "google/gemini-3.5-flash-lite": "gemini",
    "google/gemini-3.6-flash": "gemini",
    "alibaba/qwen3.7-plus": "chat",
    "@cf/qwen/qwen3.8-27b": "chat",
    "@cf/google/gemma-4-26b-a4b-it": "chat",
}


def system_prompt():
    src = open(os.path.join(REPO, "apps/api/src/ocr.ts")).read()
    body = re.search(r"const SYSTEM_PROMPT = `(.*?)`;", src, re.S).group(1)
    return body.replace("${BLANK_MARKER}", "[blank]")


def with_book_notes(base, notes):
    if not (notes or "").strip():
        return base
    return (f"{base}\n\n## Book-specific notes\nThe following notes apply to this particular book. "
            f"Follow them in addition to the rules above:\n{notes.strip()}")


def token():
    out = subprocess.run(["npx", "wrangler", "auth", "token", "--json"], cwd=os.path.join(REPO, "apps/api"),
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)["token"]


def mime(path):
    head = open(path, "rb").read(8)
    return "image/png" if head.startswith(b"\x89PNG") else "image/jpeg"


def body_for(fmt, model, prompt, img_b64, mt):
    if fmt == "gemini":
        gen = {"maxOutputTokens": 16000}
        if "pro" in model:
            gen["thinkingConfig"] = {"thinkingLevel": "low"}
        else:
            gen["thinkingConfig"] = {"thinkingLevel": "minimal"}
        return {"systemInstruction": {"parts": [{"text": prompt}]},
                "contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": mt, "data": img_b64}},
                                                         {"text": "Transcribe this page."}]}],
                "generationConfig": gen}
    return {"messages": [{"role": "system", "content": prompt},
                         {"role": "user", "content": [
                             {"type": "image_url", "image_url": {"url": f"data:{mt};base64,{img_b64}"}},
                             {"type": "text", "text": "Transcribe this page."}]}],
            "max_tokens": 6000, "temperature": 0,
            # Gemma 4 / Qwen think by default; a transcription needs no reasoning.
            "chat_template_kwargs": {"enable_thinking": False}}


def parse(fmt, data):
    r = data.get("result", data)
    if fmt == "gemini":
        cand = (r.get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []) if not p.get("thought"))
        u = r.get("usageMetadata", {})
        return text, {"in": u.get("promptTokenCount"), "out": (u.get("candidatesTokenCount") or 0) + (u.get("thoughtsTokenCount") or 0)}
    if "choices" in r:
        text = r["choices"][0]["message"].get("content") or ""
    else:
        text = r.get("response") or ""
    u = r.get("usage", {})
    return text, {"in": u.get("prompt_tokens"), "out": u.get("completion_tokens")}


def run(model, rows, tok, workers):
    fmt = MODELS[model]
    slug = model.lstrip("@").replace("/", "_")
    outdir = os.path.join(DATA, "out", slug)
    os.makedirs(outdir, exist_ok=True)
    base = system_prompt()
    # Cloudflare-hosted (@cf/...) models take the model in the path; third-party
    # models go to /ai/run with {"model", "input"} in the body.
    hosted = model.startswith("@cf/")
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run" + (f"/{model}" if hosted else "")

    def one(row):
        fid = row["file_id"]
        dest = os.path.join(outdir, f"{fid}.md")
        if os.path.exists(dest):
            return "skip"
        img = os.path.join(DATA, "pages", f"{fid}.jpg")
        b64 = base64.b64encode(open(img, "rb").read()).decode()
        body = body_for(fmt, model, with_book_notes(base, row.get("ocr_instructions")), b64, mime(img))
        payload = json.dumps(body if hosted else {"model": model, "input": body}).encode()
        for attempt in range(3):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=payload, method="POST", headers={
                    "Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
                data = json.load(urllib.request.urlopen(req, timeout=300))
                text, usage = parse(fmt, data)
                open(dest, "w").write(text.strip() + "\n")
                with open(os.path.join(outdir, "usage.jsonl"), "a") as f:
                    f.write(json.dumps({"file_id": fid, **usage, "secs": round(time.time() - t0, 1)}) + "\n")
                return "ok"
            except urllib.error.HTTPError as e:
                err = f"{e.code} {e.read().decode()[:300]}"
            except Exception as e:  # network / parse
                err = repr(e)[:300]
            time.sleep(5 * (attempt + 1))
        print(f"FAIL {fid}: {err}", file=sys.stderr)
        return "fail"

    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, rows))
    print(model, {k: res.count(k) for k in set(res)})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=list(MODELS) + ["all"])
    ap.add_argument("--limit", type=int)
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    rows = json.load(open(os.path.join(DATA, "sample.json")))
    if a.only:
        rows = [r for r in rows if r["file_id"] == a.only]
    if a.limit:
        rows = rows[: a.limit]
    tok = token()
    for m in (MODELS if a.model == "all" else [a.model]):
        run(m, rows, tok, a.workers)
