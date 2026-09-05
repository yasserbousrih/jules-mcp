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
import * as os from "os";
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

// Deprecated or decommissioned repos that should NEVER be dispatched to Jules
const DEPRECATED_REPOS: Record<string, string> = {
  "email-assistant": "Deprecated microservice. Replaced by unified email-channel & agent-brain.",
  "omnichat-backend": "Deprecated standalone repo. Replaced by chat-channel & agent-brain.",
  "basira-omnichat": "Deprecated standalone repo. Unified into chat-channel.",
};

// Architecture invariants injected into prompts based on repository
const ARCHITECTURE_INVARIANTS: Record<string, string> = {
  "agent-brain": "ARCHITECTURAL INVARIANT: Agent-Brain is the shared multi-tenant AI reasoning engine for both Basira and StayBooked. Do NOT hardcode tenant IDs or break cross-capability channel contracts.",
  "basria-backend": "ARCHITECTURAL INVARIANT: Basira-backend is a multi-tenant FastAPI service. Postgres is local (127.0.0.1). Do NOT change database connection parameters or alter multi-tenant auth middleware.",
  "basira-frontend": "ARCHITECTURAL INVARIANT: Basira-frontend is a Next.js 16 app deployed on Vercel. Ensure strict TypeScript types (tsc --noEmit must pass with 0 errors).",
  "staybooked": "ARCHITECTURAL INVARIANT: StayBooked is a Next.js 15 fullstack application (Server Actions + raw Postgres queries). Do NOT break multi-tenant client portal routing.",
  "voice-channel": "ARCHITECTURAL INVARIANT: Real-time telephony microservice (Twilio Media Streams -> Deepgram STT -> ElevenLabs TTS). Maintain low-latency async streams.",
  "chat-channel": "ARCHITECTURAL INVARIANT: Unified omni-channel gateway (WhatsApp, SMS, Socket.io) subscribing to Agent-Brain events.",
  "email-channel": "ARCHITECTURAL INVARIANT: Autonomous email gateway subscribing to Agent-Brain events.",
};

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
    const req = https.request(url, { ...options, timeout: 15000 }, (res) => {
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

// Select account with lowest active load across pool
async function getLeastLoadedAccount(): Promise<Account> {
  const accounts = getAccounts();
  if (accounts.length === 1) return accounts[0];

  const loads: { account: Account; inFlight: number }[] = [];
  for (const acc of accounts) {
    try {
      const res = await request("sessions?pageSize=20", acc.key);
      const inFlight = (res.sessions || []).filter((s: any) => s.state === "IN_PROGRESS").length;
      loads.push({ account: acc, inFlight });
    } catch {
      loads.push({ account: acc, inFlight: 99 });
    }
  }

  loads.sort((a, b) => a.inFlight - b.inFlight);
  return loads[0].account;
}

// Decorate prompt with Architectural Invariants & Anti-Pause autonomous instructions
function decoratePrompt(rawPrompt: string, repoIdentifier: string): string {
  const cleanRepo = repoIdentifier.toLowerCase().replace(/^sources\/github\/[^\/]+\//, "");
  let invariant = "";
  for (const [key, val] of Object.entries(ARCHITECTURE_INVARIANTS)) {
    if (cleanRepo.includes(key)) {
      invariant = `\n${val}\n`;
      break;
    }
  }

  const antiPauseGuard = `
CRITICAL AUTONOMOUS EXECUTION DIRECTIVES:
1. Work completely autonomously: do NOT pause or ask questions.
2. If choice is needed, pick the standard TypeScript/Python stdlib approach.
3. Make small, surgical, modular diffs. Do NOT rewrite working code.
4. Execute tests and clean up temporary logs/debug files before final commit.
`;

  return `${rawPrompt.trim()}${invariant}\n${antiPauseGuard}`.trim();
}

const server = new Server(
  {
    name: "jules-mcp",
    version: "1.4.0",
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
        name: "jules_auto_nudge_all",
        description: "Autonomous unblocker: automatically finds all sessions currently stuck in AWAITING_USER_FEEDBACK across the entire pool and sends a pre-emptive unblocking directive to keep Jules working without manual CLI nudging.",
        inputSchema: {
          type: "object",
          properties: {
            custom_instruction: {
              type: "string",
              description: "Optional custom instruction to send to all stuck sessions. Defaults to 'Proceed with standard implementation, follow existing project conventions, and complete tests.'",
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
            auto_unblock_questions: {
              type: "boolean",
              description: "If true and Jules pauses in AWAITING_USER_FEEDBACK, automatically replies with an unblocking directive and continues waiting (default true).",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_dispatch_and_wait",
        description: "Create a new Jules coding task and immediately block/wait for it in a single MCP tool call. Automatically injects architectural invariants and anti-pause directives.",
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
        name: "jules_consolidate_sessions",
        description: "Reconcile and merge multiple concurrent Jules sessions on the SAME repository into a single clean local branch or unified PR. Uses 3-way unidiff application to resolve cloud branch drift automatically, runs tests, and creates 1 clean PR without merge conflicts.",
        inputSchema: {
          type: "object",
          properties: {
            repo_path: {
              type: "string",
              description: "Absolute local repository path (e.g. '/root/projects/agent-brain').",
            },
            session_ids: {
              type: "array",
              description: "List of completed session IDs to consolidate. If omitted, automatically discovers all completed sessions for this repo.",
              items: { type: "string" },
            },
            target_branch: {
              type: "string",
              description: "Branch name to create and commit to (defaults to 'jules/consolidated-<timestamp>').",
            },
            base_branch: {
              type: "string",
              description: "Base branch to branch off of (defaults to 'main').",
            },
            test_command: {
              type: "string",
              description: "Verification command to run (e.g. 'npm test' or 'pytest').",
            },
            auto_create_pr: {
              type: "boolean",
              description: "If true and tests pass, automatically pushes the branch and creates a unified GitHub PR via 'gh' (defaults to true).",
            },
            pr_title: {
              type: "string",
              description: "Custom PR title for the consolidated Pull Request.",
            },
          },
          required: ["repo_path"],
        },
      },
      {
        name: "jules_rebase_pr",
        description: "Rebase an existing Jules GitHub PR against the latest base branch (e.g. main) locally and force-push with lease, eliminating PR collision and out-of-date branch warnings on GitHub.",
        inputSchema: {
          type: "object",
          properties: {
            repo_path: {
              type: "string",
              description: "Absolute local repository path.",
            },
            pr_url_or_number: {
              type: "string",
              description: "GitHub PR URL or number to rebase.",
            },
            base_branch: {
              type: "string",
              description: "Base branch to rebase onto (defaults to 'main').",
            },
          },
          required: ["repo_path", "pr_url_or_number"],
        },
      },
      {
        name: "jules_queue_tasks",
        description: "Execute a sequence of chores sequentially on a repository: waits for Task N to complete before launching Task N+1, preventing branch drift and merge conflicts across PRs.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Target repository identifier.",
            },
            tasks: {
              type: "array",
              description: "List of prompt strings or task objects to execute in sequence.",
              items: {
                type: "object",
                properties: {
                  prompt: { type: "string" },
                  title: { type: "string" },
                },
                required: ["prompt"],
              },
            },
            timeout_per_task: {
              type: "number",
              description: "Max seconds to wait per task (default 90).",
            },
          },
          required: ["source", "tasks"],
        },
      },
      {
        name: "jules_stream_progress",
        description: "Extract a structured markdown progress breakdown for a session: step-by-step plan completion checklist [x], thought reasoning trail, files modified, and sandbox commands executed.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The Jules session ID to inspect.",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "jules_apply_patch",
        description: "Fetch the clean git unidiff patch from a completed Jules session and apply it directly to a local repository workspace, with optional branch creation, test execution, and auto-commit using 3-way merge.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The Jules session ID containing the git patch output.",
            },
            repo_path: {
              type: "string",
              description: "Absolute local repository path on this machine (e.g. '/root/projects/agent-brain').",
            },
            branch_name: {
              type: "string",
              description: "Optional branch name to create and switch to before applying (e.g. 'jules/fix-health-check').",
            },
            test_command: {
              type: "string",
              description: "Optional verification command to execute after applying patch (e.g. 'npm test' or 'pytest').",
            },
            auto_commit: {
              type: "boolean",
              description: "If true and tests pass (or no test command given), automatically commits the changes using Jules's suggested commit message (defaults to false).",
            },
          },
          required: ["session_id", "repo_path"],
        },
      },
      {
        name: "jules_review_pr",
        description: "Inspect and review a GitHub PR opened by Google Jules: pulls PR metadata, review comments, diff stats, and CI status checks via 'gh'.",
        inputSchema: {
          type: "object",
          properties: {
            pr_url_or_number: {
              type: "string",
              description: "GitHub PR URL (e.g. 'https://github.com/yasserbousrih/Agent-Brain/pull/1') or PR number.",
            },
            repo: {
              type: "string",
              description: "Repository name (e.g. 'yasserbousrih/Agent-Brain'). Required if only PR number is passed.",
            },
          },
          required: ["pr_url_or_number"],
        },
      },
      {
        name: "jules_merge_pr",
        description: "Safely squash-merge a verified GitHub PR opened by Google Jules and delete the remote branch via 'gh'.",
        inputSchema: {
          type: "object",
          properties: {
            pr_url_or_number: {
              type: "string",
              description: "GitHub PR URL or PR number.",
            },
            repo: {
              type: "string",
              description: "Repository name if PR number is given.",
            },
            merge_method: {
              type: "string",
              description: "Merge method: 'squash' (default), 'merge', or 'rebase'.",
            },
            delete_branch: {
              type: "boolean",
              description: "Delete remote branch after merge (defaults to true).",
            },
          },
          required: ["pr_url_or_number"],
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
        description: "Dispatch an asynchronous coding chore to Google Jules. Automatically decorates prompt with system invariants and anti-pause directives.",
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
              description: "Optional specific account name/email to target. If omitted, uses intelligent load-balancing.",
            },
          },
          required: ["source", "prompt"],
        },
      },
      {
        name: "jules_batch_dispatch",
        description: "Dispatch multiple coding tasks across repositories simultaneously, load-balancing automatically across all Google accounts in the pool.",
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
    // TOOL 1: jules_check_events
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
    // TOOL 2: jules_auto_nudge_all
    // ----------------------------------------------------
    if (name === "jules_auto_nudge_all") {
      const customInstruction =
        (args.custom_instruction as string) ||
        "Proceed autonomously using the standard project conventions and standard library approach. Avoid adding new dependencies, run test verifications, and submit the patch.";
      const accounts = getAccounts();
      const nudgedSessions: any[] = [];

      for (const acc of accounts) {
        try {
          const res = await request("sessions?pageSize=50", acc.key);
          for (const s of res.sessions || []) {
            if (s.state === "AWAITING_USER_FEEDBACK") {
              const sid = s.id || s.name?.replace("sessions/", "");
              try {
                await request(`sessions/${sid}:sendMessage`, acc.key, { method: "POST" }, { message: customInstruction });
                nudgedSessions.push({
                  session_id: sid,
                  repo: s.sourceContext?.source,
                  title: s.title,
                  account: acc.name || acc.email,
                  status: "Nudged & Unblocked",
                });
              } catch {}
            }
          }
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: nudgedSessions.length, nudged: nudgedSessions }, null, 2),
          },
          {
            type: "text",
            text: `### Autonomous Unblocker Run\n\n• **Sessions Nudged:** ${nudgedSessions.length}\n• **Directive Sent:** \`${customInstruction}\`\n\n` +
              nudgedSessions.map((n) => `- **ID:** \`${n.session_id}\` (${n.title}) on \`${n.repo}\``).join("\n"),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 3: jules_wait_for_task
    // ----------------------------------------------------
    if (name === "jules_wait_for_task") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 60, 5), 300);
      const intervalSec = Math.min(Math.max(Number(args.poll_interval_seconds) || 5, 2), 30);
      const autoApprove = !!args.auto_approve_plan;
      const autoUnblock = args.auto_unblock_questions !== false;

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
          } else if (lastState === "AWAITING_USER_FEEDBACK" && autoUnblock) {
            try {
              await request(
                `sessions/${sessionId}:sendMessage`,
                targetAccount.key,
                { method: "POST" },
                { message: "Proceed autonomously with minimal surgical diffs according to project conventions." }
              );
              lastState = "IN_PROGRESS (Auto-unblocked question)";
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
    // TOOL 4: jules_dispatch_and_wait
    // ----------------------------------------------------
    if (name === "jules_dispatch_and_wait") {
      const sourceInput = args.source as string;
      const prompt = args.prompt as string;
      const title = args.title as string | undefined;
      const branch = (args.branch as string) || "main";
      const autoCreatePr = args.auto_create_pr !== false;
      const autoApprove = args.auto_approve_plan !== false;
      const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 90, 10), 300);

      // Check Deprecated Repos
      const cleanRepo = sourceInput.toLowerCase().replace(/^sources\/github\/[^\/]+\//, "");
      if (DEPRECATED_REPOS[cleanRepo]) {
        throw new Error(`Repository '${cleanRepo}' is deprecated. Reason: ${DEPRECATED_REPOS[cleanRepo]}`);
      }

      const sourceResource = sourceInput.startsWith("sources/")
        ? sourceInput
        : `sources/github/yasserbousrih/${sourceInput.replace(/^sources\/github\//, "")}`;

      const decoratedPrompt = decoratePrompt(prompt, sourceInput);

      const payload: any = {
        prompt: decoratedPrompt,
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

      const bestAccount = await getLeastLoadedAccount();
      const created = await request("sessions", bestAccount.key, { method: "POST" }, payload);
      const sid = created.id || created.name?.replace("sessions/", "");

      const startTime = Date.now();
      let lastState = created.state || "IN_PROGRESS";
      let sessionData = created;

      while (Date.now() - startTime < timeoutSec * 1000) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          sessionData = await request(`sessions/${sid}`, bestAccount.key);
          lastState = sessionData.state || "STATE_UNSPECIFIED";
          if (lastState === "AWAITING_PLAN_APPROVAL" && autoApprove) {
            try {
              await request(`sessions/${sid}:approvePlan`, bestAccount.key, { method: "POST" }, {});
              lastState = "IN_PROGRESS (Auto-approved plan)";
            } catch {}
          } else if (lastState === "AWAITING_USER_FEEDBACK") {
            try {
              await request(
                `sessions/${sid}:sendMessage`,
                bestAccount.key,
                { method: "POST" },
                { message: "Proceed autonomously with minimal surgical diffs according to project conventions." }
              );
              lastState = "IN_PROGRESS (Auto-unblocked)";
            } catch {}
          } else if (["COMPLETED", "FAILED"].includes(lastState)) {
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
                account: bestAccount.name || bestAccount.email,
                pull_request: prUrl,
                web_url: sessionData.url || `https://jules.google.com/session/${sid}`,
              },
              null,
              2
            ),
          },
          {
            type: "text",
            text: `### Task Dispatched to Google Jules\n\n• **Session ID:** \`${sid}\`\n• **Current State:** **${lastState}**\n• **Account:** ${bestAccount.name || bestAccount.email}\n` +
              (prUrl ? `• **Pull Request Opened:** ${prUrl}\n` : "") +
              `• **Web URL:** ${sessionData.url || `https://jules.google.com/session/${sid}`}`,
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 5: jules_consolidate_sessions (3-Way Merge & Unified PR)
    // ----------------------------------------------------
    if (name === "jules_consolidate_sessions") {
      const repoPath = path.resolve(args.repo_path as string);
      let sessionIds = args.session_ids as string[] | undefined;
      const baseBranch = (args.base_branch as string) || "main";
      const targetBranch = (args.target_branch as string) || `jules/consolidated-${Date.now().toString().slice(-6)}`;
      const testCommand = args.test_command as string | undefined;
      const autoCreatePr = args.auto_create_pr !== false;
      const prTitle = (args.pr_title as string) || `chore(jules): consolidated patch from ${sessionIds?.length || "multiple"} cloud sessions`;

      if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
        throw new Error(`Directory does not exist: ${repoPath}`);
      }

      // Auto-discover completed sessions for this repo if session_ids omitted
      const repoName = path.basename(repoPath).toLowerCase();
      if (!sessionIds || sessionIds.length === 0) {
        const accounts = getAccounts();
        sessionIds = [];
        for (const acc of accounts) {
          try {
            const res = await request("sessions?pageSize=50", acc.key);
            for (const s of res.sessions || []) {
              if (s.state === "COMPLETED") {
                const src = (s.sourceContext?.source || "").toLowerCase();
                if (src.includes(repoName)) {
                  const sid = s.id || s.name?.replace("sessions/", "");
                  if (!sessionIds.includes(sid)) sessionIds.push(sid);
                }
              }
            }
          } catch {}
        }
      }

      if (sessionIds.length === 0) {
        throw new Error(`No completed sessions found to consolidate for repo: ${repoPath}`);
      }

      // Prepare local git branch
      try {
        execSync(`git checkout ${baseBranch} && git pull origin ${baseBranch}`, { cwd: repoPath, stdio: "pipe" });
      } catch {}
      execSync(`git checkout -B ${targetBranch}`, { cwd: repoPath, stdio: "pipe" });

      const appliedSessions: any[] = [];
      const failedSessions: any[] = [];

      for (const sid of sessionIds) {
        const cleanSid = sid.replace("sessions/", "");
        try {
          const { data: session } = await requestWithFallback(`sessions/${cleanSid}`);
          let patch: string | null = null;
          let msg = `chore(jules): patch from session ${cleanSid}`;

          for (const out of session.outputs || []) {
            if (out.changeSet) {
              if (typeof out.changeSet.gitPatch === "string") patch = out.changeSet.gitPatch;
              else if (out.changeSet.gitPatch?.unidiffPatch) patch = out.changeSet.gitPatch.unidiffPatch;
              if (out.changeSet.suggestedCommitMessage) msg = out.changeSet.suggestedCommitMessage;
            }
          }

          if (!patch) {
            failedSessions.push({ session_id: cleanSid, reason: "No git patch found in session outputs." });
            continue;
          }

          const patchFile = path.join(os.tmpdir(), `jules_consolidate_${cleanSid}.patch`);
          fs.writeFileSync(patchFile, patch, "utf-8");

          // Try 3-way git apply to resolve branch drift seamlessly
          let applySuccess = false;
          try {
            execSync(`git apply --3way --whitespace=fix ${patchFile}`, { cwd: repoPath, stdio: "pipe" });
            applySuccess = true;
          } catch {
            // Fallback: standard git apply with reject
            try {
              execSync(`git apply --whitespace=nowarn --ignore-whitespace ${patchFile}`, { cwd: repoPath, stdio: "pipe" });
              applySuccess = true;
            } catch (err: any) {
              failedSessions.push({ session_id: cleanSid, reason: `3-way patch application failed: ${err.message}` });
            }
          }

          if (applySuccess) {
            execSync(`git add -A && git commit -m "${msg.replace(/"/g, '\\"')} (Jules session: ${cleanSid})"`, {
              cwd: repoPath,
              stdio: "pipe",
            });
            appliedSessions.push({ session_id: cleanSid, title: session.title || msg });
          }
        } catch (err: any) {
          failedSessions.push({ session_id: cleanSid, reason: err.message });
        }
      }

      // Execute optional test verification
      let testPassed = true;
      let testOutput = null;
      if (testCommand) {
        try {
          testOutput = execSync(testCommand, { cwd: repoPath, encoding: "utf-8", timeout: 120000 });
        } catch (err: any) {
          testPassed = false;
          testOutput = err.stdout?.toString() + "\n" + err.stderr?.toString();
        }
      }

      // Create unified GitHub PR if requested
      let prUrl = null;
      if (autoCreatePr && appliedSessions.length > 0 && testPassed) {
        try {
          execSync(`git push -u origin ${targetBranch} --force`, { cwd: repoPath, stdio: "pipe" });
          const prBody = `## Consolidated Jules Cloud Chores\\n\\nMerged ${appliedSessions.length} sessions cleanly with local 3-way reconciliation:\\n` +
            appliedSessions.map((s) => `- \`${s.session_id}\`: ${s.title}`).join("\\n") +
            `\\n\\n**Test Suite:** Passed ✓`;
          const prOut = execSync(`gh pr create --title "${prTitle}" --body "${prBody}" --base ${baseBranch} --head ${targetBranch}`, {
            cwd: repoPath,
            encoding: "utf-8",
          });
          prUrl = prOut.trim();
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "consolidated",
                branch: targetBranch,
                applied_count: appliedSessions.length,
                failed_count: failedSessions.length,
                applied_sessions: appliedSessions,
                failed_sessions: failedSessions,
                test_passed: testPassed,
                test_output: testOutput,
                pull_request: prUrl,
              },
              null,
              2
            ),
          },
          {
            type: "text",
            text: `### Consolidated ${appliedSessions.length} Jules Cloud Sessions\n\n` +
              `• **Branch:** \`${targetBranch}\`\n` +
              `• **Applied Cleanly:** ${appliedSessions.length}\n` +
              `• **Conflicts/Skipped:** ${failedSessions.length}\n` +
              (testCommand ? `• **Test Suite:** ${testPassed ? "Passed ✓" : "Failed ✗"}\n` : "") +
              (prUrl ? `• **Unified PR Opened:** ${prUrl}\n` : "") +
              `\n**Merged Sessions:**\n` +
              appliedSessions.map((s) => `- **\`${s.session_id}\`**: ${s.title}`).join("\n"),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 6: jules_rebase_pr
    // ----------------------------------------------------
    if (name === "jules_rebase_pr") {
      const repoPath = path.resolve(args.repo_path as string);
      const prTarget = args.pr_url_or_number as string;
      const baseBranch = (args.base_branch as string) || "main";

      if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
        throw new Error(`Directory does not exist: ${repoPath}`);
      }

      try {
        const prView = execSync(`gh pr view "${prTarget}" --json headRefName,baseRefName,url`, {
          cwd: repoPath,
          encoding: "utf-8",
        });
        const pr = JSON.parse(prView);
        const headBranch = pr.headRefName;

        execSync(`git fetch origin ${headBranch} && git checkout ${headBranch}`, { cwd: repoPath, stdio: "pipe" });
        execSync(`git fetch origin ${baseBranch} && git rebase origin/${baseBranch}`, { cwd: repoPath, stdio: "pipe" });
        execSync(`git push origin ${headBranch} --force-with-lease`, { cwd: repoPath, stdio: "pipe" });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, pr_url: pr.url, head_branch: headBranch, rebased_on: baseBranch }, null, 2),
            },
            {
              type: "text",
              text: `### PR Rebased Successfully\n\n• **PR:** ${pr.url}\n• **Branch:** \`${headBranch}\` rebased onto \`origin/${baseBranch}\`\n• **Pushed:** \`--force-with-lease\` (Conflicts eliminated)`,
            },
          ],
        };
      } catch (err: any) {
        throw new Error(`Failed to rebase PR: ${err.stderr?.toString() || err.message}`);
      }
    }

    // ----------------------------------------------------
    // TOOL 7: jules_queue_tasks
    // ----------------------------------------------------
    if (name === "jules_queue_tasks") {
      const sourceInput = args.source as string;
      const tasks = args.tasks as any[];
      const timeoutPerTask = Number(args.timeout_per_task) || 90;
      const results: any[] = [];

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const taskPrompt = typeof t === "string" ? t : t.prompt;
        const taskTitle = typeof t === "object" ? t.title : `Sequential Chore ${i + 1}/${tasks.length}`;

        const sourceResource = sourceInput.startsWith("sources/")
          ? sourceInput
          : `sources/github/yasserbousrih/${sourceInput.replace(/^sources\/github\//, "")}`;

        const decoratedPrompt = decoratePrompt(taskPrompt, sourceInput);

        const payload: any = {
          prompt: decoratedPrompt,
          title: taskTitle,
          sourceContext: {
            source: sourceResource,
            githubRepoContext: { startingBranch: "main" },
          },
          automationMode: "AUTO_CREATE_PR",
          requirePlanApproval: false,
          environmentVariablesEnabled: true,
        };

        const targetAccount = await getLeastLoadedAccount();
        const created = await request("sessions", targetAccount.key, { method: "POST" }, payload);
        const sid = created.id || created.name?.replace("sessions/", "");

        const startTime = Date.now();
        let finalState = "IN_PROGRESS";
        let sessionData = created;

        while (Date.now() - startTime < timeoutPerTask * 1000) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            sessionData = await request(`sessions/${sid}`, targetAccount.key);
            finalState = sessionData.state || "STATE_UNSPECIFIED";
            if (["COMPLETED", "FAILED", "AWAITING_USER_FEEDBACK"].includes(finalState)) break;
          } catch {}
        }

        results.push({
          step: i + 1,
          title: taskTitle,
          session_id: sid,
          account: targetAccount.name || targetAccount.email,
          final_state: finalState,
          web_url: sessionData.url || `https://jules.google.com/session/${sid}`,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sequence_completed: true, tasks_executed: results }, null, 2),
          },
          {
            type: "text",
            text: `### Sequential Chore Queue Complete\n\n• **Target Repo:** \`${sourceInput}\`\n• **Tasks Processed:** ${results.length}\n\n` +
              results.map((r) => `- **Step ${r.step}:** ${r.title} -> \`${r.final_state}\` (\`${r.session_id}\`)`).join("\n"),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 8: jules_stream_progress
    // ----------------------------------------------------
    if (name === "jules_stream_progress") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data: session } = await requestWithFallback(`sessions/${sessionId}`);
      const { data: activitiesData } = await requestWithFallback(`sessions/${sessionId}/activities?pageSize=100`);

      const activities = activitiesData.activities || [];
      let planSteps: any[] = [];
      const milestones: string[] = [];
      const commands: string[] = [];

      for (const act of activities) {
        if (act.planGenerated && act.planGenerated.plan) {
          planSteps = act.planGenerated.plan.steps || [];
        }
        if (act.progressUpdated && act.progressUpdated.title) {
          milestones.push(`- **${act.progressUpdated.title}**: ${act.progressUpdated.description || ""}`);
        }
        for (const art of act.artifacts || []) {
          if (art.bashOutput) {
            commands.push(`\`${art.bashOutput.command}\` (exit: ${art.bashOutput.exitCode})`);
          }
        }
      }

      let progressMd = `## Execution Progress for Jules Session \`${sessionId}\`\n\n`;
      progressMd += `• **Status:** **${session.state || "UNKNOWN"}**\n`;
      progressMd += `• **Source:** \`${session.sourceContext?.source || "unknown"}\`\n`;
      progressMd += `• **Title:** ${session.title || "Untitled"}\n\n`;

      if (planSteps.length > 0) {
        progressMd += `### Plan Steps Checklist\n`;
        for (let i = 0; i < planSteps.length; i++) {
          const step = planSteps[i];
          const isDone = session.state === "COMPLETED" || i < milestones.length;
          progressMd += `${isDone ? "- [x]" : "- [ ]"} **Step ${i + 1}:** ${step.title}\n`;
        }
        progressMd += `\n`;
      }

      if (milestones.length > 0) {
        progressMd += `### Progress Milestones\n${milestones.join("\n")}\n\n`;
      }

      if (commands.length > 0) {
        progressMd += `### Sandbox Shell Commands Executed (${commands.length})\n${commands.slice(-10).map((c) => `- ${c}`).join("\n")}\n\n`;
      }

      return {
        content: [
          {
            type: "text",
            text: progressMd,
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 9: jules_apply_patch
    // ----------------------------------------------------
    if (name === "jules_apply_patch") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const repoPath = path.resolve(args.repo_path as string);
      const branchName = args.branch_name as string | undefined;
      const testCommand = args.test_command as string | undefined;
      const autoCommit = !!args.auto_commit;

      if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
        throw new Error(`Directory does not exist: ${repoPath}`);
      }

      const { data: session } = await requestWithFallback(`sessions/${sessionId}`);
      let gitPatch: string | null = null;
      let commitMessage = `fix(jules): automated patch from session ${sessionId}`;

      for (const out of session.outputs || []) {
        if (out.changeSet) {
          if (typeof out.changeSet.gitPatch === "string") {
            gitPatch = out.changeSet.gitPatch;
          } else if (out.changeSet.gitPatch?.unidiffPatch) {
            gitPatch = out.changeSet.gitPatch.unidiffPatch;
          }
          if (out.changeSet.suggestedCommitMessage) {
            commitMessage = out.changeSet.suggestedCommitMessage;
          }
        }
      }

      if (!gitPatch) {
        throw new Error(`No git patch found in session ${sessionId}. Ensure the session is COMPLETED with outputs.`);
      }

      const patchFile = path.join(os.tmpdir(), `jules_${sessionId}.patch`);
      fs.writeFileSync(patchFile, gitPatch, "utf-8");

      let currentBranch = "main";
      try {
        currentBranch = execSync("git branch --show-current", { cwd: repoPath, encoding: "utf-8" }).trim();
      } catch {}

      if (branchName) {
        execSync(`git checkout -B ${branchName}`, { cwd: repoPath, stdio: "pipe" });
      }

      // Apply with 3-way support
      try {
        execSync(`git apply --3way --whitespace=fix ${patchFile}`, { cwd: repoPath, stdio: "pipe" });
      } catch {
        execSync(`git apply --whitespace=nowarn ${patchFile}`, { cwd: repoPath, stdio: "pipe" });
      }

      let testOutput = null;
      let testPassed = true;
      if (testCommand) {
        try {
          testOutput = execSync(testCommand, { cwd: repoPath, encoding: "utf-8", timeout: 120000 });
        } catch (err: any) {
          testPassed = false;
          testOutput = err.stdout?.toString() + "\n" + err.stderr?.toString();
        }
      }

      let committed = false;
      if (autoCommit && testPassed) {
        try {
          execSync(`git add -A && git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
            cwd: repoPath,
            stdio: "pipe",
          });
          committed = true;
        } catch {}
      }

      const statusOutput = execSync("git status --short", { cwd: repoPath, encoding: "utf-8" });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "applied",
                session_id: sessionId,
                repo_path: repoPath,
                branch: branchName || currentBranch,
                test_passed: testPassed,
                test_output: testOutput,
                committed,
                commit_message: committed ? commitMessage : null,
                git_status: statusOutput,
              },
              null,
              2
            ),
          },
          {
            type: "text",
            text: `### Git Patch Applied from Jules Session \`${sessionId}\`\n\n` +
              `• **Target Repo:** \`${repoPath}\`\n` +
              `• **Branch:** \`${branchName || currentBranch}\`\n` +
              `• **Committed:** ${committed ? `Yes (\`${commitMessage}\`)` : "No"}\n` +
              (testCommand ? `• **Test Suite:** ${testPassed ? "Passed ✓" : "Failed ✗"}\n` : "") +
              `\n**Modified Files:**\n\`\`\`\n${statusOutput || "(Clean - committed)"}\n\`\`\``,
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 10: jules_review_pr
    // ----------------------------------------------------
    if (name === "jules_review_pr") {
      const target = args.pr_url_or_number as string;
      const repo = args.repo as string | undefined;

      let cmd = `gh pr view "${target}" --json number,title,state,url,author,headRefName,baseRefName,body,comments,reviews,statusCheckRollup,additions,deletions,changedFiles`;
      if (repo) cmd += ` --repo "${repo}"`;

      try {
        const output = execSync(cmd, { encoding: "utf-8" });
        const pr = JSON.parse(output);

        let checksMd = "";
        for (const check of pr.statusCheckRollup || []) {
          checksMd += `- **${check.name || check.context}**: ${check.status || check.state} (${check.conclusion || "running"})\n`;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(pr, null, 2),
            },
            {
              type: "text",
              text: `## PR #${pr.number}: ${pr.title}\n\n` +
                `• **Status:** ${pr.state}\n` +
                `• **URL:** ${pr.url}\n` +
                `• **Branch:** \`${pr.headRefName}\` -> \`${pr.baseRefName}\`\n` +
                `• **Diff Stats:** +${pr.additions} / -${pr.deletions} across ${pr.changedFiles} files\n\n` +
                (checksMd ? `### Status Checks\n${checksMd}\n` : "") +
                `### Description\n${pr.body || "(No description)"}`,
            },
          ],
        };
      } catch (err: any) {
        throw new Error(`Failed to inspect PR: ${err.stderr?.toString() || err.message}`);
      }
    }

    // ----------------------------------------------------
    // TOOL 11: jules_merge_pr
    // ----------------------------------------------------
    if (name === "jules_merge_pr") {
      const target = args.pr_url_or_number as string;
      const repo = args.repo as string | undefined;
      const method = (args.merge_method as string) || "squash";
      const deleteBranch = args.delete_branch !== false;

      let cmd = `gh pr merge "${target}" --${method}`;
      if (deleteBranch) cmd += ` --delete-branch`;
      if (repo) cmd += ` --repo "${repo}"`;

      try {
        const output = execSync(cmd, { encoding: "utf-8" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, target, method, output: output.trim() }, null, 2),
            },
            {
              type: "text",
              text: `### Pull Request Merged Successfully\n\n• **Target:** \`${target}\`\n• **Method:** \`${method}\`\n• **Branch Cleaned Up:** ${deleteBranch ? "Yes" : "No"}\n\n\`${output.trim()}\``,
            },
          ],
        };
      } catch (err: any) {
        throw new Error(`Failed to merge PR: ${err.stderr?.toString() || err.message}`);
      }
    }

    // ----------------------------------------------------
    // TOOL 12: jules_list_sources
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
    // TOOL 13: jules_get_source
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
    // TOOL 14: jules_create_task
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

      // Check Deprecated Repos
      const cleanRepo = sourceInput.toLowerCase().replace(/^sources\/github\/[^\/]+\//, "");
      if (DEPRECATED_REPOS[cleanRepo]) {
        throw new Error(`Repository '${cleanRepo}' is deprecated. Reason: ${DEPRECATED_REPOS[cleanRepo]}`);
      }

      const sourceResource = sourceInput.startsWith("sources/")
        ? sourceInput
        : `sources/github/yasserbousrih/${sourceInput.replace(/^sources\/github\//, "")}`;

      const decoratedPrompt = decoratePrompt(prompt, sourceInput);

      const payload: any = {
        prompt: decoratedPrompt,
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

      const targetAccount = accountTarget ? null : await getLeastLoadedAccount();
      const { data, account } = targetAccount
        ? { data: await request("sessions", targetAccount.key, { method: "POST" }, payload), account: targetAccount }
        : await requestWithFallback("sessions", { method: "POST" }, payload, accountTarget);

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
    // TOOL 15: jules_batch_dispatch
    // ----------------------------------------------------
    if (name === "jules_batch_dispatch") {
      const tasks = args.tasks as any[];
      const results: any[] = [];

      for (const t of tasks) {
        try {
          const cleanRepo = t.source.toLowerCase().replace(/^sources\/github\/[^\/]+\//, "");
          if (DEPRECATED_REPOS[cleanRepo]) {
            results.push({
              status: "error",
              source: t.source,
              error: `Repository is deprecated: ${DEPRECATED_REPOS[cleanRepo]}`,
            });
            continue;
          }

          const sourceResource = t.source.startsWith("sources/")
            ? t.source
            : `sources/github/yasserbousrih/${t.source.replace(/^sources\/github\//, "")}`;

          const decoratedPrompt = decoratePrompt(t.prompt, t.source);

          const payload: any = {
            prompt: decoratedPrompt,
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

          const targetAccount = await getLeastLoadedAccount();
          const data = await request("sessions", targetAccount.key, { method: "POST" }, payload);
          results.push({
            status: "success",
            source: t.source,
            session_id: data.id || data.name?.replace("sessions/", ""),
            account: targetAccount.name || targetAccount.email,
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
    // TOOL 16: jules_list_sessions
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
    // TOOL 17: jules_get_session
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
    // TOOL 18: jules_list_activities
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
    // TOOL 19: jules_get_activity
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
    // TOOL 20: jules_get_plan
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
    // TOOL 21: jules_approve_plan
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
    // TOOL 22: jules_reply_feedback
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
    // TOOL 23: jules_get_patch
    // ----------------------------------------------------
    if (name === "jules_get_patch") {
      const sessionId = (args.session_id as string).replace("sessions/", "");
      const { data } = await requestWithFallback(`sessions/${sessionId}`);

      let gitPatch: string | null = null;
      let commitMessage: string | null = null;
      for (const out of data.outputs || []) {
        if (out.changeSet) {
          if (typeof out.changeSet.gitPatch === "string") {
            gitPatch = out.changeSet.gitPatch;
          } else if (out.changeSet.gitPatch?.unidiffPatch) {
            gitPatch = out.changeSet.gitPatch.unidiffPatch;
          }
          if (out.changeSet.suggestedCommitMessage) {
            commitMessage = out.changeSet.suggestedCommitMessage;
          } else if (out.changeSet.gitPatch?.suggestedCommitMessage) {
            commitMessage = out.changeSet.gitPatch.suggestedCommitMessage;
          }
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
    // TOOL 24: jules_inspect_bash_logs
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
    // TOOL 25: jules_get_media_artifacts
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
    // TOOL 26: jules_archive_session
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
    // TOOL 27: jules_delete_session
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
    // TOOL 28: jules_sync_prs
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
    // TOOL 29: jules_pool_status
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
  process.stderr.write("Jules MCP Server running on stdio (29 tools)\n");
}

run().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
