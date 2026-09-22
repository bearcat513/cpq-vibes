/**
 * The entry point for the API reference at `/docs`.
 *
 * It is included in `src/docs.html`, which the build picks up on its own —
 * every `src/**\/*.html` is an entry point, so adding a page is adding a file.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocsPage } from "./components/docs/DocsPage";
import "./index.css";

const elem = document.getElementById("root")!;
const page = (
  <StrictMode>
    <DocsPage />
  </StrictMode>
);

(import.meta.hot.data.root ??= createRoot(elem)).render(page);
