import fs from "fs";

let src = fs.readFileSync("/root/projects/jules-mcp/src/index.ts", "utf-8");

// 1. Add QUEUE_PATH and LOCKS_PATH
src = src.replace(
  `const USAGE_PATH = process.env.JULES_USAGE_PATH || path.join(process.env.HOME || "/root", ".config/jules/usage.json");`,
  `const USAGE_PATH = process.env.JULES_USAGE_PATH || path.join(process.env.HOME || "/root", ".config/jules/usage.json");\nconst QUEUE_PATH = process.env.JULES_QUEUE_PATH || path.join(process.env.HOME || "/root", ".config/jules/queue.json");\nconst LOCKS_PATH = process.env.JULES_LOCKS_PATH || path.join(process.env.HOME || "/root", ".config/jules/locks.json");`
);

// 2. Add Interfaces for Queue & Locks
const queueLockInterfaces = `
interface QueuedTask {
  id: string;
  createdAt: number;
  source: string;
  prompt: string;
  title?: string;
  recipe?: string;
  targetPath?: string;
  autoCreatePr?: boolean;
  requirePlanApproval?: boolean;
}

interface TaskQueue {
  tasks: QueuedTask[];
}

interface FileLock {
  repo: string;
  filePath: string;
  sessionId: string;
  account: string;
  createdAt: number;
}

interface LocksLedger {
  locks: FileLock[];
}

function loadTaskQueue(): TaskQueue {
  if (fs.existsSync(QUEUE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
    } catch {}
  }
  return { tasks: [] };
}

function saveTaskQueue(queue: TaskQueue) {
  try {
    const dir = path.dirname(QUEUE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), "utf-8");
  } catch {}
}

function enqueueTask(task: Omit<QueuedTask, "id" | "createdAt">): QueuedTask {
  const queue = loadTaskQueue();
  const fullTask: QueuedTask = {
    id: "queue_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
    createdAt: Date.now(),
    ...task,
  };
  queue.tasks.push(fullTask);
  saveTaskQueue(queue);
  return fullTask;
}

function dequeueTask(id: string): boolean {
  const queue = loadTaskQueue();
  const initLen = queue.tasks.length;
  queue.tasks = queue.tasks.filter((t) => t.id !== id);
  if (queue.tasks.length !== initLen) {
    saveTaskQueue(queue);
    return true;
  }
  return false;
}

function loadFileLocks(): LocksLedger {
  if (fs.existsSync(LOCKS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(LOCKS_PATH, "utf-8"));
    } catch {}
  }
  return { locks: [] };
}

function saveFileLocks(ledger: LocksLedger) {
  try {
    const dir = path.dirname(LOCKS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    ledger.locks = ledger.locks.filter((l) => l.createdAt > cutoff);
    fs.writeFileSync(LOCKS_PATH, JSON.stringify(ledger, null, 2), "utf-8");
  } catch {}
}

function acquireFileLock(repo: string, filePath: string, sessionId: string, account: string) {
  if (!filePath || filePath === ".") return;
  const ledger = loadFileLocks();
  const cleanRepo = repo.toLowerCase().replace(/^sources\/github\/[^\/]+\//, "");
  const cleanPath = filePath.trim().toLowerCase();

  if (!ledger.locks.some((l) => l.repo === cleanRepo && l.filePath === cleanPath && l.sessionId === sessionId)) {
    ledger.locks.push({
      repo: cleanRepo,
      filePath: cleanPath,
      sessionId,
      account,
      createdAt: Date.now(),
    });
    saveFileLocks(ledger);
  }
}

function releaseFileLocks(sessionId: string) {
  const cleanSid = sessionId.replace("sessions/", "");
  const ledger = loadFileLocks();
  const initLen = ledger.locks.length;
  ledger.locks = ledger.locks.filter((l) => l.sessionId !== cleanSid);
  if (ledger.locks.length !== initLen) {
    saveFileLocks(ledger);
  }
}

function checkFileConflict(repo: string, filePath: string): FileLock | undefined {
  if (!filePath || filePath === ".") return undefined;
  const ledger = loadFileLocks();
  const cleanRepo = repo.toLowerCase().replace(/^sources\/github\/[^\/]+\//, "");
  const cleanPath = filePath.trim().toLowerCase();
  return ledger.locks.find((l) => l.repo === cleanRepo && l.filePath === cleanPath);
}

function reconcileSemanticConflicts(content: string, filePath: string): { reconciled: boolean; content: string } {
  if (!content.includes("<<<<<<<") || !content.includes(">>>>>>>")) {
    return { reconciled: true, content };
  }

  const ext = path.extname(filePath).replace(".", "").toLowerCase();
  const conflictRegex = /<<<<<<<[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>[^\n]*\n?/g;
  let hasUnresolved = false;

  const resolved = content.replace(conflictRegex, (match, ours, theirs) => {
    const oursTrim = ours.trim();
    const theirsTrim = theirs.trim();

    if (!oursTrim) return theirs;
    if (!theirsTrim) return ours;

    const isImportStatement = (line: string) => {
      const l = line.trim();
      return l.startsWith("import ") || l.startsWith("from ") || l.includes("require(") || l === "";
    };

    const oursLines = ours.split("\n").map((l: string) => l.trimEnd()).filter(Boolean);
    const theirsLines = theirs.split("\n").map((l: string) => l.trimEnd()).filter(Boolean);

    if (oursLines.every(isImportStatement) && theirsLines.every(isImportStatement)) {
      const mergedImports = Array.from(new Set([...oursLines, ...theirsLines]));
      return mergedImports.join("\n") + "\n";
    }

    const getDefNames = (lines: string[], lang: string) => {
      if (lang === "py") {
        return lines
          .filter((l) => l.trim().startsWith("def ") || l.trim().startsWith("class "))
          .map((l) => l.trim().split("(")[0]);
      }
      return lines
        .filter((l) => l.trim().startsWith("function ") || l.trim().startsWith("export function ") || l.trim().startsWith("const ") || l.trim().startsWith("export const "))
        .map((l) => l.trim().split("=")[0].split("(")[0]);
    };

    const oursDefs = getDefNames(oursLines, ext);
    const theirsDefs = getDefNames(theirsLines, ext);

    if (oursDefs.length > 0 && theirsDefs.length > 0) {
      const overlap = oursDefs.some((d) => theirsDefs.includes(d));
      if (!overlap) {
        return ours.trimEnd() + "\n\n" + theirs.trimEnd() + "\n";
      }
    }

    hasUnresolved = true;
    return match;
  });

  return { reconciled: !hasUnresolved && !resolved.includes("<<<<<<<"), content: resolved };
}
`;

