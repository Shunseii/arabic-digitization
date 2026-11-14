# Page orientation model

The mobile app turns scanned pages upright before upload (`apps/mobile/src/lib/orientation.ts`).
ML Kit's document scanner often picks the wrong "up", per shot, and offers no setting for it.
This folder trains the small classifier the app ships.

The model is MobileNetV3-small (ImageNet weights) trained to say whether a page is turned
0°, 90°, 180° or 270°. Labels are free: every stored page is upright, so training rotates
crops by a random multiple of 90° and asks the model which one.

## Results (Nov 2026, 1,630 pages)

- Held-out works (6 works never seen in training, any edition), 568 pages × 4 rotations:
  99.0% correct with 5-crop voting. Body text was 100%; every miss was a manuscript plate
  or a sparse index table in one book.
- Through the app's exact pipeline (`check_app_pipeline.py`): 98.9% top guess correct.
  With the app's 0.6 confidence cutoff, 98.8% of pages end upright.
- For comparison, PaddleOCR's `PP-LCNet_x1_0_doc_ori` got 58% on these pages: it finds the
  axis but can't tell up from down in Arabic.
- 6.1 MB ONNX. About 0.85 s per page in a debug build on the emulator.

## Retrain

Needs a CUDA GPU (training takes about 2 minutes) and the API credentials.

```sh
cd tools/orientation
uv venv .venv
uv pip install --python .venv/bin/python torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv/bin/python pillow numpy onnx onnxruntime onnxscript

# 1. Download every stored page into data/ (git-ignored).
OCR_URL=$(op read --account my.1password.com "op://Arabic Digitization/API Connection Vars/ARABIC_OCR_URL") \
OCR_KEY=$(op read --account my.1password.com "op://Arabic Digitization/API Connection Vars/ARABIC_OCR_KEY") \
python3 fetch_pages.py

# 2. Check the recipe still generalises (trains without the held-out works).
.venv/bin/python train.py
.venv/bin/python export.py data/heldout.onnx
.venv/bin/python check_app_pipeline.py data/heldout.onnx

# 3. Train on every page and export into the app.
FINAL=1 .venv/bin/python train.py
.venv/bin/python export.py
```

The exported model is `apps/mobile/assets/models/orientation.onnx`. It takes the five
320 px grayscale crops the app cuts from a page (`uint8 [N, 320, 320]`) and returns the
voted probabilities for each rotation, so the app does no image maths beyond cropping.
A new model can ship as an over-the-air update; it needs no native build.

If you change the crop size, positions or page scale, change them in both
`apps/mobile/src/lib/orientation.ts` and `check_app_pipeline.py`.
