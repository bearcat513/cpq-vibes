/**
 * The entry point for the record browser at `/table`.
 *
 * Included by `src/table.html`, which the build picks up on its own — every
 * `src/**\/*.html` is an entry point, so adding a page is adding a file.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TablePage } from "./components/table/TablePage";
import "./index.css";

const elem = document.getElementById("root")!;
const page = (
  <StrictMode>
    <TablePage />
  </StrictMode>
);

(import.meta.hot.data.root ??= createRoot(elem)).render(page);
