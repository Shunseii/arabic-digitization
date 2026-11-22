# OCR model evaluation

Compares OCR models, and line-position (T151) methods, on a fixed sample of
pages from the corpus. Results from the first run (2026-11-21) are in task
T188's notes.

## Setup

```sh
uv venv .venv --python 3.12
uv pip install -p .venv nuqta-ocr rapidfuzz anthropic numpy opencv-python-headless pillow
corpus auth login          # API URL + key for fetch.py
```

`data/` (scans, outputs, overlays) is git-ignored.

## Steps

1. `data/sample.json`: pick pages from D1 (see T188 for the query), rows of
   `file_id, book_id, book_title, page_number, ocr_instructions`.
2. `python3 fetch.py`: scans to `data/pages/`, current text to
   `data/out/gemini-3.1-pro-preview/`.
3. Transcribe with candidates:
   - `python3 run_cloud.py <model>`: Workers AI (needs `npx wrangler login`;
     third-party models need AI Gateway credits).
   - `.venv/bin/python run_ocr_claude.py <model>`: Claude (key from 1Password,
     cached in `/run/user/1000/ad-secrets/anthropic`; delete it afterwards).
   - `.venv/bin/python run_nuqta.py`: Nuqta-Arabic-OCR on the local GPU.
4. `.venv/bin/python score.py`: character/word error rates, diacritic errors,
   layout match. Hand-corrected pages in `data/ref/<file_id>.md` are used as
   the reference instead of Gemini and reported separately.

## Line positions

- `run_lines_cloud.py <model>` (Workers AI, or Gemini direct with the key in
  `apps/api/.dev.vars`) and `run_lines_claude.py <model>` ask for a box per
  numbered line. Overlays go to `data/lines/overlay/<model>/`.
- `run_nuqta_lines.py` and `lines_cv.py` find printed rows by image processing.
- `score_lines.py` checks each box against Nuqta's rows. The check is weak on
  two-column pages and diagrams, so look at the overlays too.
