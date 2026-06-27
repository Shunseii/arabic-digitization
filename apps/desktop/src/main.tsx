import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
// Bundled Arabic webfont (self-hosted → CSP 'self', works offline). WebKitGTK's
// default Arabic fallback shapes poorly; Noto Naskh Arabic renders cleanly.
import "@fontsource/noto-naskh-arabic/arabic.css";
import { App } from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
