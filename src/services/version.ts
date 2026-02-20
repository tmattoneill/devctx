import Anthropic from "@anthropic-ai/sdk";
import type { GitCommit } from "./git.js";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 400;

export type BumpLevel = "major" | "minor" | "patch";

export interface VersionSuggestion {
  level: BumpLevel;
  reason: string;
  currentVersion: string;
  nextVersion: string;
}

export function getCurrentVersion(tags: string[]): string {
  if (tags.length === 0) return "none";
  return tags[0]; // Already sorted descending by semver in getVersionTags
}

export function bumpVersion(current: string, level: BumpLevel): string {
  if (current === "none") return "v0.1.0";
  const match = current.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return "v0.1.0";
  let [, major, minor, patch] = match.map(Number);
  switch (level) {
    case "major":
      major++;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor++;
      patch = 0;
      break;
    case "patch":
      patch++;
      break;
  }
  return `v${major}.${minor}.${patch}`;
}

const VERSION_SYSTEM_PROMPT = `You are a versioning assistant. Given a list of git commits since the last release, suggest a semantic version bump level (major, minor, or patch) and explain why in one sentence.

Rules:
- PATCH (x.y.Z): bug fixes, docs, refactoring, dependency updates, small tweaks
- MINOR (x.Y.0): new features, enhancements, new tools/commands, non-breaking additions
- MAJOR (X.0.0): breaking changes, API removals, architectural rewrites, incompatible changes

Respond in JSON format only:
{"level": "patch|minor|major", "reason": "one sentence explanation"}`;

export async function generateVersionSuggestion(
  commits: GitCommit[],
  currentVersion: string,
  projectName: string,
): Promise<VersionSuggestion> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return fallbackVersionSuggestion(commits, currentVersion);
  }

  try {
    const client = new Anthropic({ apiKey });

    const commitList = commits
      .map((c) => `- ${c.shortHash} ${c.subject} (${c.author})`)
      .join("\n");

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: VERSION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Project: ${projectName}\nCurrent version: ${currentVersion}\n\nCommits since last release:\n${commitList}\n\nSuggest the version bump.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = textBlock.text.trim();
      const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (jsonMatch) jsonText = jsonMatch[1].trim();

      const parsed = JSON.parse(jsonText);
      const level: BumpLevel = ["major", "minor", "patch"].includes(parsed.level) ? parsed.level : "patch";
      const nextVersion = bumpVersion(currentVersion, level);

      return {
        level,
        reason: parsed.reason || "Version bump suggested by AI analysis",
        currentVersion,
        nextVersion,
      };
    }

    return fallbackVersionSuggestion(commits, currentVersion);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Version suggestion AI failed: ${errMsg}`);
    return fallbackVersionSuggestion(commits, currentVersion);
  }
}

export function fallbackVersionSuggestion(
  commits: GitCommit[],
  currentVersion: string,
): VersionSuggestion {
  const subjects = commits.map((c) => c.subject.toLowerCase());

  // Check for MAJOR indicators
  const majorPatterns = /\b(break|breaking|rewrite|remove|removed)\b/;
  if (subjects.some((s) => majorPatterns.test(s))) {
    const nextVersion = bumpVersion(currentVersion, "major");
    return {
      level: "major",
      reason: "Detected breaking change or removal in commit messages",
      currentVersion,
      nextVersion,
    };
  }

  // Check for MINOR indicators
  const minorPatterns = /\b(feat|add|adds|added|new|implement|implemented)\b/;
  if (commits.length > 5 || subjects.some((s) => minorPatterns.test(s))) {
    const nextVersion = bumpVersion(currentVersion, "minor");
    return {
      level: "minor",
      reason:
        commits.length > 5
          ? `${commits.length} commits since last release suggest feature work`
          : "Detected new feature or addition in commit messages",
      currentVersion,
      nextVersion,
    };
  }

  // Default to PATCH
  const nextVersion = bumpVersion(currentVersion, "patch");
  return {
    level: "patch",
    reason: "Bug fixes, docs, or minor improvements",
    currentVersion,
    nextVersion,
  };
}
