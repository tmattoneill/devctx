import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  classifyAiError,
  recordAiFailure,
  clearAiFailure,
  getLastAiFailure,
  aiStatusBanner,
  aiFallbackNote,
} from "./ai-status.js";

/**
 * These cover the failure that motivated the module: the pinned model was
 * retired, every call 404'd, and the bare `catch` made it look like no key was
 * set. A 404 must stay distinguishable from a 401 and from an absent key.
 */

function apiError(status: number, message: string) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type: "not_found_error", message } },
    message,
    new Headers(),
  );
}

describe("classifyAiError", () => {
  it("classifies a 401 as auth", () => {
    const failure = classifyAiError(apiError(401, "invalid x-api-key"));
    expect(failure.kind).toBe("auth");
    expect(failure.detail).toContain("rejected");
  });

  it("classifies a 404 as model_not_found and keeps the model name", () => {
    const failure = classifyAiError(apiError(404, "model: claude-sonnet-4-20250514"));
    expect(failure.kind).toBe("model_not_found");
    expect(failure.detail).toContain("claude-sonnet-4-20250514");
  });

  it("classifies a 429 as rate_limit", () => {
    expect(classifyAiError(apiError(429, "rate limited")).kind).toBe("rate_limit");
  });

  it("classifies a 5xx as network", () => {
    expect(classifyAiError(apiError(503, "overloaded")).kind).toBe("network");
  });

  it("classifies a 400 as bad_request", () => {
    expect(classifyAiError(apiError(400, "max_tokens too large")).kind).toBe("bad_request");
  });

  it("classifies a connection failure as network", () => {
    const error = new Anthropic.APIConnectionError({ message: "socket hang up" });
    expect(classifyAiError(error).kind).toBe("network");
  });

  it("falls back to unknown for a plain error", () => {
    const failure = classifyAiError(new Error("something else broke"));
    expect(failure.kind).toBe("unknown");
    expect(failure.detail).toBe("something else broke");
  });

  it("handles a thrown non-Error", () => {
    expect(classifyAiError("just a string").detail).toBe("just a string");
  });
});

describe("aiStatusBanner", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    clearAiFailure();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  afterEach(() => {
    clearAiFailure();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("is empty when the key is set and nothing has failed", () => {
    expect(aiStatusBanner()).toBe("");
  });

  it("asks for a key when none is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(aiStatusBanner()).toContain("set ANTHROPIC_API_KEY");
  });

  it("reports a rejected key rather than a missing one", () => {
    recordAiFailure(apiError(401, "invalid x-api-key"));
    const banner = aiStatusBanner();
    expect(banner).toContain("rejected");
    expect(banner).not.toContain("set ANTHROPIC_API_KEY");
  });

  it("hints at a retired model on a 404", () => {
    recordAiFailure(apiError(404, "model: claude-sonnet-4-20250514"));
    expect(aiStatusBanner()).toContain("retired");
  });

  it("clears once a call succeeds", () => {
    recordAiFailure(apiError(401, "invalid x-api-key"));
    expect(getLastAiFailure()).not.toBeNull();
    clearAiFailure();
    expect(getLastAiFailure()).toBeNull();
    expect(aiStatusBanner()).toBe("");
  });
});

describe("aiFallbackNote", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    clearAiFailure();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  afterEach(() => {
    clearAiFailure();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("asks for a key only when none is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(aiFallbackNote()).toContain("Set ANTHROPIC_API_KEY");
  });

  it("names the real failure instead of blaming a missing key", () => {
    recordAiFailure(apiError(404, "model: claude-sonnet-4-20250514"));
    const note = aiFallbackNote();
    expect(note).toContain("claude-sonnet-4-20250514");
    expect(note).toContain("retired");
    expect(note).not.toContain("Set ANTHROPIC_API_KEY");
  });

  it("reports a rejected key as rejected, not absent", () => {
    recordAiFailure(apiError(401, "invalid x-api-key"));
    const note = aiFallbackNote();
    expect(note).toContain("rejected");
    expect(note).not.toContain("Set ANTHROPIC_API_KEY");
  });

  it("takes the subject so goodbye and status read naturally", () => {
    recordAiFailure(apiError(429, "rate limited"));
    expect(aiFallbackNote("session summaries")).toContain("AI session summaries unavailable");
  });

  it("explains an empty response when the key works and nothing was recorded", () => {
    expect(aiFallbackNote()).toContain("returned no text");
  });
});
