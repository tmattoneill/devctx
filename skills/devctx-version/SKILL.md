---
name: devctx-version
description: "Suggest and create a semantic version tag from the commits since the last tag. Use when the user asks to cut a release, bump the version or tag the project."
---

<!-- Generated from slash-commands/devctx-version.md by scripts/gen-skills.mjs. Do not edit. -->

Create a semantic version tag for the project. Uses AI analysis of commits since the last tag to suggest major/minor/patch bump.

1. If the user said "dry-run" or "preview", call `devctx_version` with `dry_run: true` and show the result.
2. If the user specified a level (e.g., "minor", "patch", "major"), pass it as `override_level`.
3. Otherwise, call `devctx_version` with defaults to create the tag and push it.

Examples:
- `/devctx-version` — AI-suggested bump, tag and push
- `/devctx-version dry-run` — preview without tagging
- `/devctx-version minor` — force a minor bump
- `/devctx-version patch dry-run` — preview a patch bump
