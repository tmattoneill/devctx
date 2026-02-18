import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

import {
  getProjectState, isDevctxInitialized,
  getRecentActivity, getLastActivityByType,
  getTodos, getSourceTodos,
  listSessions, getSessionContent,
} from "../shared/data.js";
import {
  getCurrentBranch, getGitStatus, getRecentCommits, getLastPush,
} from "../services/git.js";

export interface DashboardOptions {
  repoRoot: string;
  port: number;
  dev?: boolean;
}

export async function createServer(opts: DashboardOptions) {
  const { repoRoot, port } = opts;

  const app = Fastify({ logger: false });

  // --- API routes ---

  app.get("/api/status", async () => {
    if (!isDevctxInitialized(repoRoot)) {
      return { error: "devctx not initialized", initialized: false };
    }
    const state = getProjectState(repoRoot);
    const branch = getCurrentBranch(repoRoot);
    const gitStatus = getGitStatus(repoRoot);
    const lastPush = getLastPush(repoRoot);
    const vitals = getLastActivityByType(repoRoot);
    const recentCommits = getRecentCommits(repoRoot, 5);

    return {
      initialized: true,
      project: {
        name: state.projectName,
        description: state.description,
        focus: state.currentFocus,
        active: state.active,
        lastUpdated: state.lastUpdated,
      },
      git: {
        branch,
        isClean: gitStatus.isClean,
        staged: gitStatus.staged.length,
        modified: gitStatus.modified.length,
        untracked: gitStatus.untracked.length,
        ahead: gitStatus.ahead,
        behind: gitStatus.behind,
        lastPush,
      },
      recentCommits: recentCommits.map(c => ({
        hash: c.shortHash,
        subject: c.subject,
        author: c.author,
        date: c.date,
      })),
      vitals: Object.fromEntries(
        Object.entries(vitals).map(([k, v]) => [k, v ? { timestamp: v.timestamp, message: v.message } : null])
      ),
    };
  });

  app.get("/api/activity", async (req) => {
    const query = req.query as { limit?: string; type?: string };
    const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 200);
    const type = query.type || undefined;
    const entries = getRecentActivity(repoRoot, limit, type);
    return { entries };
  });

  app.get("/api/todos", async () => {
    const todos = getTodos(repoRoot);
    const sourceTodos = getSourceTodos(repoRoot);
    return { todos, sourceTodos };
  });

  app.get("/api/sessions", async () => {
    const sessions = listSessions(repoRoot);
    return { sessions };
  });

  app.get<{ Params: { filename: string } }>("/api/sessions/:filename", async (req, reply) => {
    const content = getSessionContent(repoRoot, req.params.filename);
    if (content === null) {
      reply.code(404);
      return { error: "Session not found" };
    }
    return { filename: req.params.filename, content };
  });

  // --- Static files (built frontend) ---
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = join(__dirname, "..", "..", "src", "dashboard", "client", "dist");

  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: "/",
      wildcard: false,
    });

    // SPA fallback: serve index.html for non-API, non-file routes
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/")) {
        reply.code(404);
        return { error: "Not found" };
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => {
      return { message: "Dashboard frontend not built. Run: npm run build:dashboard" };
    });
  }

  return { app, port };
}

export async function startServer(opts: DashboardOptions) {
  const { app, port } = await createServer(opts);

  await app.listen({ port, host: "127.0.0.1" });
  return app;
}
