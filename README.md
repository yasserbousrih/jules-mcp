# Jules MCP: Universal Model Context Protocol Server for Google Jules

An open-source, multi-account MCP (Model Context Protocol) server and automation harness for **Google Jules Cloud AI Agent**.

Enables **Claude Code, Cursor, Windsurf, Hermes, Gemini / Antigravity, and any MCP-compatible agent** to dispatch background coding chores, unblock interactive sessions, and automatically create verified GitHub Pull Requests.

---

## 🌟 Key Features

* **Multi-Account Quota Rotation**: Automatically rotates across pooled Google accounts to maximize throughput and avoid the 15 req/day limits.
* **Universal Agent Compatibility**: Implements standard MCP (Model Context Protocol) JSON-RPC over `stdio`. Works seamlessly with Claude Code, Cursor, Windsurf, Hermes, etc.
* **Automated PR Integration**: Extracts clean unidiff patches from Jules cloud sessions, creates Git branches, runs tests, and opens GitHub Pull Requests via `gh`.
* **Interactive Session Unblocking**: Surfaces when Jules pauses in `AWAITING_USER_FEEDBACK` and allows agents to reply programmatically.

---

## 🚀 Quick Start

### 1. Installation
```bash
git clone https://github.com/yasserbousrih/jules-mcp.git
cd jules-mcp
npm install
npm run build
```

### 2. Configuration (`~/.config/jules/keys.json`)
```json
{
  "accounts": [
    {
      "name": "primary",
      "email": "user1@example.com",
      "key": "AIzaSy..."
    },
    {
      "name": "secondary",
      "email": "user2@example.com",
      "key": "AIzaSy..."
    }
  ]
}
```
*Or set a single API key via environment variable: `export JULES_API_KEY="AIzaSy..."`.*

---

## 🛠️ MCP Tools Exposed

| Tool Name | Description |
| :--- | :--- |
| `jules_list_sources` | List all connected GitHub repositories in Jules. |
| `jules_create_task` | Dispatch an asynchronous coding chore or enhancement suggestion to Jules. |
| `jules_get_session` | Inspect status, plan, outputs, and unidiff patch of a session. |
| `jules_reply_feedback` | Send feedback to unblock a session waiting in `AWAITING_USER_FEEDBACK`. |
| `jules_sync_prs` | Extract patches and automatically open GitHub Pull Requests. |
| `jules_pool_status` | View active sessions and quota status across all pooled accounts. |

---

## 🔌 Integration Guides

### Claude Code (`~/.claude/settings.json` or `claude mcp add`)
```json
{
  "mcpServers": {
    "jules": {
      "command": "node",
      "args": ["/path/to/jules-mcp/dist/index.js"]
    }
  }
}
```

### Cursor / Windsurf (`~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "jules": {
      "command": "node",
      "args": ["/path/to/jules-mcp/dist/index.js"]
    }
  }
}
```

---

## 📄 License
MIT © Yasser Bousrih
