import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Tensor } from "onnxruntime-react-native";
import { modelLoader } from "@/lib/onnx";
import { type GrayImage, grayscaleImage } from "@/lib/pixels";

/**
 * On-device page orientation. ML Kit's scanner picks "up" per shot and often
 * gets it wrong, so each scanned page is checked by a small classifier
 * (trained in tools/orientation) and turned upright before review.
 *
 * These numbers must match tools/orientation/check_app_pipeline.py.
 */
const SHORT_SIDE = 533;
const CROP = 320;
const CROP_CENTRES: [number, number][] = [
  [0.5, 0.5],
  [0.3, 0.3],
  [0.3, 0.7],
  [0.7, 0.3],
  [0.7, 0.7],
];
/** Below this the page is left as scanned rather than guessed. */
const MIN_CONFIDENCE = 0.6;
const JPEG_QUALITY = 0.95;

const loadModel = modelLoader(require("../../assets/models/orientation.onnx"));

/** Page shrunk to the model's scale (short side SHORT_SIDE), in grayscale. */
const grayscalePage = async (uri: string): Promise<GrayImage> => {
  const original = await ImageManipulator.manipulate(uri).renderAsync();
  const portrait = original.width <= original.height;
  return grayscaleImage({
    uri,
    size: portrait ? { width: SHORT_SIDE } : { height: SHORT_SIDE },
  });
};

const cropsFor = ({ gray, width, height }: GrayImage): Uint8Array => {
  const out = new Uint8Array(CROP_CENTRES.length * CROP * CROP);
  CROP_CENTRES.forEach(([fy, fx], c) => {
    const top = Math.min(
      Math.max(Math.round(fy * height - CROP / 2), 0),
      height - CROP,
    );
    const left = Math.min(
      Math.max(Math.round(fx * width - CROP / 2), 0),
      width - CROP,
    );
    for (let row = 0; row < CROP; row++) {
      const from = (top + row) * width + left;
      out.set(gray.subarray(from, from + CROP), (c * CROP + row) * CROP);
    }
  });
  return out;
};

/**
 * Clockwise degrees (0, 90, 180 or 270) that turn the page upright, or 0
 * when the model isn't confident.
 */
export const detectRotation = async (uri: string): Promise<number> => {
  const [model, page] = await Promise.all([loadModel(), grayscalePage(uri)]);
  const input = new Tensor("uint8", cropsFor(page), [
    CROP_CENTRES.length,
    CROP,
    CROP,
  ]);
  const output = await model.run({ crops: input });
  const probs = output.probs?.data as Float32Array | undefined;
  if (!probs) return 0;
  let best = 0;
  for (let k = 1; k < 4; k++)
    if ((probs[k] as number) > (probs[best] as number)) best = k;
  // Class k means the content is turned k*90° counter-clockwise.
  return (probs[best] as number) >= MIN_CONFIDENCE ? best * 90 : 0;
};

/** Writes a copy of the image turned `degrees` clockwise. */
export const rotateImage = async ({
  uri,
  degrees,
}: {
  uri: string;
  degrees: number;
}): Promise<string> => {
  const rotated = await ImageManipulator.manipulate(uri)
    .rotate(degrees)
    .renderAsync();
  const saved = await rotated.saveAsync({
    format: SaveFormat.JPEG,
    compress: JPEG_QUALITY,
  });
  return saved.uri;
};

/**
 * The page turned upright. Never throws: if anything fails the page is
 * returned as scanned, so a broken check can't block scanning.
 */
export const uprightPage = async (
  uri: string,
): Promise<{ uri: string; rotated: number }> => {
  try {
    const degrees = await detectRotation(uri);
    if (degrees === 0) return { uri, rotated: 0 };
    return { uri: await rotateImage({ uri, degrees }), rotated: degrees };
  } catch (err) {
    console.warn("[orientation] check failed", err);
    return { uri, rotated: 0 };
  }
};
