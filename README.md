# Jules MCP Server (`jules-mcp` v2.0.0)

Universal Model Context Protocol (MCP) server, autonomous background scheduler, CI auto-healer, issue dispatcher, and CLI for Google Jules Cloud Agent with 100% native REST API coverage, multi-account pooling, automated load balancing, 24-hour rolling quota ledger, container test runner auto-injection, standardized chore recipes, persistent quota queuing, file collision locks, exponential backoff retries, semantic conflict resolution, preflight conflict dry-runs, and multi-session 3-way consolidation.

Compatible across all major AI coding harnesses: **Hermes, Claude Code, Cursor, Codex, and Windsurf**.

---

## Complete MCP Tool Reference (53 Native Tools)

### 1. Autonomous Intelligence, Watchdog & Scheduled Tasks
- **`jules_schedule_task`** — Set up recurring maintenance tasks (daily, weekly, hourly) that run automatically in the background without manual prompting.
- **`jules_list_schedules`** — List all active and paused recurring scheduled tasks, last run timestamps, and next run countdowns.
- **`jules_delete_schedule`** — Delete or pause a recurring scheduled task by ID.
- **`jules_poll_watchdog`** — Trigger an immediate autonomous watchdog cycle: detects stuck questions, logs real-time events, notifies new PRs, and auto-drains queued tasks into newly opened slots.
- **`jules_get_events`** — Query the rolling cross-harness background event ledger (`~/.config/jules/events.json`).
- **`jules_get_stuck_sessions`** — One-shot scan across all accounts for stuck sessions, extracting the exact question asked by Jules and ready-to-run unblock commands.
- **`jules_auto_nudge_all`** — Pool-wide autonomous unblocker: broadcasts unblocking directives to all stuck sessions.
- **`jules_check_events`** — Real-time event monitor across accounts: detects stuck tasks, plans awaiting approval, completed PRs, and failures.
- **`jules_wait_for_task`** — Synchronously wait for a session until completion with auto-plan approval and auto-unblocking.
- **`jules_dispatch_and_wait`** — Single-call chore execution: decorates prompt with architectural guardrails, dispatches to least-loaded account, and waits.
- **`jules_stream_progress`** — Generates a structured markdown execution timeline: step-by-step plan checklist `[x]`, internal thought reasoning trail, files modified, and sandbox bash commands.

### 2. Auto-Healing, Planning Critic & GitHub Integration
- **`jules_heal_ci`** — Autonomous CI Auto-Healer: inspects failing GitHub Actions checks on a Jules PR, extracts the failure traceback, and dispatches a healing directive back to the Jules session to fix the error and update the PR.
- **`jules_plan_critic`** — Adversarial Planning Critic Agent: analyzes generated multi-step plans for regression risks, missing test verification, and fake mock bypasses before implementation begins.
- **`jules_dispatch_issue`** — GitHub Issue Dispatcher: converts an open GitHub Issue into an autonomous Jules chore, linking the PR back to close the issue automatically.
- **`jules_export_workspace`** — Workspace Exporter (Turndown Tool): exports all connected repos, memories, schedules, setup scripts, authorship, and session history (summaries, activities, and diff patches) to `~/jules-export`.

### 3. Repository Memories, Setup Scripts & Authorship Vault
- **`jules_set_repo_memory`** — Store persistent agentic memories, coding conventions, architectural rules, or constraints for a repository (auto-injected into future sessions).
- **`jules_get_repo_memories`** — Retrieve all persistent agentic memories and custom rules stored for a repository.
- **`jules_delete_repo_memory`** — Delete a stored memory or rule from a repository vault.
- **`jules_set_setup_script`** — Configure a pre-flight container setup script (`setup.sh`) executed inside the cloud VM before writing code or running tests.
- **`jules_configure_authorship`** — Configure Git commit authorship (`co_authored`, `user_only`, or `jules_only`) so commits attribute to your GitHub account.
- **`jules_set_repo_env`** / **`jules_get_repo_env`** / **`jules_delete_repo_env`** — Securely store, inspect, and delete environment variables injected into the cloud container sandbox.

