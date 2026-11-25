"""Download the sampled pages' scans and current (Gemini 3.1 Pro preview) text.

Reads data/sample.json (rows: file_id, book_id, book_title, page_number,
ocr_instructions) and writes data/pages/<file_id>.jpg and
data/out/gemini-3.1-pro-preview/<file_id>.md.

API URL and key come from the ARABIC_OCR_URL / ARABIC_OCR_KEY environment
variables (the same values `corpus auth login` stores in the OS keychain).
"""
import json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def secrets():
    url, key = os.environ.get("ARABIC_OCR_URL"), os.environ.get("ARABIC_OCR_KEY")
    if not (url and key):
        raise SystemExit("Set ARABIC_OCR_URL and ARABIC_OCR_KEY (see README.md, Setup).")
    return url, key


BASE, KEY = secrets()
H = {"Authorization": f"Bearer {KEY}", "User-Agent": "ocr-eval"}


def get(path):
    req = urllib.request.Request(BASE.rstrip("/") + path, headers=H)
    return urllib.request.urlopen(req, timeout=60).read()


def fetch(row):
    bid, fid = row["book_id"], row["file_id"]
    img = os.path.join(DATA, "pages", f"{fid}.jpg")
    txt = os.path.join(DATA, "out", "gemini-3.1-pro-preview", f"{fid}.md")
    if not os.path.exists(img):
        open(img, "wb").write(get(f"/api/books/{bid}/files/{fid}/image"))
    if not os.path.exists(txt):
        body = get(f"/api/books/{bid}/files/{fid}/text").decode()
        try:
            body = json.loads(body).get("text", body)
        except json.JSONDecodeError:
            pass
        open(txt, "w").write(body)
    return fid


os.makedirs(os.path.join(DATA, "pages"), exist_ok=True)
os.makedirs(os.path.join(DATA, "out", "gemini-3.1-pro-preview"), exist_ok=True)
rows = json.load(open(os.path.join(DATA, "sample.json")))
with ThreadPoolExecutor(8) as ex:
    done = list(ex.map(fetch, rows))
print("fetched", len(done), "pages")
