import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const textInput = fromJsonSchema({
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
  type: "object",
});

function createFixtureServer() {
  const server = new McpServer({
    name: "CharaMate MCP integration fixture",
    version: "1.0.0",
  });
  server.registerTool(
    "echo",
    {
      annotations: { idempotentHint: true, readOnlyHint: true },
      description: "Echo text from the integration fixture",
      inputSchema: textInput,
      title: "Echo",
    },
    ({ text }) => ({
      content: [
        {
          text: `${text} ${process.env.MCP_TEST_SECRET ?? ""}`,
          type: "text",
        },
      ],
    }),
  );

  if (process.argv[2] !== "minimal") {
    server.registerTool(
      "large",
      {
        annotations: { idempotentHint: true, readOnlyHint: true },
        description: "Return a large text result",
        title: "Large output",
      },
      () => ({ content: [{ text: "x".repeat(40_000), type: "text" }] }),
    );
    server.registerTool(
      "slow",
      {
        annotations: { idempotentHint: true, readOnlyHint: true },
        description: "Wait until cancelled",
        title: "Slow operation",
      },
      async (_input, context) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 60_000);
          context.mcpReq.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
        return { content: [{ text: "late", type: "text" }] };
      },
    );
  }
  return server;
}

serveStdio(createFixtureServer);
