import Anthropic from "@anthropic-ai/sdk";

/**
 * Tracks why the last Anthropic call failed.
 *
 * The AI call sites deliberately swallow their errors: writing to stderr makes
 * Claude Code mark the MCP server as failed, so a thrown error is worse than a
 * degraded answer. That left every failure looking identical to "no API key
 * set", which hid a retired model ID for months. This module keeps the silent
 * fallback but records the reason so the tools can report it in their output.
 *
 * State is per MCP process and in memory only. A failure that matters will
 * recur on the next call.
 */

export type AiFailureKind =
  | "auth"
  | "model_not_found"
  | "rate_limit"
  | "network"
  | "bad_request"
  | "unknown";

export interface AiFailure {
  kind: AiFailureKind;
  detail: string;
  at: string;
}

let lastFailure: AiFailure | null = null;

export function classifyAiError(error: unknown): AiFailure {
  const at = new Date().toISOString();

  if (error instanceof Anthropic.AuthenticationError) {
    return { kind: "auth", detail: "ANTHROPIC_API_KEY was rejected (401)", at };
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { kind: "model_not_found", detail: message(error), at };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limit", detail: "rate limited by the Anthropic API (429)", at };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: "network", detail: "could not reach the Anthropic API", at };
  }
  if (error instanceof Anthropic.APIError) {
    const kind: AiFailureKind = error.status && error.status >= 500 ? "network" : "bad_request";
    return { kind, detail: `Anthropic API error ${error.status ?? "?"}: ${message(error)}`, at };
  }

  return { kind: "unknown", detail: message(error), at };
}

function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function recordAiFailure(error: unknown): AiFailure {
  lastFailure = classifyAiError(error);
  return lastFailure;
}

export function clearAiFailure(): void {
  lastFailure = null;
}

export function getLastAiFailure(): AiFailure | null {
  return lastFailure;
}

/**
 * Why the deterministic fallback is being shown, phrased for the body of a
 * fallback narrative.
 *
 * The fallback generators used to hardcode "Set ANTHROPIC_API_KEY", which is
 * actively misleading when the key is set and the call failed for some other
 * reason. That line is how a retired model ID stayed hidden.
 */
export function aiFallbackNote(subject = "narratives"): string {
  if (!process.env.ANTHROPIC_API_KEY) {
    return `ℹ️ Set ANTHROPIC_API_KEY for AI-generated ${subject}.`;
  }

  const failure = lastFailure;
  if (!failure) {
    // Key present, nothing recorded: the model returned no usable text.
    return `⚠️ AI ${subject} unavailable: the model returned no text. Showing a deterministic summary.`;
  }

  const hint =
    failure.kind === "auth"
      ? " Check the key passed to the MCP server."
      : failure.kind === "model_not_found"
        ? " The pinned model may have been retired."
        : "";

  return `⚠️ AI ${subject} unavailable: ${failure.detail}.${hint}`;
}

/**
 * One-line banner for tool output. Returns an empty string when the AI path is
 * working, so callers can interpolate it unconditionally.
 */
export function aiStatusBanner(): string {
  if (!process.env.ANTHROPIC_API_KEY) {
    return "*(deterministic fallback — set ANTHROPIC_API_KEY for an AI narrative)*\n";
  }

  const failure = lastFailure;
  if (!failure) return "";

  const hint =
    failure.kind === "auth"
      ? " Check the key you passed to the MCP server."
      : failure.kind === "model_not_found"
        ? " The pinned model may have been retired."
        : "";

  return `*(deterministic fallback — AI call failed: ${failure.detail}.${hint})*\n`;
}
