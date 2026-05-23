import { Sandbox } from "e2b";

import { SandboxProvider, type ProvisionParams } from "./provider";

export class E2bProvider extends SandboxProvider {
  readonly urlScheme = "e2b";

  constructor(
    private readonly apiKey: string,
    private readonly template: string,
  ) {
    super();
  }

  async create(_params: ProvisionParams): Promise<string> {
    const sandbox = await Sandbox.create(this.template, { apiKey: this.apiKey });
    return sandbox.sandboxId;
  }

  async execute(id: string, cmd: string, timeoutMs: number): Promise<string> {
    const sandbox = await Sandbox.connect(id, { apiKey: this.apiKey });
    const result = await sandbox.commands.run(cmd, { timeoutMs });
    return (result.stdout ?? "") + (result.stderr ?? "");
  }

  async terminate(id: string): Promise<void> {
    await Sandbox.kill(id, { apiKey: this.apiKey });
  }
}
