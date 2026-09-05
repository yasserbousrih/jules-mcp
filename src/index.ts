#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { execSync } from "child_process";

const CONFIG_PATH = process.env.JULES_CONFIG_PATH || path.join(process.env.HOME || "/root", ".config/jules/keys.json");
const API_BASE = "https://jules.googleapis.com/v1alpha";

interface Account {
  name?: string;
  email?: string;
  key: string;
}

interface JulesConfig {
  accounts: Account[];
  last_index?: number;
}

function loadConfig(): JulesConfig {
  if (process.env.JULES_API_KEY) {
    return { accounts: [{ key: process.env.JULES_API_KEY, name: "env-key" }] };
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Jules configuration file not found at ${CONFIG_PATH}. Set JULES_API_KEY or configure keys.json.`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

function getNextAccount(): { account: Account; index: number } {
  const config = loadConfig();
  if (!config.accounts || config.accounts.length === 0) {
    throw new Error("No Jules accounts configured.");
  }
  const idx = ((config.last_index ?? -1) + 1) % config.accounts.length;
  config.last_index = idx;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch {}
  return { account: config.accounts[idx], index: idx };
}

async function request(endpoint: string, apiKey: string, options: https.RequestOptions = {}, body?: any): Promise<any> {
  const url = `${API_BASE}/${endpoint}${endpoint.includes("?") ? "&" : "?"}key=${apiKey}`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Google Jules API error (${res.statusCode}): ${parsed.error?.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) {
      req.setHeader("Content-Type", "application/json");
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

const server = new Server(
  {
    name: "jules-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "jules_list_sources",
        description: "List all connected GitHub repositories and sources in Google Jules across accounts.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jules_create_task",
        description: "Dispatch an asynchronous coding chore, bug fix, or suggestion to Google Jules in the cloud.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "GitHub repository identifier or short name (e.g. 'Basria-backend' or 'sources/github/yasserbousrih/Basria-backend')",
            },
            prompt: {
              type: "string",
              description: "Instruction prompt detailing the chore, bug fix, type hints, or feature to implement.",
            },
            branch: {
              type: "string",
              description: "Target branch name (defaults to main/master).",
            },
          },
          required: ["source", "prompt"],
        },
      },
      {
        name: "jules_get_session",
        description: "Retrieve status, outputs, unidiff patches, and activity history for a Google Jules session.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The unique Jules session ID.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_reply_feedback",
        description: "Send a user feedback or reply message to unblock a Jules session paused in AWAITING_USER_FEEDBACK.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The unique Jules session ID.",
            },
            message: {
              type: "string",
              description: "Response or instructions to answer Jules' question.",
            },
          },
          required: ["session_id", "message"],
        },
      },
      {
        name: "jules_sync_prs",
        description: "Extract completed patches from Jules sessions and automatically create verified GitHub Pull Requests.",
        inputSchema: {
          type: "object",
          properties: {
            dry_run: {
              type: "boolean",
              description: "Preview PR candidates without creating Git branches or GitHub PRs.",
            },
            session_id: {
              type: "string",
              description: "Optional specific session ID to synchronize.",
            },
          },
        },
      },
      {
        name: "jules_pool_status",
        description: "Check quota and active task status across all configured Jules Google accounts.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (requestCall) => {
  const { name, arguments: args } = requestCall.params;

  try {
    switch (name) {
      case "jules_list_sources": {
        const config = loadConfig();
        const results: any[] = [];
        for (const acc of config.accounts) {
          try {
            const data = await request("sources", acc.key);
            results.push({ account: acc.name || acc.email, sources: data.sources || [] });
          } catch (err: any) {
            results.push({ account: acc.name || acc.email, error: err.message });
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "jules_create_task": {
        const { account } = getNextAccount();
        const sourceInput = (args as any).source;
        const promptText = (args as any).prompt;
        const branch = (args as any).branch || "main";

        let sourceName = sourceInput;
        if (!sourceName.startsWith("sources/")) {
          // Resolve short repo name
          const data = await request("sources", account.key);
          const found = (data.sources || []).find((s: any) =>
            s.name.toLowerCase().includes(sourceInput.toLowerCase())
          );
          if (found) {
            sourceName = found.name;
          } else {
            sourceName = `sources/github/yasserbousrih/${sourceInput}`;
          }
        }

        const payload = {
          prompt: promptText,
          sourceContext: {
            source: sourceName,
            githubRepoContext: {
              startingBranch: branch,
            },
          },
        };

        const res = await request("sessions", account.key, { method: "POST" }, payload);
        return {
          content: [
            {
              type: "text",
              text: `✅ Task dispatched to Google Jules!\nAccount: ${account.name || account.email}\nSession ID: ${res.id || res.name}\nSource: ${sourceName}\nState: ${res.state || "QUEUED"}`,
            },
          ],
        };
      }

      case "jules_get_session": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const config = loadConfig();
        let sessionData: any = null;
        let activitiesData: any = null;

        for (const acc of config.accounts) {
          try {
            sessionData = await request(`sessions/${sid}`, acc.key);
            try {
              activitiesData = await request(`sessions/${sid}/activities`, acc.key);
            } catch {}
            break;
          } catch {}
        }

        if (!sessionData) {
          throw new Error(`Session ${sid} not found across any configured account.`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session: sessionData,
                  activities: activitiesData?.activities || [],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "jules_reply_feedback": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const msg = (args as any).message;
        const config = loadConfig();
        let success = false;
        let lastErr = "";

        for (const acc of config.accounts) {
          try {
            await request(
              `sessions/${sid}:sendMessage`,
              acc.key,
              { method: "POST" },
              { message: msg }
            );
            success = true;
            break;
          } catch (e: any) {
            lastErr = e.message;
          }
        }

        if (!success) {
          throw new Error(`Failed to send reply to session ${sid}: ${lastErr}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `✅ Feedback reply sent to Jules session ${sid}.`,
            },
          ],
        };
      }

      case "jules_sync_prs": {
        const dryRun = (args as any)?.dry_run ? "--dry-run" : "";
        const sid = (args as any)?.session_id ? `--session ${(args as any).session_id}` : "";
        const output = execSync(`/root/.local/bin/jules-sync-prs ${dryRun} ${sid}`).toString();
        return {
          content: [{ type: "text", text: output }],
        };
      }

      case "jules_pool_status": {
        const config = loadConfig();
        const poolStatus: any[] = [];
        for (const acc of config.accounts) {
          try {
            const data = await request("sessions", acc.key);
            const sessions = data.sessions || [];
            const active = sessions.filter((s: any) => s.state === "IN_PROGRESS" || s.state === "AWAITING_USER_FEEDBACK");
            const completed = sessions.filter((s: any) => s.state === "COMPLETED");
            poolStatus.push({
              account: acc.name || acc.email,
              total_sessions: sessions.length,
              active_count: active.length,
              completed_count: completed.length,
              active_sessions: active.map((s: any) => ({ id: s.id, state: s.state, title: s.title })),
            });
          } catch (e: any) {
            poolStatus.push({ account: acc.name || acc.email, error: e.message });
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify(poolStatus, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }],
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((err) => {
  console.error("Fatal error starting jules-mcp:", err);
  process.exit(1);
});
