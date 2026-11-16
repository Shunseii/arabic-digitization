"""Page-number reader shared by training and export.

Input: uint8 grayscale strips (N, H, W) cut from the top or bottom STRIP of a
page. Output: per-column class probabilities (N, T, 11); class 0 is the CTC
blank and class d+1 is digit d. Digits read left to right, as printed.
"""

import numpy as np
import torch
import torch.nn as nn
import torchvision

H, W = 192, 768
STRIP = 0.18  # fraction of the page height in each strip
CLASSES = 11


class PageNumberNet(nn.Module):
    def __init__(self, pretrained: bool = False):
        super().__init__()
        weights = "IMAGENET1K_V1" if pretrained else None
        feats = torchvision.models.mobilenet_v3_small(weights=weights).features
        # Keep horizontal resolution (stride 8 instead of 32) so each digit
        # spans about two output columns; halve only the height in these
        # blocks. Finer than this (stride 4) leaves CTC stuck emitting blanks.
        for i in (4, 9):
            for m in feats[i].modules():
                if isinstance(m, nn.Conv2d) and m.stride == (2, 2):
                    m.stride = (2, 1)
        self.features = feats
        # A BiLSTM here trained far slower; dilated 1-D convs give the same
        # left/right context along the strip.
        self.seq = nn.Sequential(
            nn.Conv1d(576, 128, 1),
            nn.ReLU(),
            nn.Conv1d(128, 128, 5, padding=2),
            nn.ReLU(),
            nn.Conv1d(128, 128, 5, padding=4, dilation=2),
            nn.ReLU(),
        )
        self.head = nn.Conv1d(128, CLASSES, 1)
        self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    def forward(self, strips: torch.Tensor, log: bool = False) -> torch.Tensor:
        x = strips.float().div(255).unsqueeze(1).repeat(1, 3, 1, 1)
        x = (x - self.mean) / self.std
        # Max over height: the number fills one row of the feature map.
        f = self.features(x).amax(2)  # (N, 576, T)
        logits = self.head(self.seq(f)).transpose(1, 2)  # (N, T, CLASSES)
        return logits.log_softmax(-1) if log else logits.softmax(-1)


def decode(probs: np.ndarray) -> tuple[str, float]:
    """Greedy CTC decode of (T, C) probabilities -> (digits, confidence).

    Confidence is the weakest column's top probability: one unsure column
    (a digit that might be missing or extra) makes the whole read unsure.
    """
    best = probs.argmax(1)
    out, prev = [], 0
    for k in best:
        if k != prev and k != 0:
            out.append(str(k - 1))
        prev = k
    return "".join(out), float(probs.max(1).min())
