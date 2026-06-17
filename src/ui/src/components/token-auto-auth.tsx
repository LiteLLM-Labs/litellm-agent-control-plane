"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setStoredMasterKey, getStoredMasterKey } from "@/lib/api";

// Reads ?token= from URL, stores in sessionStorage, then strips param.
// Allows litellm's mode switcher to pass its access token into this iframe
// so the user doesn't need to sign in separately.
export default function TokenAutoAuth() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const token = searchParams.get("token");
    if (token && token !== getStoredMasterKey()) {
      setStoredMasterKey(token);
      // Strip token from URL to avoid leaking it in history/logs
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      router.replace(url.pathname + url.search);
    }
  }, [searchParams, router]);

  return null;
}
