/**
 * In-process MCP server exposing `provision` + `execute` sandbox tools.
 *
 * Only constructed when a session is created with `sandbox_tools: true`.
 * Returns null when LAP_BASE_URL or LAP_AUTH_TOKEN are not set so local dev
 * without the platform reachable still works (tools just absent).
 *
 * Follows the same pattern as buildMemoryMcpServer in memory-tools.ts.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function buildSandboxMcpServer(
  session_id: string,
): McpSdkServerConfigWithInstance | null {
  const base = process.env.LAP_BASE_URL;
  const token = process.env.LAP_AUTH_TOKEN;
  if (!base || !token) return null;

  const provision = tool(
    "provision",
    "Provision a new sandbox environment from a project template. Returns a confirmation message when the sandbox is ready.",
    {
      name: z
        .string()
        .describe(
          "Label for the sandbox — used in subsequent execute() calls as sandbox_name",
        ),
      project_id: z
        .string()
        .describe("ID of the project template to provision the sandbox from"),
    },
    async (input: { name: string; project_id: string }) => {
      try {
        const res = await fetch(
          `${base}/api/v1/managed_agents/sessions/${session_id}/sandbox/provision`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ name: input.name, project_id: input.project_id }),
          },
        );
        const json = (await res.json()) as { message?: string; error?: string };
        if (!res.ok) {
          const errMsg = json.error ?? `HTTP ${res.status}`;
          return {
            content: [{ type: "text" as const, text: `provision failed: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: json.message ?? "sandbox provisioned",
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `provision error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  const execute = tool(
    "execute",
    "Execute a shell command inside a provisioned sandbox. Returns the command output.",
    {
      sandbox_name: z
        .string()
        .describe("Label of the provisioned sandbox to run the command in"),
      cmd: z.string().describe("Shell command to execute inside the sandbox"),
    },
    async (input: { sandbox_name: string; cmd: string }) => {
      try {
        const res = await fetch(
          `${base}/api/v1/managed_agents/sessions/${session_id}/sandbox/execute`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              sandbox_name: input.sandbox_name,
              cmd: input.cmd,
            }),
          },
        );
        const json = (await res.json()) as { output?: string; error?: string };
        if (!res.ok) {
          const errMsg = json.error ?? `HTTP ${res.status}`;
          return {
            content: [{ type: "text" as const, text: `execute failed: ${errMsg}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: json.output ?? "",
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `execute error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return createSdkMcpServer({
    name: "lap-sandbox",
    version: "0.1.0",
    tools: [provision, execute],
  });
}

export const SANDBOX_TOOL_NAMES = [
  "mcp__lap-sandbox__provision",
  "mcp__lap-sandbox__execute",
] as const;
