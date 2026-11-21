import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { decode as decodeJpeg } from "jpeg-js";
import { PagePixels } from "../../modules/page-pixels";

export interface GrayImage {
  gray: Uint8Array;
  width: number;
  height: number;
}

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export type TargetSize = { width: number } | { height: number };

/**
 * The image resized to `size` (one side; aspect kept), as grayscale pixels
 * (ITU-R 601 luma, as PIL computes it). With `halving`, it shrinks in halving
 * steps first: Android's resize doesn't antialias, and one big step drops
 * thin strokes such as digits.
 */
export const grayscaleImage = async ({
  uri,
  size,
  halving = false,
}: {
  uri: string;
  size: TargetSize;
  halving?: boolean;
}): Promise<GrayImage> => {
  if (PagePixels) {
    try {
      return await PagePixels.grayscale(
        uri,
        "width" in size ? size.width : null,
        "height" in size ? size.height : null,
      );
    } catch (err) {
      console.warn("[pixels] native decode failed, using JS", err);
    }
  }
  return grayscaleImageJs({ uri, size, halving });
};

/**
 * JS fallback (iOS, or a binary without the native module): resize natively,
 * then decode the JPEG in JS. Blocks the JS thread for most of a second.
 */
const grayscaleImageJs = async ({
  uri,
  size,
  halving,
}: {
  uri: string;
  size: TargetSize;
  halving: boolean;
}): Promise<GrayImage> => {
  const context = ImageManipulator.manipulate(uri);
  if (halving) {
    const original = await ImageManipulator.manipulate(uri).renderAsync();
    let w = original.width;
    let h = original.height;
    const tooBig = () =>
      "width" in size ? w >= size.width * 2 : h >= size.height * 2;
    while (tooBig()) {
      w = Math.floor(w / 2);
      h = Math.floor(h / 2);
      context.resize({ width: w, height: h });
    }
  }
  const resized = await context.resize(size).renderAsync();
  const saved = await resized.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.9,
    base64: true,
  });
  if (!saved.base64) throw new Error("No pixels returned for image");
  const {
    data,
    width: w,
    height: h,
  } = decodeJpeg(base64ToBytes(saved.base64), {
    useTArray: true,
    formatAsRGBA: true,
  });
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] =
      ((data[p] as number) * 19595 +
        (data[p + 1] as number) * 38470 +
        (data[p + 2] as number) * 7471 +
        0x8000) >>
      16;
  }
  return { gray, width: w, height: h };
};
