"use client";

import { useEffect } from "react";
import { setStoredMasterKey, getStoredMasterKey } from "@/lib/api";

export default function TokenAutoAuth() {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        event.data?.type === "litellm-auth" &&
        typeof event.data.token === "string" &&
        event.data.token !== getStoredMasterKey()
      ) {
        setStoredMasterKey(event.data.token);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return null;
}