src = src.replace(
  `interface UsageLedger {
  dispatches: DispatchRecord[];
}`,
  `interface UsageLedger {
  dispatches: DispatchRecord[];
}
${queueLockInterfaces}`
);

// 3. Update request() with exponential backoff and jitter retry
const newRequestFn = `async function request(endpoint: string, apiKey: string, options: https.RequestOptions = {}, body?: any, maxRetries = 3): Promise<any> {
  const url = \`\${API_BASE}/\${endpoint}\${endpoint.includes("?") ? "&" : "?"}key=\${apiKey}\`;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request(url, { ...options, timeout: 20000 }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode && res.statusCode >= 400) {
                const err: any = new Error(\`Google Jules API error (\${res.statusCode}): \${parsed.error?.message || data}\`);
                err.statusCode = res.statusCode;
                reject(err);
              } else {
                resolve(parsed);
              }
            } catch {
              if (res.statusCode && res.statusCode >= 400) {
                const err: any = new Error(\`Google Jules API error (\${res.statusCode}): \${data}\`);
                err.statusCode = res.statusCode;
                reject(err);
              } else {
                resolve(data);
              }
            }
          });
        });
        req.on("error", (err: any) => {
          err.isNetwork = true;
          reject(err);
        });
        req.on("timeout", () => {
          req.destroy();
          const err: any = new Error(\`Request to \${endpoint} timed out.\`);
          err.isTimeout = true;
          reject(err);
        });
        if (body) {
          req.setHeader("Content-Type", "application/json");
          req.write(typeof body === "string" ? body : JSON.stringify(body));
        }
        req.end();
      });
    } catch (err: any) {
      const isTransient = err.isNetwork || err.isTimeout || (err.statusCode && [500, 502, 503, 504].includes(err.statusCode));
      if (isTransient && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 300);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}`;

src = src.replace(/async function request\(endpoint: string, apiKey: string[\s\S]*?\n}\n\n\/\/ Request with automatic/, `${newRequestFn}\n\n// Request with automatic`);

