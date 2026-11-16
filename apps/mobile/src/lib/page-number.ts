import { Tensor } from "onnxruntime-react-native";
import { modelLoader } from "@/lib/onnx";
import { type GrayImage, grayscaleImage } from "@/lib/pixels";

/**
 * On-device printed page number. A small reader (trained in
 * tools/page-number) looks at the top and bottom strips of an upright page
 * and reads the digits printed there, if any.
 *
 * These numbers must match tools/page-number/check_app_pipeline.py.
 */
const PAGE_WIDTH = 768;
const STRIP = 0.18;
const STRIP_H = 192;
const STRIP_W = 768;
const CLASSES = 11; // CTC blank + digits 0-9

export interface PageNumberRead {
  value: number;
  /** Weakest column's probability in the read (0-1). */
  confidence: number;
}

const loadModel = modelLoader(require("../../assets/models/page-number.onnx"));

/** Rows [top, top + rows) of the page, resized to the strip size (bilinear). */
const stripAt = ({
  page,
  top,
  rows,
  out,
  offset,
}: {
  page: GrayImage;
  top: number;
  rows: number;
  out: Uint8Array;
  offset: number;
}) => {
  const sy = rows / STRIP_H;
  const sx = page.width / STRIP_W;
  for (let y = 0; y < STRIP_H; y++) {
    const fy = Math.max((y + 0.5) * sy - 0.5, 0);
    const y0 = Math.min(Math.floor(fy), rows - 1);
    const y1 = Math.min(y0 + 1, rows - 1);
    const wy = fy - y0;
    for (let x = 0; x < STRIP_W; x++) {
      const fx = Math.max((x + 0.5) * sx - 0.5, 0);
      const x0 = Math.min(Math.floor(fx), page.width - 1);
      const x1 = Math.min(x0 + 1, page.width - 1);
      const wx = fx - x0;
      const at = (r: number, c: number) =>
        page.gray[(top + r) * page.width + c] as number;
      const v =
        (at(y0, x0) * (1 - wx) + at(y0, x1) * wx) * (1 - wy) +
        (at(y1, x0) * (1 - wx) + at(y1, x1) * wx) * wy;
      out[offset + y * STRIP_W + x] = Math.round(v);
    }
  }
};

/** Greedy CTC decode of one strip's (T, CLASSES) probabilities. */
const decode = (
  probs: Float32Array,
  start: number,
  steps: number,
): { digits: string; confidence: number } => {
  let digits = "";
  let prev = 0;
  let confidence = 1;
  for (let t = 0; t < steps; t++) {
    const row = start + t * CLASSES;
    let best = 0;
    for (let k = 1; k < CLASSES; k++)
      if ((probs[row + k] as number) > (probs[row + best] as number)) best = k;
    confidence = Math.min(confidence, probs[row + best] as number);
    if (best !== prev && best !== 0) digits += String(best - 1);
    prev = best;
  }
  return { digits, confidence };
};

/**
 * The printed page number, or null when neither strip has one. Never throws:
 * a failed read is just "no number", so numbering falls back to the sequence.
 */
export const readPageNumber = async (
  uri: string,
): Promise<PageNumberRead | null> => {
  try {
    const [model, page] = await Promise.all([
      loadModel(),
      grayscaleImage({ uri, size: { width: PAGE_WIDTH }, halving: true }),
    ]);
    const rows = Math.round(page.height * STRIP);
    const strips = new Uint8Array(2 * STRIP_H * STRIP_W);
    stripAt({ page, top: 0, rows, out: strips, offset: 0 });
    stripAt({
      page,
      top: page.height - rows,
      rows,
      out: strips,
      offset: STRIP_H * STRIP_W,
    });
    const output = await model.run({
      strips: new Tensor("uint8", strips, [2, STRIP_H, STRIP_W]),
    });
    const probs = output.probs;
    if (!probs) return null;
    const steps = probs.dims[1] as number;
    const data = probs.data as Float32Array;
    const top = decode(data, 0, steps);
    const bottom = decode(data, steps * CLASSES, steps);
    // The strip that read a number; if both did, the surer one.
    const best =
      top.digits && (!bottom.digits || top.confidence >= bottom.confidence)
        ? top
        : bottom;
    if (!best.digits) return null;
    return {
      value: Number.parseInt(best.digits, 10),
      confidence: best.confidence,
    };
  } catch (err) {
    console.warn("[page-number] read failed", err);
    return null;
  }
};
