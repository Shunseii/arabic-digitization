import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Pressable, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "@/components/ui";
import { ZoomableImage } from "@/components/zoomable-image";

/**
 * Full-screen look at one scanned image, with pinch, pan and double-tap zoom.
 * Gestures inside a Modal need their own GestureHandlerRootView on Android.
 */
export const PageViewer = ({
  uri,
  title,
  onClose,
}: {
  uri: string | null;
  title?: string;
  onClose: () => void;
}) => {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [zoomed, setZoomed] = useState(false);

  return (
    <Modal
      visible={uri !== null}
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      onDismiss={() => setZoomed(false)}
    >
      <GestureHandlerRootView className="flex-1 bg-black">
        {uri ? (
          <ZoomableImage
            key={uri}
            source={{ uri }}
            resizeMode="contain"
            style={{ width, height }}
            zoomed={zoomed}
            onZoomChange={setZoomed}
          />
        ) : null}
        <View
          className="absolute left-4 right-4 flex-row items-center justify-between"
          style={{ top: insets.top + 8 }}
          pointerEvents="box-none"
        >
          {title ? (
            <View className="h-10 justify-center rounded-full bg-black/60 px-4">
              <T variant="small" className="font-body-semibold text-white">
                {title}
              </T>
            </View>
          ) : (
            <View />
          )}
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
            className="size-10 items-center justify-center rounded-full bg-black/60 active:opacity-70"
          >
            <Feather name="x" size={20} color="white" />
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
};
