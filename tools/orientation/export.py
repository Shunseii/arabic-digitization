"""Export the trained classifier for the mobile app.

The exported graph takes the raw crops the app cuts from a page and returns
one vote, so the app does no maths of its own:

  input  "crops": uint8 [N, 320, 320]  grayscale crops (N = 5 in the app)
  output "probs": float32 [4]          P(page content is turned k*90° counter-clockwise)

To make a page upright, rotate it k*90° clockwise.
"""

import os
import sys

import torch
import torch.nn as nn
import torchvision

INPUT = 320
OUT = sys.argv[1] if len(sys.argv) > 1 else "../../apps/mobile/assets/models/orientation.onnx"


class Exported(nn.Module):
    def __init__(self, net: nn.Module):
        super().__init__()
        self.net = net
        self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    def forward(self, crops: torch.Tensor) -> torch.Tensor:
        x = crops.float().div(255).unsqueeze(1).repeat(1, 3, 1, 1)
        x = (x - self.mean) / self.std
        return self.net(x).softmax(1).mean(0)


net = torchvision.models.mobilenet_v3_small()
net.classifier[-1] = nn.Linear(net.classifier[-1].in_features, 4)
net.load_state_dict(torch.load("data/orient.pt", map_location="cpu"))
model = Exported(net).eval()

os.makedirs(os.path.dirname(OUT), exist_ok=True)
torch.onnx.export(
    model,
    torch.zeros(5, INPUT, INPUT, dtype=torch.uint8),
    OUT,
    input_names=["crops"],
    output_names=["probs"],
    dynamic_axes={"crops": {0: "n"}},
    opset_version=17,
    dynamo=False,
)
print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")
