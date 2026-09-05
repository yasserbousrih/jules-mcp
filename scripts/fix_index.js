import fs from "fs";

let src = fs.readFileSync("/root/projects/jules-mcp/src/index.ts", "utf-8");

// Restore cleanly by reading from git if needed or fixing regex directly
// Let's check git diff first or clean up index.ts
EOF
