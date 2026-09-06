import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

class TestMcpClient {
  private proc: cp.ChildProcess;
  private buffer = "";
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private nextId = 1;

  constructor() {
    this.proc = cp.spawn("node", ["/root/projects/jules-mcp/dist/index.js"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.proc.stdout?.on("data", (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line) {
          try {
            const msg = JSON.parse(line);
            if (msg.id && this.pending.has(msg.id)) {
              const { resolve, reject } = this.pending.get(msg.id)!;
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(JSON.stringify(msg.error)));
              else resolve(msg.result);
            }
          } catch {}
        }
      }
      this.buffer = lines[lines.length - 1];
    });
  }

  async init() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jules-test-suite", version: "1.6.0" },
    });
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  send(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req = { jsonrpc: "2.0", id, method, params };
      this.proc.stdin?.write(JSON.stringify(req) + "\n");
    });
  }

  async callTool(name: string, args: any = {}): Promise<any> {
    return this.send("tools/call", { name, arguments: args });
  }

  close() {
    this.proc.kill();
  }
}

describe("Jules MCP Server & Tool Registry v1.6.0", () => {
  let client: TestMcpClient;

  it("should initialize MCP server and register 34 tools", async () => {
    client = new TestMcpClient();
    await client.init();

    const listRes = await client.send("tools/list");
    assert.ok(listRes.tools, "tools array must exist");
    assert.equal(listRes.tools.length, 37, "Must register exactly 37 native tools");

    const toolNames = listRes.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("jules_pool_status"));
    assert.ok(toolNames.includes("jules_set_repo_env"));
    assert.ok(toolNames.includes("jules_get_repo_env"));
    assert.ok(toolNames.includes("jules_delete_repo_env"));
    assert.ok(toolNames.includes("jules_recipe_dispatch"));
    assert.ok(toolNames.includes("jules_verify_patch"));
    assert.ok(toolNames.includes("jules_consolidate_sessions"));
    assert.ok(toolNames.includes("jules_rebase_pr"));
    assert.ok(toolNames.includes("jules_apply_patch"));
    assert.ok(toolNames.includes("jules_auto_nudge_all"));
    assert.ok(toolNames.includes("jules_check_events"));
    assert.ok(toolNames.includes("jules_queue_status"));
    assert.ok(toolNames.includes("jules_drain_queue"));
    assert.ok(toolNames.includes("jules_inspect_locks"));
  });

  it("should manage repo env vault via jules_set_repo_env and jules_get_repo_env", async () => {
    // 1. Set environment variables
    const setRes = await client.callTool("jules_set_repo_env", {
      repo: "test-vault-repo",
      env_vars: {
        DATABASE_URL: "postgresql://test:secret@localhost:5432/db",
        API_KEY: "secret_12345",
      },
    });
    assert.ok(setRes.content && setRes.content.length > 0);
    const setParsed = JSON.parse(setRes.content[0].text);
    assert.equal(setParsed.status, "success");
    assert.equal(setParsed.repo, "test-vault-repo");
    assert.equal(setParsed.total_keys, 2);

    // 2. Get environment variables with masking
    const getRes = await client.callTool("jules_get_repo_env", {
      repo: "test-vault-repo",
      show_secrets: false,
    });
    const getParsed = JSON.parse(getRes.content[0].text);
    assert.equal(getParsed.configured, true);
    assert.ok(getParsed.env.API_KEY.includes("****"));

    // 3. Delete specific key
    const delRes = await client.callTool("jules_delete_repo_env", {
      repo: "test-vault-repo",
      keys: ["API_KEY"],
    });
    const delParsed = JSON.parse(delRes.content[0].text);
    assert.equal(delParsed.status, "success");
    assert.deepEqual(delParsed.remaining_keys, ["DATABASE_URL"]);

    // 4. Delete all
    await client.callTool("jules_delete_repo_env", { repo: "test-vault-repo" });
  });

  it("should query live pool status with 24h rolling quota calculation", async () => {
    const res = await client.callTool("jules_pool_status");
    assert.ok(res.content && res.content.length > 0);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.accounts_count, 3);
    assert.equal(parsed.total_daily_quota, "45 tasks / 24h");
    assert.ok(typeof parsed.used_last_24h === "number");
    assert.ok(typeof parsed.remaining_pool_quota === "number");
    assert.ok(Array.isArray(parsed.pool));
    assert.equal(parsed.pool.length, 3);
  });

  it("should inspect persistent task queue via jules_queue_status", async () => {
    const res = await client.callTool("jules_queue_status");
    assert.ok(res.content && res.content.length > 0);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(typeof parsed.queued_tasks_count === "number");
    assert.ok(typeof parsed.available_pool_slots === "number");
    assert.ok(Array.isArray(parsed.tasks));
  });

  it("should inspect active file locks via jules_inspect_locks", async () => {
    const res = await client.callTool("jules_inspect_locks");
    assert.ok(res.content && res.content.length > 0);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(typeof parsed.total_locks === "number");
    assert.ok(Array.isArray(parsed.locks));
  });

  it("should monitor live pool events and detect sessions", async () => {
    const res = await client.callTool("jules_check_events", { limit_per_account: 5 });
    assert.ok(res.content && res.content.length >= 2);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(parsed.stuck));
    assert.ok(Array.isArray(parsed.completed));
    assert.ok(Array.isArray(parsed.in_progress));
  });

  it("should inspect connected github sources with branch metadata", async () => {
    const res = await client.callTool("jules_get_source", { source: "Agent-Brain" });
    assert.ok(res.content && res.content.length > 0);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.source);
    assert.equal(parsed.source.githubRepo?.repo, "Agent-Brain");
    assert.ok(parsed.source.githubRepo?.branches?.length > 0);
  });

  it("should perform dry-run preflight check on real completed patch via jules_verify_patch", async () => {
    const res = await client.callTool("jules_verify_patch", {
      session_id: "13091084449805634763",
      repo_path: "/root/projects/agent-brain",
    });
    assert.ok(res.content && res.content.length >= 2);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.session_id, "13091084449805634763");
    assert.equal(parsed.repo_path, "/root/projects/agent-brain");
    assert.ok(typeof parsed.preflight_clean === "boolean");
    assert.ok(Array.isArray(parsed.files_touched));
    assert.ok(parsed.files_touched.includes("tests/test_health.py"));
  });

  it("should extract patch details from a verified completed session", async () => {
    const res = await client.callTool("jules_get_patch", { session_id: "13091084449805634763" });
    assert.ok(res.content && res.content.length > 0);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.session_id, "13091084449805634763");
    assert.ok(parsed.has_patch);
    assert.ok(parsed.git_patch.includes("diff --git a/tests/test_health.py"));
  });

  it("should enforce rejection on deprecated repositories", async () => {
    const res = await client.callTool("jules_create_task", {
      source: "email-assistant",
      prompt: "test deprecated repo",
    });
    assert.ok(res.isError || res.content[0].text.includes("deprecated"));
  });

  it("teardown client", () => {
    if (client) client.close();
  });
});