// 4. Update Server version
src = src.replace(`version: "1.5.0",`, `version: "1.6.0",`);

// 5. Add 3 new tool schemas
const newToolSchemas = `      {
        name: "jules_queue_status",
        description: "Inspect the persistent task queue (~/.config/jules/queue.json), queued backlog depth, and estimated reset countdowns.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "jules_drain_queue",
        description: "Drain and dispatch queued tasks to Google Jules accounts with newly available 24h rolling quota slots.",
        inputSchema: {
          type: "object",
          properties: {
            max_tasks: {
              type: "number",
              description: "Max number of queued tasks to dispatch (defaults to all available slots).",
            },
          },
        },
      },
      {
        name: "jules_inspect_locks",
        description: "List active in-flight file locks across repositories to monitor parallel task partitioning and prevent file collisions.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Optional filter by repository identifier.",
            },
          },
        },
      },
`;

src = src.replace(
  `      {
        name: "jules_pool_status",`,
  `${newToolSchemas}      {
        name: "jules_pool_status",`
);

// 6. Add Tool Handlers for jules_queue_status, jules_drain_queue, jules_inspect_locks
const newHandlers = `    // ----------------------------------------------------
    // TOOL 32: jules_queue_status
    // ----------------------------------------------------
    if (name === "jules_queue_status") {
      const queue = loadTaskQueue();
      const quotaStatus = getQuotaStatus();
      const accounts = getAccounts();
      const totalUsed24h = Object.values(quotaStatus).reduce((acc, q) => acc + q.usedLast24h, 0);
      const remainingQuota = accounts.length * 15 - totalUsed24h;

      let nextSlotMinutes = 0;
      const resetTimes = Object.values(quotaStatus)
        .map((q) => q.nextResetMinutes)
        .filter((m): m is number => typeof m === "number" && m > 0);
      if (resetTimes.length > 0) nextSlotMinutes = Math.min(...resetTimes);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                queued_tasks_count: queue.tasks.length,
                available_pool_slots: remainingQuota,
                earliest_next_slot_minutes: nextSlotMinutes,
                tasks: queue.tasks,
              },
              null,
              2
            ),
          },
          {
            type: "text",
            text: \`### Jules Persistent Task Queue\\n\\n\` +
              \`• **Queued Tasks:** \${queue.tasks.length}\\n\` +
              \`• **Available Pool Slots:** \${remainingQuota}\\n\` +
              \`• **Earliest Slot Reset:** \${nextSlotMinutes > 0 ? \`\${nextSlotMinutes} minutes\` : "Available Now"}\\n\\n\` +
              (queue.tasks.length > 0
                ? queue.tasks.map((t, idx) => \`\${idx + 1}. [\${t.recipe || "Task"}] \${t.source} - \${t.title || t.prompt.slice(0, 50)}\`).join("\\n")
                : "_Queue is empty._"),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 33: jules_drain_queue
    // ----------------------------------------------------
    if (name === "jules_drain_queue") {
      const maxTasks = Number(args.max_tasks) || 999;
      const queue = loadTaskQueue();
      const quotaStatus = getQuotaStatus();
      const accounts = getAccounts();

      let dispatchedCount = 0;
      const dispatchedResults: any[] = [];

      for (const task of [...queue.tasks]) {
        if (dispatchedCount >= maxTasks) break;

        let bestAccount: Account | null = null;
        for (const acc of accounts) {
          const accKey = acc.name || acc.email || "Account";
          const q = quotaStatus[accKey] || { usedLast24h: 0, remaining: 15 };
          if (q.remaining > 0) {
            bestAccount = acc;
            q.remaining--;
            q.usedLast24h++;
            break;
          }
        }

        if (!bestAccount) break;

        try {
          const sourceResource = task.source.startsWith("sources/")
            ? task.source
            : \`sources/github/yasserbousrih/\${task.source.replace(/^sources\\/github\\//, "")}\`;

          const payload: any = {
            prompt: decoratePrompt(task.prompt, task.source),
            title: task.title,
            sourceContext: {
              source: sourceResource,
              githubRepoContext: { startingBranch: "main" },
            },
            automationMode: task.autoCreatePr !== false ? "AUTO_CREATE_PR" : "AUTOMATION_MODE_UNSPECIFIED",
            requirePlanApproval: !!task.requirePlanApproval,
          };

          const created = await request("sessions", bestAccount.key, { method: "POST" }, payload);
          const sid = created.id || created.name?.replace("sessions/", "");
          recordDispatch(bestAccount.name || bestAccount.email || "Account", sid, sourceResource);
          if (task.targetPath) acquireFileLock(task.source, task.targetPath, sid, bestAccount.name || bestAccount.email || "Account");

          dequeueTask(task.id);
          dispatchedCount++;
          dispatchedResults.push({
            queue_id: task.id,
            session_id: sid,
            source: task.source,
            account: bestAccount.name || bestAccount.email,
          });
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ drained_count: dispatchedCount, dispatched: dispatchedResults }, null, 2),
          },
          {
            type: "text",
            text: \`### Jules Queue Drained\\n\\n• **Tasks Dispatched:** \${dispatchedCount}\\n\` +
              dispatchedResults.map((r) => \`- [\${r.source}] Session \`\`\${r.session_id}\`\` on \${r.account}\`).join("\\n"),
          },
        ],
      };
    }

    // ----------------------------------------------------
    // TOOL 34: jules_inspect_locks
    // ----------------------------------------------------
    if (name === "jules_inspect_locks") {
      const repoFilter = args.repo as string | undefined;
      const ledger = loadFileLocks();
      let locks = ledger.locks;

      if (repoFilter) {
        const cleanRepo = repoFilter.toLowerCase().replace(/^sources\\/github\\/[^\\/]+\\//, "");
        locks = locks.filter((l) => l.repo.includes(cleanRepo));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total_locks: locks.length, locks }, null, 2),
          },
          {
            type: "text",
            text: \`### Active In-Flight File Locks (\${locks.length})\\n\\n\` +
              (locks.length > 0
                ? locks.map((l) => \`• \`\`\${l.filePath}\`\` on **\${l.repo}** (Session: \`\`\${l.sessionId}\`\`, Account: \${l.account})\`).join("\\n")
                : "_No active file locks._"),
          },
        ],
      };
    }
`;

