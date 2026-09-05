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

async function request(endpoint: string, apiKey: string, options: https.RequestOptions = {}, body?: any): Promise<any> {
  const url = `${API_BASE}/${endpoint}${endpoint.includes("?") ? "&" : "?"}key=${apiKey}`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, timeout: 10000 }, (res) => {
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
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${endpoint} timed out.`));
    });
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
    version: "1.1.0",
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
        name: "jules_check_events",
        description: "Real-time event monitor across all Google accounts in the pool: detects sessions that are stuck (asking questions), awaiting plan approval, completed (with PR/patch details), or failed. The primary harness tool for 'Is Jules done? Is Jules stuck?'.",
        inputSchema: {
          type: "object",
          properties: {
            include_completed: {
              type: "boolean",
              description: "Include recently completed sessions in the report (default true).",
            },
            limit_per_account: {
              type: "number",
              description: "Number of sessions to scan per account (default 20).",
            },
          },
        },
      },
      {
        name: "jules_wait_for_task",
        description: "Synchronously poll/wait for a Google Jules session until completion, failure, plan approval request, or question asking. Bridges async cloud execution directly into harness dialogue.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The Jules session ID to monitor and wait for.",
            },
            timeout_seconds: {
              type: "number",
              description: "Maximum seconds to wait (default 60, max 300).",
            },
            poll_interval_seconds: {
              type: "number",
              description: "Polling interval in seconds (default 5).",
            },
            auto_approve_plan: {
              type: "boolean",
              description: "If true and Jules pauses in AWAITING_PLAN_APPROVAL, automatically approves the plan and keeps waiting (default false).",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_dispatch_and_wait",
        description: "Create a new Jules coding task and immediately block/wait for it in a single MCP tool call. Returns the final PR link, diff patch, or stuck question.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "GitHub repository identifier (e.g. 'Basria-backend' or 'Agent-Brain').",
            },
            prompt: {
              type: "string",
              description: "Instruction prompt detailing the chore, bug fix, or feature.",
            },
            title: {
              type: "string",
              description: "Optional custom title for the session.",
            },
            branch: {
              type: "string",
              description: "Target base starting branch (defaults to 'main' or 'master').",
            },
            auto_create_pr: {
              type: "boolean",
              description: "If true, Jules will automatically push the branch and open a GitHub PR directly in the cloud (defaults to true).",
            },
            auto_approve_plan: {
              type: "boolean",
              description: "If true, automatically approves any execution plan generated by Jules (defaults to true).",
            },
            timeout_seconds: {
              type: "number",
              description: "Maximum seconds to wait for initial results or completion (default 90, max 300).",
            },
          },
          required: ["source", "prompt"],
        },
      },
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
              description: "List of task objects containing source, prompt, and optional title/auto_create_pr.",
              items: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  prompt: { type: "string" },
                  title: { type: "string" },
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
        description: "List and filter all coding sessions across all pooled Google accounts by state, repository source, AIP-160 filter, or pagination token.",
        inputSchema: {
          type: "object",
          properties: {
            state: {
              type: "string",
              description: "Filter by session state (e.g. 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'AWAITING_USER_FEEDBACK', 'AWAITING_PLAN_APPROVAL').",
            },
            source: {
              type: "string",
              description: "Filter by repository name or source path.",
            },
            filter: {
              type: "string",
              description: "AIP-160 filter expression (e.g. 'state = COMPLETED AND createTime > \"2026-01-01T00:00:00Z\"').",
            },
            page_size: {
              type: "number",
              description: "Max sessions to return per account (1-100, default 30).",
            },
            page_token: {
              type: "string",
              description: "Page token for pagination.",
            },
          },
        },
      },
      {
        name: "jules_get_session",
        description: "Retrieve comprehensive details for a specific session ID: status, PR URL, git patch diff, Jules Web URL, failure reason, and activity timeline.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID or full resource name (e.g. 'sessions/13091084449805634763' or '13091084449805634763').",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_list_activities",
        description: "List and stream the full chronological activity trail for a session (agent thoughts, progress updates, bash outputs, user messages, plan events) with pagination and AIP-160 filters.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID or resource name.",
            },
            page_size: {
              type: "number",
              description: "Number of activities to return (1-100, default 30).",
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
        description: "Retrieve a single specific activity event payload by its session ID and activity ID.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID or resource name.",
            },
            activity_id: {
              type: "string",
              description: "The unique activity ID (e.g. 'ade961768a5242ae88ec37948a978d2e').",
            },
          },
          required: ["session_id", "activity_id"],
        },
      },
      {
        name: "jules_get_plan",
        description: "Extract the structured, numbered step-by-step execution plan generated by Jules for a session.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_approve_plan",
        description: "Approve a multi-step execution plan generated by Jules so it can begin implementing changes.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_reply_feedback",
        description: "Send user feedback, unblocking clarification, or follow-up steering instructions directly to an in-progress or paused session.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
            message: {
              type: "string",
              description: "Your instruction, answer to Jules' question, or steering feedback.",
            },
          },
          required: ["session_id", "message"],
        },
      },
      {
        name: "jules_get_patch",
        description: "Extract the clean git unidiff patch and suggested commit message directly from a completed session.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_inspect_bash_logs",
        description: "Extract all terminal shell commands executed inside Google's cloud sandbox, along with exit codes and stdout/stderr output.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_get_media_artifacts",
        description: "Extract visual media artifacts (screenshots, UI renderings, test failure images) generated by Jules in the sandbox.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_archive_session",
        description: "Archive or unarchive a session in Google Jules.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
            unarchive: {
              type: "boolean",
              description: "If true, unarchives the session; if false, archives it (defaults to false).",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_delete_session",
        description: "Permanently delete a session from Google Jules across accounts.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The session ID.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_sync_prs",
        description: "Run local autopilot: extract patches, verify locally with tests, and open GitHub PRs via 'gh'.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Optional specific session ID to process. If omitted, scans all completed sessions.",
            },
            repo_path: {
              type: "string",
              description: "Optional local repo path to test and apply against (e.g. '/root/projects/agent-brain').",
            },
            test_command: {
              type: "string",
              description: "Optional verification command (e.g. 'npm test' or 'pytest').",
            },
          },
        },
      },
      {
        name: "jules_pool_status",
        description: "Check the health, active vs completed count, and remaining quota across all Google accounts in the pool.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (requestPayload) => {
  const { name, arguments: args = {} } = requestPayload.params;

  try {
    // ----------------------------------------------------
    // TOOL 1: jules_check_events (Fast Concurrent Event Watchdog)
    // ----------------------------------------------------
    if (name === "jules_check_events") {
      const includeCompleted = args.include_completed ?? true;
      const limit = Number(args.limit_per_account) || 20;
      const accounts = getAccounts();

      const events: any = {
        stuck: [],
        needs_plan_approval: [],
        completed: [],
        failed: [],
        in_progress: [],
      };

      const accountPromises = accounts.map(async (acc) => {
        const accName = acc.name || acc.email || "Account";
        try {
          const res = await request(`sessions?pageSize=${limit}`, acc.key);
          const sessions = res.sessions || [];

          for (const s of sessions) {
            const sid = s.id || s.name?.replace("sessions/", "");
            const state = s.state || "STATE_UNSPECIFIED";
            const title = s.title || "Untitled Task";
            const source = s.sourceContext?.source?.replace("sources/github/yasserbousrih/", "") || "Unknown Repo";
            const webUrl = s.url || `https://jules.google.com/session/${sid}`;

            if (state === "AWAITING_USER_FEEDBACK") {
              events.stuck.push({
                session_id: sid,
                repo: source,
                title,
                account: accName,
                web_url: webUrl,
                action: `jules_reply_feedback(session_id='${sid}', message='<answer>')`,
              });
            } else if (state === "AWAITING_PLAN_APPROVAL") {
              events.needs_plan_approval.push({
                session_id: sid,
                repo: source,
                title,
                account: accName,
                web_url: webUrl,
                action: `jules_approve_plan(session_id='${sid}')`,
              });
            } else if (state === "COMPLETED" && includeCompleted) {
              let prUrl = null;
              let hasPatch = false;
              for (const out of s.outputs || []) {
                if (out.pullRequest?.url) prUrl = out.pullRequest.url;
                if (out.changeSet?.gitPatch) hasPatch = true;
              }
              events.completed.push({
                session_id: sid,
                repo: source,
                title,
                account: accName,
                pull_request: prUrl,
                has_patch: hasPatch,
                web_url: webUrl,
              });
            } else if (state === "FAILED") {
              events.failed.push({
                session_id: sid,
                repo: source,
                title,
                account: accName,
                web_url: webUrl,
              });
            } else if (state === "IN_PROGRESS") {
              events.in_progress.push({
                session_id: sid,
                repo: source,
                title,
                account: accName,
                web_url: webUrl,
              });
            }
          }
        } catch {}
      });

      await Promise.all(accountPromises);

      let summaryMd = `# Google Jules Pool Live Events\n\n`;
      summaryMd += `• **Stuck (Needs Feedback):** ${events.stuck.length}\n`;
      summaryMd += `• **Needs Plan Approval:** ${events.needs_plan_approval.length}\n`;
      summaryMd += `• **In Progress:** ${events.in_progress.length}\n`;
      summaryMd += `• **Completed:** ${events.completed.length}\n`;
      summaryMd += `• **Failed:** ${events.failed.length}\n\n`;

      if (events.stuck.length > 0) {
        summaryMd += `## 🚨 Stuck Tasks (Needs Feedback)\n`;
        for (const st of events.stuck) {
          summaryMd += `- **Repo:** \`${st.repo}\` | **ID:** \`${st.session_id}\`\n  **Title:** ${st.title}\n  **Action:** \`${st.action}\`\n\n`;
        }
      }

      if (events.needs_plan_approval.length > 0) {
        summaryMd += `## 📋 Plans Awaiting Approval\n`;
        for (const pa of events.needs_plan_approval) {
          summaryMd += `- **Repo:** \`${pa.repo}\` | **ID:** \`${pa.session_id}\`\n  **Title:** ${pa.title}\n  **Approve:** \`${pa.action}\`\n\n`;
        }
      }

      if (events.in_progress.length > 0) {
        summaryMd += `## ⏳ Active In-Progress Tasks\n`;
        for (const ip of events.in_progress) {
          summaryMd += `- **Repo:** \`${ip.repo}\` | **ID:** \`${ip.session_id}\` (${ip.title}) [${ip.account}]\n`;
        }
        summaryMd += `\n`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(events, null, 2),
          },
          {
            type: "text",
            text: summaryMd,
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 2: jules_wait_for_task (Synchronous Poller & Bridge)
    // ----------------------------------------------------
    if (name === "jules_wait_for_task") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 60, 5), 300);
      const intervalSec = Math.min(Math.max(Number(args.poll_interval_seconds) || 5, 2), 30);
      const autoApprove = !!args.auto_approve_plan;

      const startTime = Date.now();
      let lastState = "UNKNOWN";
      let sessionData: any = null;
      let targetAccount: Account | null = null;

      while (Date.now() - startTime < timeoutSec * 1000) {
        try {
          const res = await requestWithFallback(`sessions/${sessionId}`);
          sessionData = res.data;
          targetAccount = res.account;
          lastState = sessionData.state || "STATE_UNSPECIFIED";

          if (lastState === "AWAITING_PLAN_APPROVAL" && autoApprove) {
            try {
              await request(`sessions/${sessionId}:approvePlan`, targetAccount.key, { method: "POST" }, {});
              lastState = "IN_PROGRESS (Auto-approved plan)";
            } catch {}
          } else if (["COMPLETED", "FAILED", "AWAITING_USER_FEEDBACK", "AWAITING_PLAN_APPROVAL"].includes(lastState)) {
            break;
          }
        } catch {}

        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }

      let prUrl = null;
      let patch = null;
      for (const out of sessionData?.outputs || []) {
        if (out.pullRequest?.url) prUrl = out.pullRequest.url;
        if (out.changeSet?.gitPatch) patch = out.changeSet.gitPatch;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: sessionId,
                final_state: lastState,
                duration_seconds: Math.round((Date.now() - startTime) / 1000),
                pull_request: prUrl,
                has_patch: !!patch,
                web_url: sessionData?.url || `https://jules.google.com/session/${sessionId}`,
              },
              null,
              2
            ),
          },
          {
            type: "text",
            text: `### Session ${sessionId} Status: **${lastState}**\n\n` +
              (prUrl ? `• **Pull Request:** ${prUrl}\n` : "") +
              (lastState === "AWAITING_USER_FEEDBACK" ? `• 🚨 **Jules is Stuck:** Reply using \`jules_reply_feedback\`\n` : "") +
              (lastState === "AWAITING_PLAN_APPROVAL" ? `• 📋 **Plan Ready:** Approve using \`jules_approve_plan\`\n` : "") +
              `• **Web URL:** ${sessionData?.url || `https://jules.google.com/session/${sessionId}`}`,
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 3: jules_dispatch_and_wait (Single-call Chore Execution)
    // ----------------------------------------------------
    if (name === "jules_dispatch_and_wait") {
      const sourceInput = args.source as string;
      const prompt = args.prompt as string;
      const title = args.title as string | undefined;
      const branch = (args.branch as string) || "main";
      const autoCreatePr = args.auto_create_pr !== false;
      const autoApprove = args.auto_approve_plan !== false;
      const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 90, 10), 300);

      const sourceResource = sourceInput.startsWith("sources/")
        ? sourceInput
        : `sources/github/yasserbousrih/${sourceInput.replace(/^sources\/github\//, "")}`;

      const payload: any = {
        prompt,
        sourceContext: {
          source: sourceResource,
          githubRepoContext: {
            startingBranch: branch,
          },
        },
        automationMode: autoCreatePr ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
        requirePlanApproval: !autoApprove,
        environmentVariablesEnabled: true,
      };
      if (title) payload.title = title;

      const { data: created, account } = await requestWithFallback("sessions", { method: "POST" }, payload);
      const sid = created.id || created.name?.replace("sessions/", "");

      // Poll / wait loop
      const startTime = Date.now();
      let lastState = created.state || "IN_PROGRESS";
      let sessionData = created;

      while (Date.now() - startTime < timeoutSec * 1000) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          sessionData = await request(`sessions/${sid}`, account.key);
          lastState = sessionData.state || "STATE_UNSPECIFIED";
          if (lastState === "AWAITING_PLAN_APPROVAL" && autoApprove) {
            try {
              await request(`sessions/${sid}:approvePlan`, account.key, { method: "POST" }, {});
              lastState = "IN_PROGRESS (Auto-approved plan)";
            } catch {}
          } else if (["COMPLETED", "FAILED", "AWAITING_USER_FEEDBACK", "AWAITING_PLAN_APPROVAL"].includes(lastState)) {
            break;
          }
        } catch {}
      }

      let prUrl = null;
      for (const out of sessionData?.outputs || []) {
        if (out.pullRequest?.url) prUrl = out.pullRequest.url;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: sid,
                state: lastState,
                account: account.name || account.email,
                pull_request: prUrl,
                web_url: sessionData.url || `https://jules.google.com/session/${sid}`,
              },
              null,
              2
            ),
          },
          {
            type: "text",
            text: `### Task Dispatched to Google Jules\n\n• **Session ID:** \`${sid}\`\n• **Current State:** **${lastState}**\n• **Account:** ${account.name || account.email}\n` +
              (prUrl ? `• **Pull Request Opened:** ${prUrl}\n` : "") +
              `• **Web URL:** ${sessionData.url || `https://jules.google.com/session/${sid}`}`,
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 4: jules_list_sources
    // ----------------------------------------------------
    if (name === "jules_list_sources") {
      const pageSize = Number(args.page_size) || 30;
      const pageToken = args.page_token as string | undefined;
      const filter = args.filter as string | undefined;
      const accounts = getAccounts();

      let allSources: any[] = [];
      const seenSources = new Set<string>();

      for (const acc of accounts) {
        try {
          let qs = `pageSize=${pageSize}`;
          if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;
          if (filter) qs += `&filter=${encodeURIComponent(filter)}`;

          const res = await request(`sources?${qs}`, acc.key);
          for (const s of res.sources || []) {
            if (!seenSources.has(s.name)) {
              seenSources.add(s.name);
              allSources.push({
                ...s,
                _account: acc.name || acc.email,
              });
            }
          }
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sources: allSources, count: allSources.length }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 5: jules_get_source
    // ----------------------------------------------------
    if (name === "jules_get_source") {
      const sourceInput = args.source as string;
      const sourceResource = sourceInput.startsWith("sources/")
        ? sourceInput
        : `sources/github/yasserbousrih/${sourceInput.replace(/^sources\/github\//, "")}`;

      const { data, account } = await requestWithFallback(sourceResource);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ source: data, resolved_account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 6: jules_create_task
    // ----------------------------------------------------
    if (name === "jules_create_task") {
      const sourceInput = args.source as string;
      const prompt = args.prompt as string;
      const title = args.title as string | undefined;
      const branch = (args.branch as string) || "main";
      const workingBranch = args.working_branch as string | undefined;
      const autoCreatePr = args.auto_create_pr !== false;
      const requirePlanApproval = !!args.require_plan_approval;
      const envVarsEnabled = args.environment_variables_enabled !== false;
      const accountTarget = args.account as string | undefined;

      const sourceResource = sourceInput.startsWith("sources/")
        ? sourceInput
        : `sources/github/yasserbousrih/${sourceInput.replace(/^sources\/github\//, "")}`;

      const payload: any = {
        prompt,
        sourceContext: {
          source: sourceResource,
          githubRepoContext: {
            startingBranch: branch,
          },
        },
        automationMode: autoCreatePr ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
        requirePlanApproval,
        environmentVariablesEnabled: envVarsEnabled,
      };

      if (title) payload.title = title;
      if (workingBranch) payload.sourceContext.githubRepoContext.workingBranch = workingBranch;

      const { data, account } = await requestWithFallback("sessions", { method: "POST" }, payload, accountTarget);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: data.id || data.name?.replace("sessions/", ""),
                account_used: account.name || account.email,
                state: data.state,
                web_url: data.url || `https://jules.google.com/session/${data.id || data.name?.replace("sessions/", "")}`,
                full_response: data,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 7: jules_batch_dispatch
    // ----------------------------------------------------
    if (name === "jules_batch_dispatch") {
      const tasks = args.tasks as any[];
      const results: any[] = [];

      for (const t of tasks) {
        try {
          const sourceResource = t.source.startsWith("sources/")
            ? t.source
            : `sources/github/yasserbousrih/${t.source.replace(/^sources\/github\//, "")}`;

          const payload: any = {
            prompt: t.prompt,
            sourceContext: {
              source: sourceResource,
              githubRepoContext: {
                startingBranch: t.branch || "main",
              },
            },
            automationMode: t.auto_create_pr !== false ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
            requirePlanApproval: !!t.require_plan_approval,
            environmentVariablesEnabled: true,
          };
          if (t.title) payload.title = t.title;

          const { data, account } = await requestWithFallback("sessions", { method: "POST" }, payload);
          results.push({
            status: "success",
            source: t.source,
            session_id: data.id || data.name?.replace("sessions/", ""),
            account: account.name || account.email,
            web_url: data.url || `https://jules.google.com/session/${data.id || data.name?.replace("sessions/", "")}`,
          });
        } catch (err: any) {
          results.push({
            status: "error",
            source: t.source,
            error: err.message,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ batch_results: results }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 8: jules_list_sessions
    // ----------------------------------------------------
    if (name === "jules_list_sessions") {
      const state = args.state as string | undefined;
      const source = args.source as string | undefined;
      const filter = args.filter as string | undefined;
      const pageSize = Number(args.page_size) || 30;
      const pageToken = args.page_token as string | undefined;
      const accounts = getAccounts();

      let allSessions: any[] = [];
      const seenSessions = new Set<string>();

      for (const acc of accounts) {
        try {
          let qs = `pageSize=${pageSize}`;
          if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;
          if (filter) qs += `&filter=${encodeURIComponent(filter)}`;

          const res = await request(`sessions?${qs}`, acc.key);
          for (const s of res.sessions || []) {
            const sid = s.id || s.name?.replace("sessions/", "");
            if (!seenSessions.has(sid)) {
              seenSessions.add(sid);

              if (state && s.state && s.state.toLowerCase() !== state.toLowerCase()) {
                continue;
              }
              if (source && s.sourceContext?.source && !s.sourceContext.source.toLowerCase().includes(source.toLowerCase())) {
                continue;
              }

              allSessions.push({
                ...s,
                _account: acc.name || acc.email,
              });
            }
          }
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sessions: allSessions, count: allSessions.length }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 9: jules_get_session
    // ----------------------------------------------------
    if (name === "jules_get_session") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data, account } = await requestWithFallback(`sessions/${sessionId}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session: data, resolved_account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 10: jules_list_activities
    // ----------------------------------------------------
    if (name === "jules_list_activities") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const pageSize = Number(args.page_size) || 30;
      const pageToken = args.page_token as string | undefined;
      const filter = args.filter as string | undefined;

      let qs = `pageSize=${pageSize}`;
      if (pageToken) qs += `&pageToken=${encodeURIComponent(pageToken)}`;
      if (filter) qs += `&filter=${encodeURIComponent(filter)}`;

      const { data, account } = await requestWithFallback(`sessions/${sessionId}/activities?${qs}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...data, resolved_account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 11: jules_get_activity
    // ----------------------------------------------------
    if (name === "jules_get_activity") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const activityId = (args.activity_id as string).replace(/^.*activities\//, "");

      const { data, account } = await requestWithFallback(`sessions/${sessionId}/activities/${activityId}`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ activity: data, resolved_account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 12: jules_get_plan
    // ----------------------------------------------------
    if (name === "jules_get_plan") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data } = await requestWithFallback(`sessions/${sessionId}/activities?pageSize=50`);

      const activities = data.activities || [];
      for (const act of activities) {
        if (act.planGenerated && act.planGenerated.plan) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ plan: act.planGenerated.plan, activity_id: act.id }, null, 2),
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ message: "No plan has been generated for this session yet." }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 13: jules_approve_plan
    // ----------------------------------------------------
    if (name === "jules_approve_plan") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data, account } = await requestWithFallback(
        `sessions/${sessionId}:approvePlan`,
        { method: "POST" },
        {}
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ approved: true, response: data, account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 14: jules_reply_feedback
    // ----------------------------------------------------
    if (name === "jules_reply_feedback") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const message = args.message as string;

      const { data, account } = await requestWithFallback(
        `sessions/${sessionId}:sendMessage`,
        { method: "POST" },
        { message }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sent: true, response: data, account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 15: jules_get_patch
    // ----------------------------------------------------
    if (name === "jules_get_patch") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data } = await requestWithFallback(`sessions/${sessionId}`);

      let gitPatch = null;
      let commitMessage = null;
      for (const out of data.outputs || []) {
        if (out.changeSet) {
          gitPatch = out.changeSet.gitPatch;
          commitMessage = out.changeSet.suggestedCommitMessage;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                session_id: sessionId,
                commit_message: commitMessage,
                has_patch: !!gitPatch,
                git_patch: gitPatch || "No git patch found in outputs.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 16: jules_inspect_bash_logs
    // ----------------------------------------------------
    if (name === "jules_inspect_bash_logs") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data } = await requestWithFallback(`sessions/${sessionId}/activities?pageSize=100`);

      const bashLogs: any[] = [];
      for (const act of data.activities || []) {
        for (const art of act.artifacts || []) {
          if (art.bashOutput) {
            bashLogs.push({
              activity_id: act.id,
              command: art.bashOutput.command,
              exit_code: art.bashOutput.exitCode,
              output: art.bashOutput.output,
            });
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session_id: sessionId, bash_commands_count: bashLogs.length, logs: bashLogs }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 17: jules_get_media_artifacts
    // ----------------------------------------------------
    if (name === "jules_get_media_artifacts") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data } = await requestWithFallback(`sessions/${sessionId}/activities?pageSize=100`);

      const mediaArtifacts: any[] = [];
      for (const act of data.activities || []) {
        for (const art of act.artifacts || []) {
          if (art.media) {
            mediaArtifacts.push({
              activity_id: act.id,
              media: art.media,
            });
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session_id: sessionId, media_count: mediaArtifacts.length, media: mediaArtifacts }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 18: jules_archive_session
    // ----------------------------------------------------
    if (name === "jules_archive_session") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const unarchive = !!args.unarchive;
      const endpoint = unarchive ? `sessions/${sessionId}:unarchive` : `sessions/${sessionId}:archive`;

      const { data, account } = await requestWithFallback(endpoint, { method: "POST" }, {});

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ archived: !unarchive, response: data, account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 19: jules_delete_session
    // ----------------------------------------------------
    if (name === "jules_delete_session") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data, account } = await requestWithFallback(`sessions/${sessionId}`, { method: "DELETE" });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ deleted: true, response: data, account: account.name || account.email }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 20: jules_sync_prs
    // ----------------------------------------------------
    if (name === "jules_sync_prs") {
      const sessionId = args.session_id as string | undefined;
      const scriptPath = "/root/.local/bin/jules-sync-prs";

      if (fs.existsSync(scriptPath)) {
        try {
          const cmd = sessionId ? `${scriptPath} --session ${sessionId}` : scriptPath;
          const output = execSync(cmd, { encoding: "utf-8", timeout: 120000 });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "success", output }, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "error", error: err.message, stderr: err.stderr?.toString() }, null, 2),
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `Sync script not found at ${scriptPath}` }, null, 2),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 21: jules_pool_status
    // ----------------------------------------------------
    if (name === "jules_pool_status") {
      const accounts = getAccounts();
      const status: any[] = [];
      let totalActive = 0;
      let totalCompleted = 0;

      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        const accName = acc.name || acc.email || `Account-${i + 1}`;
        try {
          const res = await request("sessions?pageSize=50", acc.key);
          const sessions = res.sessions || [];
          const active = sessions.filter((s: any) => s.state === "IN_PROGRESS").length;
          const completed = sessions.filter((s: any) => s.state === "COMPLETED").length;
          totalActive += active;
          totalCompleted += completed;

          status.push({
            account: accName,
            status: "ACTIVE",
            daily_quota: "15 tasks / 24h",
            active_sessions: active,
            completed_sessions: completed,
            total_loaded: sessions.length,
          });
        } catch (err: any) {
          status.push({
            account: accName,
            status: "ERROR",
            error: err.message,
          });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                accounts_count: accounts.length,
                total_daily_quota: `${accounts.length * 15} tasks / 24h`,
                total_in_flight: totalActive,
                total_completed: totalCompleted,
                pool: status,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool name: ${name}`);
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Jules MCP Server Error: ${error.message || String(error)}`,
        },
      ],
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Jules MCP Server running on stdio (21 tools)\n");
}

run().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
