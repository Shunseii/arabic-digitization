# Page number reader

The mobile app reads each scanned page's printed number before upload
(`apps/mobile/src/lib/page-number.ts`). Numbering on the scan screen then works like this
(`apps/mobile/src/lib/page-numbering.ts`):

1. A number the user typed always wins.
2. Otherwise, the number read from the page is used if the reader is sure (0.97, or 0.99
   for the first page of a scan) and it is within 5 of the sequence.
3. Otherwise, the previous page's number + 1, as before.

This folder trains the reader.

## How it works

The reader looks at the top and bottom 18% of the upright page (two 192×768 strips) and
reads the digits printed there, left to right, or nothing. It is MobileNetV3-small with its
horizontal stride cut to 8, then a few 1-D convolutions, trained with CTC.

Labels come from the stored transcriptions: Gemini keeps the running header (first block,
before `---`) and a lone footer number (last line), so `labels.py` takes the printed number
and its position from there, checked against the typed page number (allowing a whole-book
offset, e.g. one book was typed one higher throughout).

Half of every training batch is synthetic (`synth.py`): a real number-free strip with a
running header or footer drawn in, carrying a random number. Without it the model memorised
"this header means page 186" instead of reading digits.

## Results (Nov 2026, 1,540 labelled pages)

- **New pages of books it has seen** (1 in 5 pages held out from every book), through the
  app's image pipeline (`check_app_pipeline.py`): at the app's limits it fills about 55% of
  pages, with 0–1 wrong in 308. 12 of 16 books read 100%; الألفاظ الكتابية (boxed numbers)
  and القراءة الراشدة (ornate frames, footers) about 50%, mostly ٢/٣ and ٥/٦ swaps that the
  confidence cutoff rejects.
- **Books it has never seen** (whole books held out): about 85% on books whose number style
  resembles a training book, but poor on a new style (boxed numbers: 13%). New books mostly
  fall back to the sequence until the model is retrained with some of their pages.
- 4.7 MB ONNX. About 1.2 s per page in a debug build on the emulator.

## Retrain

Uses the orientation tool's venv and page images (`../orientation`; see its README to set
them up), plus `fonttools`.

```sh
cd tools/page-number
OCR_URL=$(op read --account my.1password.com "op://Arabic Digitization/API Connection Vars/ARABIC_OCR_URL") \
OCR_KEY=$(op read --account my.1password.com "op://Arabic Digitization/API Connection Vars/ARABIC_OCR_KEY") \
python3 fetch_texts.py          # transcriptions + any missing page images
python3 labels.py               # printed number and position per page

# Check: hold out 1 in 5 pages per book (SPLIT=pages) or whole books (default).
SPLIT=pages STEPS=15000 ../orientation/.venv/bin/python train.py
../orientation/.venv/bin/python check_app_pipeline.py data/pagenum.pt

# Ship: train on every page (~35 min on an RTX 5060 Ti) and export into the app.
FINAL=1 STEPS=15000 ../orientation/.venv/bin/python train.py
../orientation/.venv/bin/python export.py
```

A new model ships as an over-the-air update; it needs no native build. If you change the
strip size or position, change them in `model_def.py`, `check_app_pipeline.py` and
`apps/mobile/src/lib/page-number.ts`.
