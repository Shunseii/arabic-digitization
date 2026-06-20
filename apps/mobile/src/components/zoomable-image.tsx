import { type ComponentProps, useCallback } from "react";
import { Image, type ImageSourcePropType, type ImageStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const MIN_SCALE = 1;
const MAX_SCALE = 5;

const AnimatedImage = Animated.createAnimatedComponent(Image);

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
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const notifyZoom = useCallback(
    (zoomed: boolean) => onZoomChange?.(zoomed),
    [onZoomChange],
  );

  const reset = () => {
    "worklet";
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    runOnJS(notifyZoom)(false);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(
        Math.max(savedScale.value * e.scale, MIN_SCALE),
        MAX_SCALE,
      );
      scale.value = next;
    })
    .onEnd(() => {
      if (scale.value <= MIN_SCALE) {
        reset();
      } else {
        savedScale.value = scale.value;
        runOnJS(notifyZoom)(true);
      }
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .enabled(zoomed)
    .onUpdate((e) => {
      if (scale.value <= MIN_SCALE) return;
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > MIN_SCALE) {
        reset();
      } else {
        scale.value = withTiming(2);
        savedScale.value = 2;
        runOnJS(notifyZoom)(true);
      }
    });

  const composed = Gesture.Simultaneous(
    pinch,
    Gesture.Exclusive(pan, doubleTap),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <AnimatedImage
        source={source}
        resizeMode={resizeMode}
        style={[style, animatedStyle]}
      />
    </GestureDetector>
  );
}
