import { Asset } from "expo-asset";
import { InferenceSession } from "onnxruntime-react-native";

/**
 * Lazily loads a bundled .onnx model once; a failed load is retried on the
 * next call rather than cached.
 */
export const modelLoader = (module: number) => {
  let session: Promise<InferenceSession> | null = null;
  return (): Promise<InferenceSession> => {
    session ??= (async () => {
      const [asset] = await Asset.loadAsync(module);
      const uri = asset?.localUri;
      if (!uri) throw new Error("Model asset missing");
      return InferenceSession.create(uri.replace(/^file:\/\//, ""));
    })().catch((err) => {
      session = null;
      throw err;
    });
    return session;
  };
};
