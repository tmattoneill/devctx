import { describe, it, expect } from "vitest";
import { getCurrentVersion, bumpVersion, fallbackVersionSuggestion } from "./version.js";
import type { GitCommit } from "./git.js";

function makeCommit(subject: string): GitCommit {
  return { hash: "abc123", shortHash: "abc123", subject, author: "test", date: "2026-01-01", branch: "main" };
}

describe("getCurrentVersion", () => {
  it("returns 'none' for empty tag list", () => {
    expect(getCurrentVersion([])).toBe("none");
  });

  it("returns the first element (pre-sorted descending)", () => {
    expect(getCurrentVersion(["v2.0.0", "v1.0.0"])).toBe("v2.0.0");
  });
});

describe("bumpVersion", () => {
  it("returns v0.1.0 when current is 'none'", () => {
    expect(bumpVersion("none", "minor")).toBe("v0.1.0");
  });

  it("bumps patch correctly", () => {
    expect(bumpVersion("v1.2.3", "patch")).toBe("v1.2.4");
  });

  it("bumps minor and resets patch", () => {
    expect(bumpVersion("v1.2.3", "minor")).toBe("v1.3.0");
  });

  it("bumps major and resets minor+patch", () => {
    expect(bumpVersion("v1.2.3", "major")).toBe("v2.0.0");
  });

  it("returns v0.1.0 for invalid version string", () => {
    expect(bumpVersion("garbage", "patch")).toBe("v0.1.0");
  });
});

describe("fallbackVersionSuggestion", () => {
  it("suggests major for 'breaking' commit", () => {
    const result = fallbackVersionSuggestion([makeCommit("breaking: remove old API")], "v1.0.0");
    expect(result.level).toBe("major");
    expect(result.nextVersion).toBe("v2.0.0");
  });

  it("suggests minor for 'feat' commit", () => {
    const result = fallbackVersionSuggestion([makeCommit("feat: add dark mode")], "v1.0.0");
    expect(result.level).toBe("minor");
    expect(result.nextVersion).toBe("v1.1.0");
  });

  it("suggests minor for 'add' commit", () => {
    const result = fallbackVersionSuggestion([makeCommit("add new dashboard")], "v1.0.0");
    expect(result.level).toBe("minor");
  });

  it("suggests minor when more than 5 commits (volume heuristic)", () => {
    const commits = Array.from({ length: 6 }, (_, i) => makeCommit(`fix typo ${i}`));
    const result = fallbackVersionSuggestion(commits, "v1.0.0");
    expect(result.level).toBe("minor");
  });

  it("suggests patch for few fix/docs commits", () => {
    const result = fallbackVersionSuggestion(
      [makeCommit("fix typo"), makeCommit("docs: update readme")],
      "v1.0.0"
    );
    expect(result.level).toBe("patch");
    expect(result.nextVersion).toBe("v1.0.1");
  });

  it("nextVersion matches bumpVersion(currentVersion, level)", () => {
    const commits = [makeCommit("feat: new tool")];
    const result = fallbackVersionSuggestion(commits, "v2.1.0");
    expect(result.nextVersion).toBe(bumpVersion(result.currentVersion, result.level));
  });
});
