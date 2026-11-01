import React from "react";
import { createRoot } from "react-dom/client";
import { PlanReview } from "./features/planning/PlanReview.js";
import { createIntentApi } from "./features/intent/intent-api.js";
import "./styles.css";

// A separate Vite development entry. No credentials, saved project or mutations.
const previewProject = {
  id: "canvas-preview",
  organization_id: "preview",
  name: "Composer preview",
  created_at: "2026-11-01T00:00:00Z",
};
const previewApi = createIntentApi(
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000",
  () => undefined,
);

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <span className="canvas-preview-badge">Preview · not saved</span>
      <PlanReview
        project={previewProject}
        originalIntent={null}
        plan={null}
        api={previewApi}
        onBack={() => window.location.assign("/")}
        onUpdated={() => undefined}
      />
    </React.StrictMode>,
  );
}
