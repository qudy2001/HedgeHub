import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import "./styles.css";

// Separate roots avoid mounting the classic dashboard's data polling in Studio.
const isBuilder = /^\/builder(?:\/|$)/.test(window.location.pathname);
const isMomentum = /^\/momentum(?:\/|$)/.test(window.location.pathname);
const App = lazy(() =>
  isMomentum
    ? import("./momentum/MomentumApp.jsx")
    : isBuilder
      ? import("./builder/BuilderApp.jsx")
      : import("./App.jsx"),
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ padding: 32 }}>Loading HedgeHub…</div>}>
      <App />
    </Suspense>
  </React.StrictMode>,
);
