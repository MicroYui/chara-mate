import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { RendererErrorBoundary } from "./app/RendererErrorBoundary";
import {
  readBackgroundScheme,
  readCustomBackgroundColors,
  readThemePreference,
  resolveThemePreference,
} from "./app/appearance";
import "./app/global.css";

const initialThemePreference = readThemePreference(window.localStorage);
const initialBackgroundScheme = readBackgroundScheme(window.localStorage);
document.documentElement.dataset["backgroundScheme"] = initialBackgroundScheme;
document.documentElement.dataset["theme"] = resolveThemePreference(
  initialThemePreference,
  window.matchMedia("(prefers-color-scheme: dark)").matches,
);
if (initialBackgroundScheme === "custom") {
  const colors = readCustomBackgroundColors(window.localStorage);
  document.documentElement.style.setProperty("--custom-accent", colors.accent);
  document.documentElement.style.setProperty("--custom-canvas", colors.canvas);
  document.documentElement.style.setProperty(
    "--custom-sidebar",
    colors.sidebar,
  );
  document.documentElement.style.setProperty(
    "--custom-surface",
    colors.surface,
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Renderer root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>,
);
