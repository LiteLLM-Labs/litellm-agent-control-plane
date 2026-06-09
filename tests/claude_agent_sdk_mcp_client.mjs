import { query } from "@anthropic-ai/claude-code";

const gatewayMcpUrl = process.env.LITELLM_RUST_MCP_URL;
const masterKey = process.env.LITELLM_MASTER_KEY;

if (!gatewayMcpUrl || !masterKey) {
  throw new Error("LITELLM_RUST_MCP_URL and LITELLM_MASTER_KEY are required");
}

const messages = query({
  prompt: "List the tools exposed by the gateway MCP server.",
  options: {
    mcpServers: {
      gateway: {
        type: "http",
        url: gatewayMcpUrl,
        headers: {
          Authorization: `Bearer ${masterKey}`,
        },
      },
    },
    allowedTools: ["mcp__gateway"],
  },
});

for await (const message of messages) {
  if (message.type === "system" && message.subtype === "init") {
    const gateway = message.mcp_servers.find((server) => server.name === "gateway");
    if (!gateway || gateway.status !== "connected") {
      throw new Error(`gateway MCP server did not connect: ${JSON.stringify(gateway)}`);
    }
    console.log("gateway MCP server connected");
  }

  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use" && block.name.startsWith("mcp__gateway__")) {
        console.log(`gateway MCP tool called: ${block.name}`);
      }
    }
  }

  if (message.type === "result") {
    console.log(message.subtype);
  }
}
