// onnxruntime-react-native ships a legacy unimodule.json, which Expo's
// autolinking reads as an Expo module config and then skips the package.
// Declaring it here makes autolinking link its native package normally.
module.exports = {
  dependencies: {
    "onnxruntime-react-native": {
      platforms: {
        android: {
          sourceDir: "android",
          packageImportPath:
            "import ai.onnxruntime.reactnative.OnnxruntimePackage;",
          packageInstance: "new OnnxruntimePackage()",
        },
      },
    },
  },
};
