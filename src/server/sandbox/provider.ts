import type { AgentRow } from "@/server/types";

export interface ProvisionParams {
  session_id: string;
  agent: AgentRow;
  template?: string;
}

export abstract class SandboxProvider {
  abstract readonly urlScheme: string;
  abstract create(params: ProvisionParams): Promise<string>;
  abstract execute(id: string, cmd: string, timeoutMs: number): Promise<string>;
  abstract terminate(id: string): Promise<void>;
}
