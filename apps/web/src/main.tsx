import React from "react";
import { createRoot } from "react-dom/client";
import { AuthGateway } from "./features/auth/AuthGateway.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGateway
      googleClientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}
      apiBaseUrl={import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000"}
    />
  </React.StrictMode>,
);