src = src.replace(
  `    // ----------------------------------------------------
    // TOOL 31: jules_pool_status`,
  `${newHandlers}\n    // ----------------------------------------------------
    // TOOL 31: jules_pool_status`
);

// 7. Update stderr tool count
src = src.replace(`running on stdio (31 tools)`, `running on stdio (34 tools)`);

// 8. Update acquireFileLock inside jules_recipe_dispatch
src = src.replace(
  `recordDispatch(bestAccount.name || bestAccount.email || "Account", sid, sourceResource);`,
  `recordDispatch(bestAccount.name || bestAccount.email || "Account", sid, sourceResource);
      acquireFileLock(sourceInput, targetPath, sid, bestAccount.name || bestAccount.email || "Account");`
);

// 9. Integrate semantic conflict resolver in jules_consolidate_sessions & jules_apply_patch
src = src.replace(
  `            } catch (err: any) {
              failedSessions.push({ session_id: cleanSid, reason: \`3-way patch application failed: \${err.message}\` });
            }`,
  `            } catch (err: any) {
              // Try semantic conflict resolution on conflicted files
              try {
                const statusOut = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" });
                const conflictedFiles = statusOut
                  .split("\\n")
                  .filter((l) => l.startsWith("UU ") || l.startsWith("M "))
                  .map((l) => l.substring(3).trim());

                let allResolved = conflictedFiles.length > 0;
                for (const cf of conflictedFiles) {
                  const fullCf = path.join(repoPath, cf);
                  if (fs.existsSync(fullCf)) {
                    const c = fs.readFileSync(fullCf, "utf-8");
                    const res = reconcileSemanticConflicts(c, fullCf);
                    if (res.reconciled) {
                      fs.writeFileSync(fullCf, res.content, "utf-8");
                    } else {
                      allResolved = false;
                    }
                  }
                }
                if (allResolved) {
                  applySuccess = true;
                } else {
                  failedSessions.push({ session_id: cleanSid, reason: \`3-way patch application failed: \${err.message}\` });
                }
              } catch {
                failedSessions.push({ session_id: cleanSid, reason: \`3-way patch application failed: \${err.message}\` });
              }
            }`
);

// Write updated file
fs.writeFileSync("/root/projects/jules-mcp/src/index.ts", src, "utf-8");
console.log("Successfully upgraded index.ts to v1.6.0 with Quota Queue, File Locks, Exponential Backoff, and 34 tools.");
