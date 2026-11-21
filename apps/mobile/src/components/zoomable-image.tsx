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
import {
  clampOffset,
  doubleTapTarget,
  MIN_SCALE,
  type PinchAnchor,
  pinchStep,
  settle,
  type Transform,
} from "@/lib/zoom-math";

const DOUBLE_TAP_SCALE = 2.5;

const AnimatedImage = Animated.createAnimatedComponent(Image);

/**
 * Pinch-to-zoom image. Zoom is anchored at the fingers, two fingers also pan,
 * one finger pans while zoomed, and double-tap zooms in at the tapped point
 * or back out. Set `zoomed` to false from outside to reset.
 */
export function ZoomableImage({
  source,
  style,
  resizeMode = "contain",
  zoomed = false,
  onZoomChange,
  onPinchingChange,
}: {
  source: ImageSourcePropType;
  style?: ImageStyle;
  resizeMode?: ComponentProps<typeof Image>["resizeMode"];
  zoomed?: boolean;
  onZoomChange?: (zoomed: boolean) => void;
  /** True while two fingers are on the image, so a parent pager can hold still. */
  onPinchingChange?: (pinching: boolean) => void;
}) {
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const anchor = useSharedValue<PinchAnchor | null>(null);
  const pinchActive = useSharedValue(false);
  // True only while two fingers are down; a pan defers to the pinch then.
  const pinching = useSharedValue(false);
  // Fingers down, counted from touch events. Android's pinch update for a
  // lifting finger still reports two pointers but already moves the focal
  // point to the remaining finger, so its own pointer count can't be trusted.
  const touches = useSharedValue(0);
  // Pan position = offset + finger translation. Rebased while a pinch moves
  // the image, so a pan that outlives the pinch continues from where the
  // pinch left it instead of snapping back.
  const panOffsetX = useSharedValue(0);
  const panOffsetY = useSharedValue(0);

  const notifyZoom = useCallback(
    (next: boolean) => onZoomChange?.(next),
    [onZoomChange],
  );
  const notifyPinching = useCallback(
    (next: boolean) => onPinchingChange?.(next),
    [onPinchingChange],
  );
  // Last value sent to onPinchingChange, so it fires once per change.
  const twoFingers = useSharedValue(false);
  const setTwoFingers = (next: boolean) => {
    "worklet";
    if (twoFingers.value === next) return;
    twoFingers.value = next;
    runOnJS(notifyPinching)(next);
  };

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
    height.value = e.nativeEvent.layout.height;
  };

  const current = (): Transform => {
    "worklet";
    return { s: scale.value, tx: tx.value, ty: ty.value };
  };

  const animateTo = (t: Transform) => {
    "worklet";
    scale.value = withTiming(t.s);
    tx.value = withTiming(t.tx);
    ty.value = withTiming(t.ty);
    runOnJS(notifyZoom)(t.s > MIN_SCALE);
  };

  useEffect(() => {
    if (!zoomed && scale.value > MIN_SCALE) {
      scale.value = withTiming(1);
      tx.value = withTiming(0);
      ty.value = withTiming(0);
    }
  }, [zoomed, scale, tx, ty]);

  // Focal points are relative to the untransformed frame; convert them to
  // offsets from its centre.
  const pinch = Gesture.Pinch()
    .onTouchesDown((e) => {
      touches.value = e.numberOfTouches;
      if (e.numberOfTouches >= 2) setTwoFingers(true);
    })
    .onTouchesUp((e) => {
      touches.value = e.numberOfTouches;
      if (e.numberOfTouches === 0) setTwoFingers(false);
    })
    .onTouchesCancelled(() => {
      touches.value = 0;
      setTwoFingers(false);
    })
    .onStart(() => {
      pinchActive.value = true;
      anchor.value = null;
    })
    .onUpdate((e) => {
      const pointers = Math.min(touches.value, e.numberOfPointers);
      pinching.value = pointers >= 2;
      const step = pinchStep({
        current: current(),
        anchor: anchor.value,
        gestureScale: e.scale,
        fx: e.focalX - width.value / 2,
        fy: e.focalY - height.value / 2,
        pointers,
      });
      anchor.value = step.anchor;
      scale.value = step.transform.s;
      tx.value = step.transform.tx;
      ty.value = step.transform.ty;
    })
    .onFinalize(() => {
      pinching.value = false;
      setTwoFingers(false);
      if (!pinchActive.value) return;
      pinchActive.value = false;
      anchor.value = null;
      animateTo(
        settle({
          current: current(),
          width: width.value,
          height: height.value,
        }),
      );
    });

  const pan = Gesture.Pan()
    .enabled(zoomed)
    .averageTouches(true)
    .onStart((e) => {
      panOffsetX.value = tx.value - e.translationX;
      panOffsetY.value = ty.value - e.translationY;
    })
    .onUpdate((e) => {
      if (pinching.value) {
        panOffsetX.value = tx.value - e.translationX;
        panOffsetY.value = ty.value - e.translationY;
        return;
      }
      tx.value = clampOffset({
        value: panOffsetX.value + e.translationX,
        scale: scale.value,
        size: width.value,
      });
      ty.value = clampOffset({
        value: panOffsetY.value + e.translationY,
        scale: scale.value,
        size: height.value,
      });
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      animateTo(
        doubleTapTarget({
          current: current(),
          fx: e.x - width.value / 2,
          fy: e.y - height.value / 2,
          zoomScale: DOUBLE_TAP_SCALE,
          width: width.value,
          height: height.value,
        }),
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
