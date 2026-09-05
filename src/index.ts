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
    version: "0.2.0",
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
        description: "Dispatch an asynchronous coding chore, bug fix, or suggestion to Google Jules with cloud PR creation, custom branches, and plan approval options.",
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
              description: "Target base branch name (defaults to main/master).",
            },
            working_branch: {
              type: "string",
              description: "Optional custom branch name to push the changes to.",
            },
            auto_create_pr: {
              type: "boolean",
              description: "If true, Jules will automatically open a GitHub PR directly in the cloud (defaults to true).",
            },
            require_plan_approval: {
              type: "boolean",
              description: "If true, Jules generates a multi-step plan first and waits for explicit approval before writing code.",
            },
          },
          required: ["source", "prompt"],
        },
      },
      {
        name: "jules_get_session",
        description: "Retrieve full status, outputs, unidiff patches, and execution timeline for a Google Jules session.",
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
        name: "jules_approve_plan",
        description: "Approve a generated execution plan for a Jules session waiting in AWAITING_PLAN_APPROVAL.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The unique Jules session ID.",
            },
            plan_id: {
              type: "string",
              description: "Optional specific plan ID to approve (auto-detects the latest plan if omitted).",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_reply_feedback",
        description: "Send a feedback or reply message to unblock a Jules session paused in AWAITING_USER_FEEDBACK.",
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
        name: "jules_inspect_bash_logs",
        description: "Inspect raw bash commands, exit codes, and stdout/stderr execution outputs produced by Jules in the cloud sandbox.",
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
        name: "jules_archive_session",
        description: "Archive or unarchive a Jules session to clean up the active dashboard.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The unique Jules session ID.",
            },
            unarchive: {
              type: "boolean",
              description: "If true, unarchive the session instead of archiving.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_delete_session",
        description: "Permanently delete a Jules session.",
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
        name: "jules_sync_prs",
        description: "Extract completed patches from Jules sessions and automatically create verified GitHub Pull Requests locally.",
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
        const workingBranch = (args as any).working_branch;
        const autoPr = (args as any).auto_create_pr !== false;
        const requirePlan = !!(args as any).require_plan_approval;

        let sourceName = sourceInput;
        if (!sourceName.startsWith("sources/")) {
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

        const sourceContext: any = {
          source: sourceName,
          githubRepoContext: {
            startingBranch: branch,
          },
        };
        if (workingBranch) {
          sourceContext.workingBranch = workingBranch;
        }

        const payload = {
          prompt: promptText,
          sourceContext,
          automationMode: autoPr ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
          requirePlanApproval: requirePlan,
        };

        const res = await request("sessions", account.key, { method: "POST" }, payload);
        return {
          content: [
            {
              type: "text",
              text: `✅ Task dispatched to Google Jules!\nAccount: ${account.name || account.email}\nSession ID: ${res.id || res.name}\nSource: ${sourceName}\nState: ${res.state || "QUEUED"}\nAuto PR: ${autoPr}\nPlan Approval Required: ${requirePlan}`,
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

      case "jules_approve_plan": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        let planId = (args as any).plan_id;
        const config = loadConfig();

        if (!planId) {
          for (const acc of config.accounts) {
            try {
              const activitiesData = await request(`sessions/${sid}/activities`, acc.key);
              for (const act of (activitiesData.activities || []).reverse()) {
                const p = act.planGenerated?.plan;
                if (p?.id) {
                  planId = p.id;
                  break;
                }
              }
              if (planId) break;
            } catch {}
          }
        }

        if (!planId) {
          throw new Error(`No plan found to approve in session ${sid}`);
        }

        let approved = false;
        let lastErr = "";
        for (const acc of config.accounts) {
          try {
            await request(
              `sessions/${sid}:approvePlan`,
              acc.key,
              { method: "POST" },
              { planId }
            );
            approved = true;
            break;
          } catch (e: any) {
            lastErr = e.message;
          }
        }

        if (!approved) {
          throw new Error(`Failed to approve plan ${planId} for session ${sid}: ${lastErr}`);
        }

        return {
          content: [{ type: "text", text: `✅ Plan ${planId} successfully approved for session ${sid}.` }],
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
              { prompt: msg }
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

      case "jules_inspect_bash_logs": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const config = loadConfig();
        const logs: any[] = [];

        for (const acc of config.accounts) {
          try {
            const data = await request(`sessions/${sid}/activities`, acc.key);
            for (const act of data.activities || []) {
              for (const art of act.artifacts || []) {
                if (art.bashOutput) {
                  logs.push({
                    time: act.createTime,
                    command: art.bashOutput.command,
                    exitCode: art.bashOutput.exitCode,
                    output: art.bashOutput.output,
                  });
                }
              }
            }
            break;
          } catch {}
        }

        return {
          content: [
            {
              type: "text",
              text: logs.length ? JSON.stringify(logs, null, 2) : `No bash execution logs found for session ${sid}.`,
            },
          ],
        };
      }

      case "jules_archive_session": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const unarchive = !!(args as any).unarchive;
        const method = unarchive ? "unarchive" : "archive";
        const config = loadConfig();
        let ok = false;
        let lastErr = "";

        for (const acc of config.accounts) {
          try {
            await request(`sessions/${sid}:${method}`, acc.key, { method: "POST" }, {});
            ok = true;
            break;
          } catch (e: any) {
            lastErr = e.message;
          }
        }

        if (!ok) {
          throw new Error(`Failed to ${method} session ${sid}: ${lastErr}`);
        }

        return {
          content: [{ type: "text", text: `✅ Session ${sid} successfully ${unarchive ? "unarchived" : "archived"}.` }],
        };
      }

      case "jules_delete_session": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const config = loadConfig();
        let ok = false;
        let lastErr = "";

        for (const acc of config.accounts) {
          try {
            await request(`sessions/${sid}`, acc.key, { method: "DELETE" });
            ok = true;
            break;
          } catch (e: any) {
            lastErr = e.message;
          }
        }

        if (!ok) {
          throw new Error(`Failed to delete session ${sid}: ${lastErr}`);
        }

        return {
          content: [{ type: "text", text: `✅ Session ${sid} permanently deleted.` }],
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
            const active = sessions.filter((s: any) => s.state === "IN_PROGRESS" || s.state === "AWAITING_USER_FEEDBACK" || s.state === "AWAITING_PLAN_APPROVAL");
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
