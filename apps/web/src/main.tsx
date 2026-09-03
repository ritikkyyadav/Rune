import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/web.css";
import "./styles/primitives.css";
import "./styles/gallery.css";
import { applyTheme, loadTheme } from "./lib/theme";

// Paint the theme before the first frame so the window never flashes.
applyTheme(loadTheme());

// One route, and it is not part of the product.
//
// `/gallery` renders the primitive catalogue for review; every other path is the
// app, because `gear serve --web` falls back to `index.html` for anything that
// is not a file (see `serve-cli.ts`'s `serveStatic`) and the shell owns its own
// navigation. A router would be a dependency and a second navigation model for
// one page nothing links to.
//
// It is lazy so the review page's fixture — a full worked investigation, and the
// largest single blob of content in the repository — is not in the bundle every
// person downloads to run a task.
const route = window.location.pathname.replace(/\/+$/, "");
const Gallery = lazy(() => import("./gallery/Gallery"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {route === "/gallery" ? (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
