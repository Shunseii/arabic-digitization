import { requireOptionalNativeModule } from "expo";

export interface NativeGrayImage {
  gray: Uint8Array;
  width: number;
  height: number;
}

interface PagePixelsModule {
  grayscale(
    uri: string,
    width: number | null,
    height: number | null,
  ): Promise<NativeGrayImage>;
}

/**
 * Native page decoder (Android only). Null where it isn't built in, e.g. on
 * iOS or an app binary older than the module; callers fall back to JS.
 */
export const PagePixels =
  requireOptionalNativeModule<PagePixelsModule>("PagePixels");
