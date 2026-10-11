import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import "./styles.css";

// Separate roots avoid mounting the classic dashboard's data polling in Studio.
const isBuilder = /^\/builder(?:\/|$)/.test(window.location.pathname);
const isMomentum = /^\/momentum(?:\/|$)/.test(window.location.pathname);

// Each branch gets its own lazy() call with an unconditional import() so Vite
// can statically trace per-chunk CSS dependencies. A single lazy() wrapping a
// ternary of imports only generates preload deps for one branch, silently
// dropping the CSS for the others.
const ClassicApp = lazy(() => import("./App.jsx"));
const BuilderApp = lazy(() => import("./builder/BuilderApp.jsx"));
const MomentumApp = lazy(() => import("./momentum/MomentumApp.jsx"));
const App = isMomentum ? MomentumApp : isBuilder ? BuilderApp : ClassicApp;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ padding: 32 }}>Loading HedgeHub…</div>}>
      <App />
    </Suspense>
  </React.StrictMode>,
);
