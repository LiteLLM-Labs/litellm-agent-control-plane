"use client";

import { useEffect } from "react";
import { setStoredMasterKey, getStoredMasterKey } from "@/lib/api";

// Listens for { type: "litellm-auth", session_claim: "..." } postMessage
// from the litellm parent frame.  Forwards the claim to the LAP's own
// /api/plugin-auth endpoint for server-side verification.  On success,
// the server returns the LAP's own master key so the browser can
// authenticate API calls — the litellm credential never crosses the boundary.
export default function TokenAutoAuth() {
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (event.data?.type !== "litellm-auth") return;

      const claim = event.data.session_claim as string | undefined;
      if (!claim) return;

      try {
        const res = await fetch("/api/plugin-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_claim: claim }),
        });
        if (!res.ok) return;
        const data: { token?: string } = await res.json();
        const token = data?.token;
        if (token && token !== getStoredMasterKey()) {
          setStoredMasterKey(token);
          window.location.reload();
        }
      } catch {
        // Silently ignore — user can sign in manually.
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return null;
}
