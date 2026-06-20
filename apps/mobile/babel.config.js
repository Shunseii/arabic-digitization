module.exports = (api) => {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    // react-native-worklets/plugin must be last (powers reanimated v4, which
    // nativewind's runtime depends on).
    plugins: ["react-native-worklets/plugin"],
  };
};
