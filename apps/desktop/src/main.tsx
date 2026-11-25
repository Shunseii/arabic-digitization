import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
// Fonts are bundled (CSP 'self', works offline). WebKitGTK's default Arabic
// fallback shapes poorly; Noto Naskh Arabic renders cleanly.
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource/noto-naskh-arabic/arabic-400.css";
import "@fontsource/noto-naskh-arabic/arabic-500.css";
import "@fontsource/noto-naskh-arabic/arabic-600.css";
import "@fontsource/noto-naskh-arabic/arabic-700.css";
import { App } from "./App";
import "./index.css";

// tokens.css switches palettes on a .dark class; follow the OS setting.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () =>
  document.documentElement.classList.toggle("dark", darkQuery.matches);
applyScheme();
darkQuery.addEventListener("change", applyScheme);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
