#!/usr/bin/env node

import { startServer } from "./server.js";
import { getRepoRoot } from "../services/git.js";
import { exec } from "child_process";

function parseArgs(args: string[]): { port: number; open: boolean; dev: boolean } {
  let port = 3333;
  let open = true;
  let dev = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10) || 3333;
      i++;
    } else if (args[i] === "--no-open") {
      open = false;
    } else if (args[i] === "--dev") {
      dev = true;
    }
  }

  return { port, open, dev };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const cwd = process.cwd();
  const repoRoot = getRepoRoot(cwd);
  if (!repoRoot) {
    console.error("Error: not inside a git repository.");
    process.exit(1);
  }

  console.log(`devctx dashboard`);
  console.log(`  Project root: ${repoRoot}`);
  console.log(`  Starting on port ${opts.port}...`);

  const app = await startServer({
    repoRoot,
    port: opts.port,
    dev: opts.dev,
  });

  const url = `http://localhost:${opts.port}`;
  console.log(`\n  Dashboard: ${url}`);
  console.log(`  API:       ${url}/api/status`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

  if (opts.open) {
    // Open browser (macOS: open, Linux: xdg-open)
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${cmd} ${url}`, () => { /* ignore errors */ });
  }

  // Clean shutdown
  const shutdown = async () => {
    console.log("\n  Shutting down...");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
