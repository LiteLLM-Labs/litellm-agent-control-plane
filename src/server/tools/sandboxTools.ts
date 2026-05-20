import { fetch } from "undici";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { runTask, waitHttpReady, waitRunningGetUrl } from "@/server/k8s";
import type { AgentRow } from "@/server/types";

const EXECUTE_TIMEOUT_MS = 300_000;

const sandboxMap = new Map<string, string>();

function mapKey(session_id: string, name: string): string {
  return `${session_id}:${name}`;
}

export async function provisionSandbox(
  session_id: string,
  name: string,
  agent: AgentRow,
): Promise<string> {
  if (env.LOCAL_SANDBOX_URL) {
    sandboxMap.set(mapKey(session_id, name), env.LOCAL_SANDBOX_URL);
    return `sandbox '${name}' ready`;
  }

  const { task_arn } = await runTask({ agent, session_id });

  await prisma.session.update({
    where: { session_id },
    data: { task_arn },
  });

  const sandbox_url = await waitRunningGetUrl(task_arn, agent);
  await waitHttpReady(sandbox_url);

  await prisma.session.update({
    where: { session_id },
    data: { sandbox_url },
  });

  sandboxMap.set(mapKey(session_id, name), sandbox_url);
  return `sandbox '${name}' ready`;
}

export async function executeSandbox(
  session_id: string,
  name: string,
  cmd: string,
): Promise<string> {
  const sandbox_url = sandboxMap.get(mapKey(session_id, name));
  if (!sandbox_url) {
    return `error: sandbox '${name}' not provisioned — call provision first`;
  }

  const url = `${sandbox_url.replace(/\/+$/, "")}/execute`;
  const secret = env.EXECUTOR_SECRET;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-executor-secret"] = secret;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ cmd }),
      signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
    });
    const data = (await res.json()) as { output?: string };
    return data.output ?? "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function getSandboxUrl(
  session_id: string,
  name: string,
): string | undefined {
  return sandboxMap.get(mapKey(session_id, name));
}

export function clearSandboxes(session_id: string): void {
  for (const key of sandboxMap.keys()) {
    if (key.startsWith(`${session_id}:`)) {
      sandboxMap.delete(key);
    }
  }
}
