"""Train a page-number reader on the top and bottom strips of the library's pages.

Each strip is read left to right by a CRNN (MobileNetV3-small features with
horizontal stride reduced, then a BiLSTM) trained with CTC to output the digits
of the printed page number in that strip, or nothing. Whole books are held out.

FINAL=1 trains on every page for shipping.
"""

import json
import os
import random
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision
from PIL import Image, ImageFilter, ImageOps

from model_def import H, W, STRIP, PageNumberNet, decode
from split import is_test
from synth import header_titles, make

random.seed(0)
torch.manual_seed(0)
DEV = "cuda"
PAGE_W = 768  # pages are resized to this width before cutting strips
BAND = 0.32  # keep this much of the page at top and bottom for augmentation

labels = json.load(open("data/labels.json"))
names = sorted(n for n in labels if os.path.exists(f"../orientation/data/pages/{n}"))


def load(name: str) -> tuple[np.ndarray, np.ndarray]:
    im = ImageOps.exif_transpose(Image.open(f"../orientation/data/pages/{name}")).convert("L")
    w, h = im.size
    im = im.resize((PAGE_W, round(h * PAGE_W / w)), Image.BILINEAR)
    a = np.asarray(im)
    b = round(a.shape[0] * BAND)
    return a[:b].copy(), a[-b:].copy(), a.shape[0]


t0 = time.time()
bands = {n: load(n) for n in names}
FINAL = os.environ.get("FINAL") == "1"
# SPLIT=pages holds out 1 in 5 pages of every book instead of whole books:
# how well it reads new pages of a book it has already seen.
if os.environ.get("SPLIT") == "pages":
    test = [n for i, n in enumerate(names) if i % 5 == 0]
    train = [n for n in names if n not in set(test)]
else:
    train = names if FINAL else [n for n in names if not is_test(labels[n]["book"])]
    test = [n for n in names if is_test(labels[n]["book"])]
print(f"loaded {len(bands)} pages in {time.time() - t0:.0f}s; train={len(train)} test={len(test)}")
print("test books:", sorted({labels[n]["book"] for n in test}))
titles = header_titles({labels[n]["book"] for n in train})
SYNTH = float(os.environ.get("SYNTH", 0.5))  # share of each batch that is synthetic


def strip(name: str, top: bool, frac: float, jitter: bool) -> np.ndarray:
    """Cut the top or bottom `frac` of the page, as the app does, and resize to H x W."""
    tb, bb, page_h = bands[name]
    band = tb if top else bb
    h = min(round(page_h * frac), band.shape[0])
    a = band[:h] if top else band[-h:]
    im = Image.fromarray(a)
    if jitter:
        # Scanner crops vary: shift/trim the sides a little, tilt slightly,
        # and vary contrast, blur and JPEG quality.
        w = im.width
        l, r = random.randint(0, int(w * 0.04)), random.randint(0, int(w * 0.04))
        im = im.crop((l, 0, w - r, im.height))
        if random.random() < 0.5:
            im = im.rotate(random.uniform(-2, 2), resample=Image.BILINEAR, fillcolor=255)
        if random.random() < 0.3:
            im = im.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 1.0)))
    im = im.resize((W, H), Image.BILINEAR)
    a = np.asarray(im).astype(np.float32)
    if jitter:
        a = np.clip((a - 128) * random.uniform(0.7, 1.3) + 128 + random.uniform(-25, 25), 0, 255)
    return a.astype(np.uint8)


def target(name: str, top: bool) -> str:
    return labels[name]["top" if top else "bottom"]


