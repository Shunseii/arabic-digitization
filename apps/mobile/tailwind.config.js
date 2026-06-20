/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        bg: "#0C0D10",
        surface: "#14161B",
        "surface-alt": "#1C1F26",
        border: "#282C34",
        hairline: "#20242B",
        ink: "#F4F2EC",
        "text-secondary": "#9D9A92",
        "text-muted": "#65635D",
        accent: "#E3A63C",
        "accent-ink": "#14110A",
        "accent-soft": "#2A2114",
        "st-done": "#46B97D",
        "st-proc": "#5C8DF0",
        "st-fail": "#EE6A4D",
        "st-review": "#C77DFF",
        "st-neutral": "#7C786E",
      },
    },
  },
  plugins: [],
};
