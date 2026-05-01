"use client";

import { useEffect, useRef } from "react";

export function ApiExplorer() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference/dist/browser/standalone.min.js";
    script.crossOrigin = "anonymous";
    script.dataset.configuration = JSON.stringify({
      spec: { url: "/api/openapi.yaml" },
      theme: "saturn",
      darkMode: true,
      hideModels: false,
      authentication: { apiKey: { token: "tn_prod_agri_" } },
    });
    script.id = "api-reference";
    container.appendChild(script);

    return () => {
      if (container.contains(script)) container.removeChild(script);
    };
  }, []);

  return <div className="h-full" ref={containerRef} />;
}
