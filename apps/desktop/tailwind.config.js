/** @type {import('tailwindcss').Config} */
// Every value comes from apps/mobile/src/tokens.css (imported in index.css), so
// desktop and mobile share one palette. color-mix keeps Tailwind's opacity
// modifiers (bg-accent/10) working with hex custom properties.
const token = (name) =>
  `color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`;

const colorNames = [
  "bg",
  "surface",
  "surface-2",
  "ink",
  "ink-2",
  "ink-3",
  "line",
  "accent",
  "accent-soft",
  "on-accent",
  "mark",
  "paper",
  "paper-ink",
  "ok",
  "ok-soft",
  "warn",
  "warn-soft",
  "danger",
  "danger-soft",
];

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ...Object.fromEntries(colorNames.map((name) => [name, token(name)])),
        scrim: "var(--scrim)",
      },
      fontFamily: {
        display: ['"Newsreader Variable"', "serif"],
        body: ['"Inter Variable"', "sans-serif"],
        // Arabic-only subset; Latin inside Arabic fields falls through to Inter.
        ar: ['"Noto Naskh Arabic"', '"Inter Variable"', "sans-serif"],
      },
      // The desktop type scale (designs/desktop-components "Tokens" board):
      // six sizes, one role each.
      fontSize: {
        title: ["34px", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        number: ["24px", { lineHeight: "1.2" }],
        section: ["20px", { lineHeight: "1.3" }],
        body: ["15px", { lineHeight: "1.5" }],
        small: ["13px", { lineHeight: "1.45" }],
        label: ["11px", { lineHeight: "1.2" }],
      },
      borderRadius: {
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "24px",
        full: "999px",
      },
      boxShadow: {
        sm: "0 1px 2px rgb(27 23 18 / 6%), 0 1px 1px rgb(27 23 18 / 4%)",
        md: "0 8px 24px -8px rgb(27 23 18 / 18%), 0 2px 6px rgb(27 23 18 / 6%)",
        lg: "0 24px 48px -16px rgb(27 23 18 / 28%)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
      },
      transitionDuration: {
        press: "var(--dur-press)",
        pop: "var(--dur-pop)",
        modal: "var(--dur-modal)",
      },
    },
  },
  plugins: [],
};