def batch(pool, n):
    xs, ys = [], []
    for _ in range(n):
        name = random.choice(pool)
        frac = random.uniform(0.14, 0.24)
        if random.random() < SYNTH:
            # Background: this page's strip that has no page number.
            empty_top = not labels[name]["top"]
            bg = strip(name, empty_top, frac, jitter=True)
            img, num = make(bg, titles, top=random.random() < 0.65)
            xs.append(img)
            ys.append(num)
        else:
            top = random.random() < 0.5
            xs.append(strip(name, top, frac, jitter=True))
            ys.append(target(name, top))
    x = torch.from_numpy(np.stack(xs)).to(DEV)
    flat = torch.tensor([int(c) + 1 for y in ys for c in y], dtype=torch.long)
    lens = torch.tensor([len(y) for y in ys], dtype=torch.long)
    return x, flat, lens


@torch.no_grad()
def read_page(model, name: str) -> tuple[str, float, str, float]:
    x = torch.from_numpy(np.stack([strip(name, True, STRIP, False), strip(name, False, STRIP, False)])).to(DEV)
    probs = model(x).cpu().numpy()
    (t, tc), (b, bc) = decode(probs[0]), decode(probs[1])
    return t, tc, b, bc


def pick(t, tc, b, bc) -> tuple[str, float]:
    """The page's number: the strip that read one; both did -> the surer one."""
    if t and (not b or tc >= bc):
        return t, tc
    if b:
        return b, bc
    return "", max(tc, bc)


@torch.no_grad()
def evaluate(model, pool):
    model.eval()
    out = []
    for n in pool:
        t, tc, b, bc = read_page(model, n)
        num, conf = pick(t, tc, b, bc)
        truth = labels[n]["top"] or labels[n]["bottom"]
        out.append((n, truth, num, conf))
    model.train()
    return out


def report(results, cutoffs=(0.0, 0.5, 0.7, 0.8, 0.9, 0.95)):
    total = len(results)
    for c in cutoffs:
        accepted = [r for r in results if r[2] and r[3] >= c]
        right = sum(r[1] == r[2] for r in accepted)
        wrong = len(accepted) - right
        print(
            f"   cutoff {c:.2f}: filled {len(accepted) / total:6.1%}  right {right / total:6.1%}"
            f"  WRONG {wrong / total:5.1%} ({wrong})"
        )


model = PageNumberNet(pretrained=True).to(DEV)
STEPS, BS = int(os.environ.get("STEPS", 6000)), 48
opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=STEPS, pct_start=0.15)
ctc = nn.CTCLoss(blank=0, zero_infinity=True)
t0 = time.time()
for step in range(1, STEPS + 1):
    x, flat, lens = batch(train, BS)
    logp = model(x, log=True)  # (B, T, C)
    T = logp.shape[1]
    loss = ctc(logp.permute(1, 0, 2), flat, torch.full((len(lens),), T, dtype=torch.long), lens)
    opt.zero_grad()
    loss.backward()
    nn.utils.clip_grad_norm_(model.parameters(), 5.0)
    opt.step()
    sched.step()
    if step % 500 == 0 and not FINAL:
        res = evaluate(model, test)
        acc = sum(r[1] == r[2] for r in res) / len(res)
        print(f"step {step} loss {loss.item():.3f} | held-out page accuracy {acc:.1%} | {time.time() - t0:.0f}s")
    elif step % 500 == 0:
        print(f"step {step} loss {loss.item():.3f} | {time.time() - t0:.0f}s")
print(f"train time {time.time() - t0:.0f}s")

torch.save(model.state_dict(), "data/pagenum.pt")
if not FINAL:
    res = evaluate(model, test)
    print("\nheld-out books, per page (filled = number put in the box):")
    report(res)
    for book in sorted({labels[n]["book"] for n in test}):
        sub = [r for r in res if labels[r[0]]["book"] == book]
        acc = sum(r[1] == r[2] for r in sub) / len(sub)
        print(f"   {book[:30]:30} {len(sub):4d} pages  top-guess right {acc:.1%}")
    wrong = [r for r in res if r[1] != r[2]]
    json.dump(wrong, open("data/wrong.json", "w"), ensure_ascii=False)
    print("wrong examples (truth, read, conf):", [(r[1], r[2], round(r[3], 2)) for r in wrong[:30]])
