"""Export the page-number reader for the mobile app.

  input  "strips": uint8 [N, 192, 768]  grayscale strips (top and bottom of the page)
  output "probs":  float32 [N, T, 11]   per-column CTC probabilities; class 0 = blank,
                                        class d+1 = digit d, read left to right
"""

import os
import sys

import torch

from model_def import H, W, PageNumberNet

OUT = sys.argv[1] if len(sys.argv) > 1 else "../../apps/mobile/assets/models/page-number.onnx"
SRC = sys.argv[2] if len(sys.argv) > 2 else "data/pagenum.pt"

model = PageNumberNet()
model.load_state_dict(torch.load(SRC, map_location="cpu"))
model.eval()

os.makedirs(os.path.dirname(OUT), exist_ok=True)
torch.onnx.export(
    model,
    torch.zeros(2, H, W, dtype=torch.uint8),
    OUT,
    input_names=["strips"],
    output_names=["probs"],
    dynamic_axes={"strips": {0: "n"}, "probs": {0: "n"}},
    opset_version=17,
    dynamo=False,
)
print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")
