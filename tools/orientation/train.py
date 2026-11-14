"""Train a page-orientation classifier (0/90/180/270) on the library's upright scans.

Every stored page is upright, so labels come free: rotate a crop by k*90 deg
and ask the model for k. Whole works are held out for testing.
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
from PIL import Image, ImageOps

random.seed(0)
torch.manual_seed(0)
DEV = "cuda"
SHORT = 640  # page resized so its short side is this many px
CROP = 384  # crop taken from that page...
INPUT = 320  # ...then resized to the network input
from train_split import is_test

meta = json.load(open("data/meta.json"))
names = sorted(n for n in meta if os.path.exists(f"data/pages/{n}"))


def load(name: str) -> np.ndarray:
    im = ImageOps.exif_transpose(Image.open(f"data/pages/{name}")).convert("L")
    w, h = im.size
    s = SHORT / min(w, h)
    return np.asarray(im.resize((round(w * s), round(h * s)), Image.BILINEAR))


t0 = time.time()
pages = {n: load(n) for n in names}
# FINAL=1 trains the shipped model on every page (after a held-out run has
# shown the recipe generalises).
FINAL = os.environ.get("FINAL") == "1"
train = names if FINAL else [n for n in names if not is_test(meta[n])]
test = [n for n in names if is_test(meta[n])]
print(f"loaded {len(pages)} pages in {time.time() - t0:.0f}s; train={len(train)} test={len(test)}")
print("test works:", sorted({meta[n] for n in test}))

MEAN = torch.tensor([0.485, 0.456, 0.406], device=DEV).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225], device=DEV).view(1, 3, 1, 1)


def to_input(crops: torch.Tensor) -> torch.Tensor:
    """uint8 grayscale (B,H,W) -> normalised float (B,3,INPUT,INPUT)."""
    x = crops.to(DEV).float().div(255).unsqueeze(1)
    x = F.interpolate(x, size=(INPUT, INPUT), mode="bilinear", align_corners=False)
    return (x.repeat(1, 3, 1, 1) - MEAN) / STD


def random_crop(a: np.ndarray) -> np.ndarray:
    h, w = a.shape
    size = random.randint(int(CROP * 0.8), int(CROP * 1.25))
    size = min(size, h, w)
    y, x = random.randint(0, h - size), random.randint(0, w - size)
    c = a[y : y + size, x : x + size]
    if size != CROP:
        c = np.asarray(Image.fromarray(c).resize((CROP, CROP), Image.BILINEAR))
    return c


def batch(pool, n):
    crops, labels = [], []
    for _ in range(n):
        c = random_crop(pages[random.choice(pool)])
        k = random.randrange(4)
        crops.append(np.rot90(c, k).copy())
        labels.append(k)
    x = torch.from_numpy(np.stack(crops))
    return to_input(x), torch.tensor(labels, device=DEV)


def eval_crops(a: np.ndarray) -> np.ndarray:
    """Five fixed crops: centre plus four spread across the text block."""
    h, w = a.shape
    s = min(CROP, h, w)
    out = []
    for fy, fx in [(0.5, 0.5), (0.3, 0.3), (0.3, 0.7), (0.7, 0.3), (0.7, 0.7)]:
        y = int(np.clip(fy * h - s / 2, 0, h - s))
        x = int(np.clip(fx * w - s / 2, 0, w - s))
        c = a[y : y + s, x : x + s]
        if s != CROP:
            c = np.asarray(Image.fromarray(c).resize((CROP, CROP), Image.BILINEAR))
        out.append(c)
    return np.stack(out)


@torch.no_grad()
def evaluate(model, pool):
    model.eval()
    conf_vote = np.zeros((4, 4), int)
    conf_single = np.zeros((4, 4), int)
    for n in pool:
        crops = eval_crops(pages[n])
        for k in range(4):
            rot = np.stack([np.rot90(c, k) for c in crops]).copy()
            p = model(to_input(torch.from_numpy(rot))).softmax(1)
            conf_single[k, p[0].argmax().item()] += 1
            conf_vote[k, p.mean(0).argmax().item()] += 1
    model.train()
    return conf_single, conf_vote


model = torchvision.models.mobilenet_v3_small(weights="IMAGENET1K_V1")
model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, 4)
model = model.to(DEV)

STEPS, BS = 1500, 64
opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=STEPS)
t0 = time.time()
for step in range(1, STEPS + 1):
    x, y = batch(train, BS)
    loss = F.cross_entropy(model(x), y, label_smoothing=0.05)
    opt.zero_grad()
    loss.backward()
    opt.step()
    sched.step()
    if step % 250 == 0:
        s, v = evaluate(model, test)
        print(
            f"step {step} loss {loss.item():.3f} | test single-crop {np.trace(s) / s.sum():.1%}"
            f" | 5-crop vote {np.trace(v) / v.sum():.1%} | {time.time() - t0:.0f}s"
        )
print(f"train time {time.time() - t0:.0f}s")

s, v = evaluate(model, test)
labels = ["upright", "rot 90", "upside down", "rot 270"]
print("\n5-crop vote confusion on held-out works (rows = truth, cols = predicted):")
for k in range(4):
    print(f"  {labels[k]:12}", " ".join(f"{c:4d}" for c in v[k]))

# Pages the vote got wrong, for a look.
model.eval()
wrong = []
with torch.no_grad():
    for n in test:
        crops = eval_crops(pages[n])
        for k in range(4):
            rot = np.stack([np.rot90(c, k) for c in crops]).copy()
            pred = model(to_input(torch.from_numpy(rot))).softmax(1).mean(0).argmax().item()
            if pred != k:
                wrong.append((n, k, pred))
json.dump(wrong, open("data/wrong.json", "w"))
print("wrong (page, true k, predicted k):", len(wrong))

torch.save(model.state_dict(), "data/orient.pt")
