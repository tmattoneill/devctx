Create a semantic version tag for the project. Uses AI analysis of commits since the last tag to suggest major/minor/patch bump.

1. If the user said "dry-run" or "preview", call `devctx_version` with `dry_run: true` and show the result.
2. If the user specified a level (e.g., "minor", "patch", "major"), pass it as `override_level`.
3. Otherwise, call `devctx_version` with defaults to create the tag and push it.

Examples:
- `/devctx-version` — AI-suggested bump, tag and push
- `/devctx-version dry-run` — preview without tagging
- `/devctx-version minor` — force a minor bump
- `/devctx-version patch dry-run` — preview a patch bump
