import express from "express";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

const EMAIL = "24f3001488@ds.study.iitm.ac.in";

app.get("/", (_req, res) => {
  res.status(200).type("text").send("Live MCP challenge server is running.");
});

app.post("/mcp", async (req, res) => {
  // Read the challenge from this HTTP request's headers, never the JSON body.
  const challenge = req.get("X-Exam-Challenge") ?? "";

  const server = new McpServer({
    name: "live-exam-challenge",
    version: "1.0.0"
  });

  server.registerTool(
    "solve_challenge",
    {
      description: "Returns the challenge-specific verification hash.",
      inputSchema: {}
    },
    async () => {
      const digest = createHash("sha256")
        .update(`${challenge}:${EMAIL}`, "utf8")
        .digest("hex")
        .slice(0, 16);

      return { content: [{ type: "text", text: digest }] };
    }
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Internal MCP server error" });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`MCP server listening on port ${port}; endpoint path: /mcp`);
});
