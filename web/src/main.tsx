import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

function announceServiceWorkerUpdate(registration: ServiceWorkerRegistration): void {
  if (!registration.waiting) return;
  window.dispatchEvent(new CustomEvent<ServiceWorkerRegistration>("moth-sw-update", {
    detail: registration,
  }));
}

if (typeof navigator !== "undefined" && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
      announceServiceWorkerUpdate(registration);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            announceServiceWorkerUpdate(registration);
          }
        });
      });
    });
  });
}
