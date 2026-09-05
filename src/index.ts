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
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.accounts && parsed.accounts.length > 0) {
        return parsed;
      }
    } catch {}
  }
  if (process.env.JULES_API_KEY) {
    return { accounts: [{ key: process.env.JULES_API_KEY, name: "env-key" }] };
  }
  throw new Error(`Jules configuration file not found at ${CONFIG_PATH}. Set JULES_API_KEY or configure keys.json.`);
}

function getAccounts(): Account[] {
  const config = loadConfig();
  if (!config.accounts || config.accounts.length === 0) {
    throw new Error("No Jules accounts configured.");
  }
  return config.accounts;
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

// Request with automatic multi-account fallback on quota/rate-limit errors
async function requestWithFallback(
  endpoint: string,
  options: https.RequestOptions = {},
  body?: any,
  preferredAccountName?: string
): Promise<{ data: any; account: Account }> {
  const accounts = getAccounts();
  let orderedAccounts = [...accounts];
  
  if (preferredAccountName) {
    const found = accounts.find(
      (a) =>
        (a.name && a.name.toLowerCase().includes(preferredAccountName.toLowerCase())) ||
        (a.email && a.email.toLowerCase().includes(preferredAccountName.toLowerCase()))
    );
    if (found) {
      orderedAccounts = [found, ...accounts.filter((a) => a !== found)];
    }
  }

  let lastError: any = null;
  for (const acc of orderedAccounts) {
    try {
      const data = await request(endpoint, acc.key, options, body);
      return { data, account: acc };
    } catch (err: any) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error(`Operation failed across all ${accounts.length} accounts.`);
}

const server = new Server(
  {
    name: "jules-mcp",
    version: "1.0.0",
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
        description: "List all connected GitHub repositories and sources across all configured Google Jules accounts, including branch metadata, pagination, and AIP-160 filter support.",
        inputSchema: {
          type: "object",
          properties: {
            page_size: { type: "number", description: "Number of sources to return per account (1-100, default 30)" },
            page_token: { type: "string", description: "Page token for pagination" },
            filter: { type: "string", description: "AIP-160 filter expression for sources" },
          },
        },
      },
      {
        name: "jules_get_source",
        description: "Get detailed metadata, all available branches, default branch, and privacy status for a specific connected repository.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Source resource name (e.g. 'sources/github/yasserbousrih/Basria-backend') or repo name.",
            },
          },
          required: ["source"],
        },
      },
      {
        name: "jules_create_task",
        description: "Dispatch an asynchronous coding task, bug fix, feature, or refactoring chore to Google Jules with cloud PR creation, custom branches, plan approval, and secret/env injection.",
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
            title: {
              type: "string",
              description: "Optional custom title for the session.",
            },
            branch: {
              type: "string",
              description: "Target base starting branch (defaults to 'main' or 'master').",
            },
            working_branch: {
              type: "string",
              description: "Optional custom working branch name to commit and push changes to.",
            },
            auto_create_pr: {
              type: "boolean",
              description: "If true, Jules will automatically push the branch and open a GitHub PR directly in the cloud (defaults to true).",
            },
            require_plan_approval: {
              type: "boolean",
              description: "If true, Jules generates a multi-step execution plan first and waits for explicit approval before writing code.",
            },
            environment_variables_enabled: {
              type: "boolean",
              description: "If true, passes repository secrets and environment variables configured in Jules to the cloud container sandbox (defaults to true).",
            },
            account: {
              type: "string",
              description: "Optional specific account name/email to target. If omitted, uses automatic rotation with fallback.",
            },
          },
          required: ["source", "prompt"],
        },
      },
      {
        name: "jules_batch_dispatch",
        description: "Dispatch multiple coding tasks across different repositories in parallel, load-balancing automatically across all Google accounts in the pool.",
        inputSchema: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              description: "List of task objects { source: string, prompt: string, title?: string, branch?: string, working_branch?: string, auto_create_pr?: boolean, require_plan_approval?: boolean }",
              items: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  prompt: { type: "string" },
                  title: { type: "string" },
                  branch: { type: "string" },
                  working_branch: { type: "string" },
                  auto_create_pr: { type: "boolean" },
                  require_plan_approval: { type: "boolean" },
                },
                required: ["source", "prompt"],
              },
            },
          },
          required: ["tasks"],
        },
      },
      {
        name: "jules_list_sessions",
        description: "List active and historical coding sessions aggregated across all configured Google accounts with filtering by state, source, AIP-160 filter expressions, and pagination.",
        inputSchema: {
          type: "object",
          properties: {
            state: {
              type: "string",
              description: "Filter by state: 'IN_PROGRESS', 'AWAITING_USER_FEEDBACK', 'AWAITING_PLAN_APPROVAL', 'COMPLETED', 'FAILED', or 'ALL'.",
            },
            source: {
              type: "string",
              description: "Filter sessions by repository / source name.",
            },
            filter: {
              type: "string",
              description: "AIP-160 filter expression for sessions.",
            },
            limit: {
              type: "number",
              description: "Max sessions per account (defaults to 20).",
            },
            page_token: {
              type: "string",
              description: "Pagination page token.",
            },
          },
        },
      },
      {
        name: "jules_get_session",
        description: "Retrieve full status, PR URL, git diff patches, cloud URL, and execution timeline for a Google Jules session (searches across all accounts automatically).",
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
        name: "jules_list_activities",
        description: "List full granular activities (agent messages, progress updates, bash outputs, plan events) for a specific session with pagination and AIP-160 filter.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The unique Jules session ID.",
            },
            page_size: {
              type: "number",
              description: "Number of activities to return (1-100, default 50).",
            },
            page_token: {
              type: "string",
              description: "Page token for pagination.",
            },
            filter: {
              type: "string",
              description: "AIP-160 filter expression for activities.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_get_activity",
        description: "Retrieve a specific single activity by session ID and activity ID.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The unique Jules session ID.",
            },
            activity_id: {
              type: "string",
              description: "The unique activity ID or full activity name (e.g. 'sessions/123/activities/456').",
            },
          },
          required: ["session_id", "activity_id"],
        },
      },
      {
        name: "jules_get_plan",
        description: "Extract the generated step-by-step execution plan from a Jules session.",
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
        description: "Approve a generated execution plan for a Jules session waiting in AWAITING_PLAN_APPROVAL to let Jules proceed with coding.",
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
        description: "Send a message or reply to unblock a Jules session paused in AWAITING_USER_FEEDBACK or provide iterative follow-up instructions.",
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
        name: "jules_get_patch",
        description: "Extract the unidiff git patch, base commit ID, and suggested commit message produced by a completed Jules session.",
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
        name: "jules_inspect_bash_logs",
        description: "Inspect raw bash commands, exit codes, and stdout/stderr execution outputs produced by Jules inside the Google Cloud sandbox container.",
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
        name: "jules_get_media_artifacts",
        description: "Extract screenshots, images, videos, or diagrams produced by Jules during container test runs and UI executions.",
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
        description: "Archive or unarchive a Jules session to organize the active dashboard.",
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
        description: "Permanently delete a Jules session across accounts.",
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
        description: "Extract completed patches from Jules sessions and automatically create verified GitHub Pull Requests locally via GitHub CLI.",
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
        description: "Check quota, active sessions, and available slots across all configured Google accounts in the pool.",
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
        const pageSize = (args as any)?.page_size || 30;
        const pageToken = (args as any)?.page_token;
        const filter = (args as any)?.filter;
        const accounts = getAccounts();
        const results: any[] = [];
        const seenSources = new Set<string>();

        for (const acc of accounts) {
          try {
            let endpoint = `sources?pageSize=${pageSize}`;
            if (pageToken) endpoint += `&pageToken=${encodeURIComponent(pageToken)}`;
            if (filter) endpoint += `&filter=${encodeURIComponent(filter)}`;

            const data = await request(endpoint, acc.key);
            const sources = data.sources || [];
            results.push({
              account: acc.name || acc.email,
              nextPageToken: data.nextPageToken,
              sources: sources.map((s: any) => {
                seenSources.add(s.name);
                return {
                  name: s.name,
                  repo: `${s.githubRepo?.owner}/${s.githubRepo?.repo}`,
                  defaultBranch: s.githubRepo?.defaultBranch?.displayName || "main",
                  branches: (s.githubRepo?.branches || []).map((b: any) => b.displayName),
                  isPrivate: s.githubRepo?.isPrivate,
                };
              }),
            });
          } catch (err: any) {
            results.push({ account: acc.name || acc.email, error: err.message });
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total_unique_sources: seenSources.size,
                  unique_sources: Array.from(seenSources),
                  account_breakdown: results,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "jules_get_source": {
        const sourceInput = (args as any).source.replace(/^sources\//, "");
        const accounts = getAccounts();
        let sourceData: any = null;
        let ownerAccount: Account | null = null;

        for (const acc of accounts) {
          try {
            const fullSourceName = sourceInput.includes("/") ? `sources/${sourceInput}` : `sources/github/yasserbousrih/${sourceInput}`;
            sourceData = await request(fullSourceName, acc.key);
            ownerAccount = acc;
            break;
          } catch {}
        }

        if (!sourceData) {
          throw new Error(`Source ${sourceInput} not found in any configured Jules account.`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  account: ownerAccount?.name || ownerAccount?.email,
                  source: sourceData,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "jules_create_task": {
        const sourceInput = (args as any).source;
        const promptText = (args as any).prompt;
        const titleText = (args as any).title;
        const branch = (args as any).branch || "main";
        const workingBranch = (args as any).working_branch;
        const autoPr = (args as any).auto_create_pr !== false;
        const requirePlan = !!(args as any).require_plan_approval;
        const envVarsEnabled = (args as any).environment_variables_enabled !== false;
        const preferredAccount = (args as any).account;

        let sourceName = sourceInput;
        if (!sourceName.startsWith("sources/")) {
          sourceName = `sources/github/yasserbousrih/${sourceInput}`;
        }

        const sourceContext: any = {
          source: sourceName,
          githubRepoContext: {
            startingBranch: branch,
          },
          environmentVariablesEnabled: envVarsEnabled,
        };
        if (workingBranch) {
          sourceContext.workingBranch = workingBranch;
        }

        const payload: any = {
          prompt: promptText,
          sourceContext,
          automationMode: autoPr ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
          requirePlanApproval: requirePlan,
        };
        if (titleText) {
          payload.title = titleText;
        }

        const { data: res, account: usedAccount } = await requestWithFallback(
          "sessions",
          { method: "POST" },
          payload,
          preferredAccount
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Task dispatched to Google Jules!\nAccount: ${usedAccount.name || usedAccount.email}\nSession ID: ${res.id || res.name}\nSource: ${sourceName}\nStarting Branch: ${branch}\nState: ${res.state || "QUEUED"}\nAuto PR: ${autoPr}\nPlan Approval Required: ${requirePlan}\nWeb URL: ${res.url || `https://jules.google.com/session/${res.id}`}`,
            },
          ],
        };
      }

      case "jules_batch_dispatch": {
        const tasks = (args as any).tasks || [];
        const results: any[] = [];

        for (const task of tasks) {
          try {
            const { account } = getNextAccount();
            let sourceName = task.source;
            if (!sourceName.startsWith("sources/")) {
              sourceName = `sources/github/yasserbousrih/${task.source}`;
            }

            const sourceContext: any = {
              source: sourceName,
              githubRepoContext: {
                startingBranch: task.branch || "main",
              },
              environmentVariablesEnabled: true,
            };
            if (task.working_branch) {
              sourceContext.workingBranch = task.working_branch;
            }

            const payload: any = {
              prompt: task.prompt,
              sourceContext,
              automationMode: task.auto_create_pr !== false ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
              requirePlanApproval: !!task.require_plan_approval,
            };
            if (task.title) {
              payload.title = task.title;
            }

            const { data: res, account: usedAccount } = await requestWithFallback(
              "sessions",
              { method: "POST" },
              payload,
              account.name || account.email
            );

            results.push({
              source: task.source,
              session_id: res.id || res.name,
              account: usedAccount.name || usedAccount.email,
              state: res.state || "QUEUED",
              url: res.url,
            });
          } catch (e: any) {
            results.push({
              source: task.source,
              error: e.message,
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  dispatched_count: results.filter((r) => !r.error).length,
                  failed_count: results.filter((r) => r.error).length,
                  results,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "jules_list_sessions": {
        const limit = (args as any)?.limit || 20;
        const stateFilter = (args as any)?.state?.toUpperCase();
        const sourceFilter = (args as any)?.source?.toLowerCase();
        const aipFilter = (args as any)?.filter;
        const pageToken = (args as any)?.page_token;
        const accounts = getAccounts();
        let allSessions: any[] = [];

        for (const acc of accounts) {
          try {
            let endpoint = `sessions?pageSize=${limit}`;
            if (pageToken) endpoint += `&pageToken=${encodeURIComponent(pageToken)}`;
            if (aipFilter) endpoint += `&filter=${encodeURIComponent(aipFilter)}`;

            const data = await request(endpoint, acc.key);
            const sessions = (data.sessions || []).map((s: any) => ({
              ...s,
              account: acc.name || acc.email,
            }));
            allSessions.push(...sessions);
          } catch (e: any) {
            allSessions.push({ account: acc.name || acc.email, error: e.message });
          }
        }

        if (stateFilter && stateFilter !== "ALL") {
          allSessions = allSessions.filter((s: any) => s.state === stateFilter);
        }

        if (sourceFilter) {
          allSessions = allSessions.filter(
            (s: any) =>
              s.sourceContext?.source?.toLowerCase().includes(sourceFilter) ||
              s.title?.toLowerCase().includes(sourceFilter)
          );
        }

        return {
          content: [{ type: "text", text: JSON.stringify(allSessions, null, 2) }],
        };
      }

      case "jules_get_session": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const accounts = getAccounts();
        let sessionData: any = null;
        let activitiesData: any = null;
        let ownerAccount: Account | null = null;

        for (const acc of accounts) {
          try {
            sessionData = await request(`sessions/${sid}`, acc.key);
            ownerAccount = acc;
            try {
              activitiesData = await request(`sessions/${sid}/activities?pageSize=50`, acc.key);
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
                  account: ownerAccount?.name || ownerAccount?.email,
                  session: sessionData,
                  activities_count: activitiesData?.activities?.length || 0,
                  activities: activitiesData?.activities || [],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "jules_list_activities": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const pageSize = (args as any)?.page_size || 50;
        const pageToken = (args as any)?.page_token;
        const filter = (args as any)?.filter;
        const accounts = getAccounts();
        let activitiesData: any = null;
        let ownerAccount: Account | null = null;

        for (const acc of accounts) {
          try {
            let endpoint = `sessions/${sid}/activities?pageSize=${pageSize}`;
            if (pageToken) endpoint += `&pageToken=${encodeURIComponent(pageToken)}`;
            if (filter) endpoint += `&filter=${encodeURIComponent(filter)}`;

            activitiesData = await request(endpoint, acc.key);
            ownerAccount = acc;
            break;
          } catch {}
        }

        if (!activitiesData) {
          throw new Error(`Could not list activities for session ${sid}.`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id: sid,
                  account: ownerAccount?.name || ownerAccount?.email,
                  activities_count: activitiesData.activities?.length || 0,
                  nextPageToken: activitiesData.nextPageToken,
                  activities: activitiesData.activities || [],
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "jules_get_activity": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        let actId = (args as any).activity_id.replace(/^sessions\/[^/]+\/activities\//, "");
        const accounts = getAccounts();
        let actData: any = null;
        let ownerAccount: Account | null = null;

        for (const acc of accounts) {
          try {
            actData = await request(`sessions/${sid}/activities/${actId}`, acc.key);
            ownerAccount = acc;
            break;
          } catch {}
        }

        if (!actData) {
          throw new Error(`Activity ${actId} not found in session ${sid}.`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  account: ownerAccount?.name || ownerAccount?.email,
                  activity: actData,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "jules_get_plan": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const accounts = getAccounts();
        let plan: any = null;

        for (const acc of accounts) {
          try {
            const activitiesData = await request(`sessions/${sid}/activities?pageSize=50`, acc.key);
            for (const act of (activitiesData.activities || []).reverse()) {
              if (act.planGenerated?.plan) {
                plan = act.planGenerated.plan;
                break;
              }
            }
            if (plan) break;
          } catch {}
        }

        if (!plan) {
          throw new Error(`No plan found for session ${sid}.`);
        }

        return {
          content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        };
      }

      case "jules_approve_plan": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        let planId = (args as any).plan_id;
        const accounts = getAccounts();

        if (!planId) {
          for (const acc of accounts) {
            try {
              const activitiesData = await request(`sessions/${sid}/activities?pageSize=50`, acc.key);
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

        const { account: usedAccount } = await requestWithFallback(
          `sessions/${sid}:approvePlan`,
          { method: "POST" },
          { planId }
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Plan ${planId} successfully approved for session ${sid} (Account: ${usedAccount.name || usedAccount.email}).`,
            },
          ],
        };
      }

      case "jules_reply_feedback": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const msg = (args as any).message;

        const { account: usedAccount } = await requestWithFallback(
          `sessions/${sid}:sendMessage`,
          { method: "POST" },
          { prompt: msg }
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Feedback reply sent to Jules session ${sid} (Account: ${usedAccount.name || usedAccount.email}).`,
            },
          ],
        };
      }

      case "jules_get_patch": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const accounts = getAccounts();
        let sessionData: any = null;

        for (const acc of accounts) {
          try {
            sessionData = await request(`sessions/${sid}`, acc.key);
            break;
          } catch {}
        }

        if (!sessionData) {
          throw new Error(`Session ${sid} not found.`);
        }

        let patchInfo: any = null;
        for (const out of sessionData.outputs || []) {
          if (out.changeSet?.gitPatch) {
            patchInfo = out.changeSet.gitPatch;
            break;
          }
        }

        if (!patchInfo) {
          throw new Error(`No git patch output found for session ${sid} (current state: ${sessionData.state}).`);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(patchInfo, null, 2),
            },
          ],
        };
      }

      case "jules_inspect_bash_logs": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const accounts = getAccounts();
        const logs: any[] = [];

        for (const acc of accounts) {
          try {
            const data = await request(`sessions/${sid}/activities?pageSize=100`, acc.key);
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
            if (logs.length > 0) break;
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

      case "jules_get_media_artifacts": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const accounts = getAccounts();
        const mediaList: any[] = [];

        for (const acc of accounts) {
          try {
            const data = await request(`sessions/${sid}/activities?pageSize=100`, acc.key);
            for (const act of data.activities || []) {
              for (const art of act.artifacts || []) {
                if (art.media) {
                  mediaList.push({
                    time: act.createTime,
                    description: act.description,
                    mimeType: art.media.mimeType,
                    dataPreview: art.media.data ? `${art.media.data.slice(0, 100)}...` : null,
                  });
                }
              }
            }
            if (mediaList.length > 0) break;
          } catch {}
        }

        return {
          content: [
            {
              type: "text",
              text: mediaList.length ? JSON.stringify(mediaList, null, 2) : `No media artifacts found for session ${sid}.`,
            },
          ],
        };
      }

      case "jules_archive_session": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");
        const unarchive = !!(args as any).unarchive;
        const method = unarchive ? "unarchive" : "archive";

        const { account: usedAccount } = await requestWithFallback(
          `sessions/${sid}:${method}`,
          { method: "POST" },
          {}
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Session ${sid} successfully ${unarchive ? "unarchived" : "archived"} (Account: ${usedAccount.name || usedAccount.email}).`,
            },
          ],
        };
      }

      case "jules_delete_session": {
        const sid = (args as any).session_id.replace(/^sessions\//, "");

        const { account: usedAccount } = await requestWithFallback(
          `sessions/${sid}`,
          { method: "DELETE" }
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Session ${sid} permanently deleted (Account: ${usedAccount.name || usedAccount.email}).`,
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
        const accounts = getAccounts();
        const poolStatus: any[] = [];
        let totalActive = 0;
        let totalCompleted = 0;

        for (const acc of accounts) {
          try {
            const data = await request("sessions", acc.key);
            const sessions = data.sessions || [];
            const active = sessions.filter(
              (s: any) =>
                s.state === "IN_PROGRESS" ||
                s.state === "AWAITING_USER_FEEDBACK" ||
                s.state === "AWAITING_PLAN_APPROVAL"
            );
            const completed = sessions.filter((s: any) => s.state === "COMPLETED");
            totalActive += active.length;
            totalCompleted += completed.length;

            poolStatus.push({
              account: acc.name || acc.email,
              status: "ACTIVE",
              total_sessions: sessions.length,
              active_count: active.length,
              completed_count: completed.length,
              active_sessions: active.map((s: any) => ({
                id: s.id,
                state: s.state,
                title: s.title,
              })),
            });
          } catch (e: any) {
            poolStatus.push({ account: acc.name || acc.email, status: "ERROR", error: e.message });
          }
        }

        const summary = {
          total_accounts: accounts.length,
          daily_request_capacity: accounts.length * 15,
          active_sessions_running: totalActive,
          completed_sessions_stored: totalCompleted,
          accounts: poolStatus,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
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
