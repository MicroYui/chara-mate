import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CharacterApp } from "./CharacterApp";

const rootElement = document.getElementById("root");
if (!rootElement)
  throw new Error("Character renderer root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <CharacterApp />
  </StrictMode>,
);