### 4. Local Git & Multi-Session 3-Way Consolidation
- **`jules_consolidate_sessions`** — Reconcile and merge multiple concurrent Jules sessions on the SAME repository into a single clean local branch or unified PR. Uses 3-way unidiff application and semantic conflict resolution to resolve cloud branch drift automatically, runs tests, and creates 1 clean PR.
- **`jules_verify_patch`** — Dry-run preflight check: inspects a completed session's git patch and runs `git apply --check --3way` against a local workspace to verify whether the patch will apply cleanly with 0 conflicts before creating branches or writing files.
- **`jules_apply_patch`** — Fetches clean unidiff patches from completed sessions and applies them directly into a local git repository, creates fix branches, executes test suites (`npm test` / `pytest`), and auto-commits.
- **`jules_rebase_pr`** — Rebases an existing Jules PR against latest `main` branch locally and force-pushes with lease.
- **`jules_review_pr`** — Inspects GitHub Pull Requests opened by Jules (diff stats, review comments, CI status checks) via `gh`.
- **`jules_merge_pr`** — Safely squash-merges verified GitHub PRs and cleans up remote branches.
- **`jules_sync_prs`** — Local PR sync runner: applies patches, verifies locally with tests, and creates GitHub PRs.

### 5. Multi-Account Pool & Capacity Management
- **`jules_create_task`** — Dispatches tasks with architectural invariant decoration, container test directives, anti-pause directives, target branches, custom working branch, automated PR creation (`AUTO_CREATE_PR`), and plan approval mode.
- **`jules_batch_dispatch`** — Launches multiple tasks across repositories simultaneously with multi-account load balancing.
- **`jules_pool_status`** — Live status of all configured Google accounts (quotas, 24h rolling usage ledger, active in-flight count, completed count, next reset minutes).
- **`jules_queue_status`** — Inspect persistent task queue (`~/.config/jules/queue.json`), queued backlog depth, available pool slots, and countdown to earliest slot reset.
- **`jules_drain_queue`** — Drain and dispatch queued tasks to Google Jules accounts with newly available 24h rolling quota slots.
- **`jules_inspect_locks`** — List active in-flight file locks across repositories to monitor parallel task partitioning and prevent file collisions.
- **`jules_queue_tasks`** — Sequentially executes a pipeline of chores on the same repo (waits for Task N before launching Task N+1).
- **`jules_recipe_dispatch`** — Dispatch a standardized, high-efficiency chore recipe with pre-tested prompt blueprints (`scaffold-unit-test`, `add-strict-types`, `document-endpoints`, `clean-dead-code`, `refactor-isolated-helper`).
- **`jules_run_suggestions`** — Scans local repository for security vulnerabilities, missing test coverage, code health issues, and N+1 performance patterns, deduplicating against a 24h ledger and batch-dispatching them.

### 6. Interactive Feedback, Activities & Lifecycle
- **`jules_list_sources`** / **`jules_get_source`** — Discover connected GitHub repositories and branch metadata.
- **`jules_list_sessions`** / **`jules_get_session`** — Inspect session lifecycle and outputs.
- **`jules_list_activities`** / **`jules_get_activity`** — Granular chronological activity trails.
- **`jules_get_plan`** / **`jules_approve_plan`** — Plan inspection and approval.
- **`jules_reply_feedback`** — Send unblocking feedback directly to active sessions.
- **`jules_get_patch`** — Extract clean git unidiff patches.
- **`jules_inspect_bash_logs`** — Extract terminal shell outputs from Google's cloud sandbox.
- **`jules_get_media_artifacts`** — Extract visual media artifacts generated in the container.
- **`jules_archive_session`** / **`jules_delete_session`** — Workspace session management.

---

## Configuration

### Multi-Account Pool (`~/.config/jules/keys.json`)
```json
{
  "accounts": [
    { "name": "Primary", "email": "dev-account-1@example.com", "key": "YOUR_JULES_API_KEY_1" },
    { "name": "Secondary", "email": "dev-account-2@example.com", "key": "YOUR_JULES_API_KEY_2" }
  ]
}
```

### Build & Run
```bash
npm run build
npm test
```
