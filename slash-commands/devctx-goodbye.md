End-of-session wrap-up. Before calling the goodbye tool, handle any uncommitted changes:

1. Run `git status` to check for uncommitted changes (staged, modified, or untracked files).
2. If the working tree is dirty:
   - If the user passed "commit" after this command: stage all changes with `git add -A`, generate a comprehensive commit message summarizing the changes (look at the diff), and commit.
   - Otherwise: tell the user there are uncommitted changes and ask if they'd like to commit before wrapping up. If yes, stage all changes, generate a good commit message from the diff, and commit. If no, proceed without committing.
3. Call the `devctx_goodbye` tool. If the user provided a message (other than "commit"), pass it as the message parameter.

The goodbye tool will automatically sync and commit CLAUDE.md as its final step.
