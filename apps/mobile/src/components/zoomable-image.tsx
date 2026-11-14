import { type ComponentProps, useCallback, useEffect } from "react";
import {
  Image,
  type ImageSourcePropType,
  type ImageStyle,
  type LayoutChangeEvent,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

const AnimatedImage = Animated.createAnimatedComponent(Image);

/**
 * Pinch-to-zoom image. Zoom is anchored at the fingers (the point under them
 * stays put), two fingers also pan, one finger pans while zoomed, and
 * double-tap zooms in at the tapped point or back out. Set `zoomed` to false
 * from outside to reset.
 */
export function ZoomableImage({
  source,
  style,
  resizeMode = "contain",
  zoomed = false,
  onZoomChange,
}: {
  source: ImageSourcePropType;
  style?: ImageStyle;
  resizeMode?: ComponentProps<typeof Image>["resizeMode"];
  zoomed?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  // Gesture start state: scale/translation and the content point under the
  // focal point, so it can be kept under the fingers as they move.
  const startScale = useSharedValue(1);
  const startTx = useSharedValue(0);
  const startTy = useSharedValue(0);
  const anchorX = useSharedValue(0);
  const anchorY = useSharedValue(0);

  const notifyZoom = useCallback(
    (next: boolean) => onZoomChange?.(next),
    [onZoomChange],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
    height.value = e.nativeEvent.layout.height;
  };

  // Keeps the scaled image covering the frame: no panning past its edges.
  const clamp = (value: number, s: number, size: number) => {
    "worklet";
    const max = ((s - 1) * size) / 2;
    return Math.min(Math.max(value, -max), max);
  };

  const animateTo = (s: number, x: number, y: number) => {
    "worklet";
    scale.value = withTiming(s);
    tx.value = withTiming(clamp(x, s, width.value));
    ty.value = withTiming(clamp(y, s, height.value));
    runOnJS(notifyZoom)(s > MIN_SCALE);
  };

  const reset = () => {
    "worklet";
    animateTo(1, 0, 0);
  };

  useEffect(() => {
    if (!zoomed && scale.value > MIN_SCALE) {
      scale.value = withTiming(1);
      tx.value = withTiming(0);
      ty.value = withTiming(0);
    }
  }, [zoomed, scale, tx, ty]);

  // Focal coordinates are relative to the untransformed frame; convert to
  // offsets from its centre, which is the transform origin.
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      startScale.value = scale.value;
      startTx.value = tx.value;
      startTy.value = ty.value;
      const fx = e.focalX - width.value / 2;
      const fy = e.focalY - height.value / 2;
      anchorX.value = (fx - tx.value) / scale.value;
      anchorY.value = (fy - ty.value) / scale.value;
    })
    .onUpdate((e) => {
      const s = Math.min(
        Math.max(startScale.value * e.scale, MIN_SCALE * 0.8),
        MAX_SCALE,
      );
      const fx = e.focalX - width.value / 2;
      const fy = e.focalY - height.value / 2;
      scale.value = s;
      tx.value = fx - s * anchorX.value;
      ty.value = fy - s * anchorY.value;
    })
    .onEnd(() => {
      if (scale.value <= MIN_SCALE) reset();
      else animateTo(scale.value, tx.value, ty.value);
    });

  const pan = Gesture.Pan()
    .maxPointers(1)
    .enabled(zoomed)
    .onStart(() => {
      startTx.value = tx.value;
      startTy.value = ty.value;
    })
    .onUpdate((e) => {
      tx.value = clamp(
        startTx.value + e.translationX,
        scale.value,
        width.value,
      );
      ty.value = clamp(
        startTy.value + e.translationY,
        scale.value,
        height.value,
      );
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      if (scale.value > MIN_SCALE) {
        reset();
        return;
      }
      // Zoom so the tapped point stays where it was tapped.
      const fx = e.x - width.value / 2;
      const fy = e.y - height.value / 2;
      animateTo(
        DOUBLE_TAP_SCALE,
        fx - DOUBLE_TAP_SCALE * fx,
        fy - DOUBLE_TAP_SCALE * fy,
      );
    });

  const composed = Gesture.Simultaneous(
    pinch,
    Gesture.Exclusive(pan, doubleTap),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <View style={[style, { overflow: "hidden" }]} onLayout={onLayout}>
        <AnimatedImage
          source={source}
          resizeMode={resizeMode}
          style={[{ width: "100%", height: "100%" }, animatedStyle]}
        />
      </View>
    </GestureDetector>
  );
}
