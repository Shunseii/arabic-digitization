/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      // Semantic tokens; values come from CSS variables set by the theme
      // provider in app/_layout.tsx (light/dark), see src/theme.ts.
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        ink: token("ink"),
        "ink-2": token("ink-2"),
        "ink-3": token("ink-3"),
        line: token("line"),
        accent: token("accent"),
        "accent-soft": token("accent-soft"),
        "on-accent": token("on-accent"),
        mark: token("mark"),
        ok: token("ok"),
        "ok-soft": token("ok-soft"),
        warn: token("warn"),
        "warn-soft": token("warn-soft"),
        danger: token("danger"),
        "danger-soft": token("danger-soft"),
        paper: token("paper"),
        "paper-ink": token("paper-ink"),
      },
      // React Native picks weights by font file, so each weight is a family.
      fontFamily: {
        display: ["Newsreader_600SemiBold"],
        body: ["Inter_400Regular"],
        "body-medium": ["Inter_500Medium"],
        "body-semibold": ["Inter_600SemiBold"],
        "body-bold": ["Inter_700Bold"],
        ar: ["NotoNaskhArabic_400Regular"],
        "ar-medium": ["NotoNaskhArabic_500Medium"],
        "ar-bold": ["NotoNaskhArabic_700Bold"],
      },
    },
  },
  plugins: [],
};
