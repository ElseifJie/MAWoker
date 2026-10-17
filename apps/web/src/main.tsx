import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { App } from "./App.js";
import { InvitePage } from "./InvitePage.js";
import { registerServiceWorker } from "./pwa.js";
import "./styles.css";
import "./admin/admin.css";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Missing application root");
}

if (import.meta.env.PROD) registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/invite" element={<InvitePage />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
