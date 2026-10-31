## Git guidelines

### Commits
- Each thread that makes changes gets its own branch, and its own worktree when working locally. If the session is already on one, stay there and don't create another.
- Commit as `ben <30252796+ben-yh5@users.noreply.github.com>`. If git config shows anything else, set it for this repo before the first commit.
- Never add Co-Authored-By, Claude-Session or any other attribution to commits or PRs.
- Make small commits as you go, one logical step each, with short all-lowercase messages and no prefixes like feat: or chore:. Commit descriptions are max two bullet points, preferably one sentence.
- Never commit directly to main.
- When a feature is ready, tell me how to view it from the worktree (like starting the dev server there). Don't push yet.

### Opening a PR
- Push only when I ask for a PR (like "open a PR" or "ship it"). Use git only, not the gh CLI.
- After pushing, give me the compare link (`https://github.com/<owner>/<repo>/compare/<branch>?expand=1`) and a short all-lowercase title. I open the PR.
- Never merge a PR or push to main. I review and squash merge on GitHub, then delete the branch there.

### After a merge
I won't tell you when a PR is merged, so check for it yourself. At the start of every thread, and before new work in an existing thread, run `git fetch --prune`. A branch whose upstream is gone has been merged:
1. If it's this thread's branch, stop working on it and tell me it merged. Any further work starts on a new branch from origin/main.
2. For other branches, run `git worktree remove` on the worktree, then `git branch -D` the branch. Use -D because squash merges don't count as merged.
3. Never use --force on a worktree. If one has uncommitted changes, leave it and tell me.
4. Never touch a branch that was never pushed.
5. Fast-forward main in the main checkout if that checkout is clean.

## Code guidelines

### I. Read Before You Write
The biggest source of bad model-written code is writing before reading the codebase. Read the files you are about to touch; read, not skim. Copy the patterns that already exist, and check the imports to see what the project actually depends on, so you do not reach for axios where everything is fetch. When you cannot find a pattern, ask instead of guessing.

### II. Think Before You Code
Figure out what you are doing before you type. State your assumptions ("add authentication" is five different things, so name the one you picked) and name the tradeoffs. If something is genuinely confusing, stop and ask rather than filling the gap with plausible-looking code; that is exactly the code that passes a casual review and fails when it matters.

### III. Simplicity
Write the minimum code that solves the problem in front of you now, not the minimum that could solve every future version of it. Resist premature abstraction, skip error handling for errors that cannot occur, and hardcode values until there is a real reason to configure them. The test: if the only reason something is abstracted is "in case we need to," you have over-built it.

### IV. Surgical Changes
Your diff should be as small as the task allows. Do not touch what you were not asked to touch, match the existing style, and do not reformat; a formatter pass buries the three lines that matter inside three hundred that do not. The test is whether you can justify every changed line by the task. If a line is there because "while I was in there," revert it.

### V. Verification
The gap between code that works and code you think works is testing. When fixing a bug, write the failing test first, watch it fail, then fix it; that is the only proof you fixed the cause and not the symptom. Test behavior that can actually break, not that a constructor sets a field. If something is hard to test, that is information about the design, not permission to skip it.

### VI. Goal-Driven Execution
Every task needs a success criterion before code is written. "Add validation" becomes "reject a missing or malformed email, return 400 with a clear message, and test both cases." For anything multi-step, state the plan first so the user can catch a wrong approach before you spend an hour building it.

### VII. Debugging
When something breaks, investigate; do not guess. Read the whole error and the stack trace, reproduce the problem before you change anything, and change one thing at a time. Do not paper over an unexpected null with a null check; find out why it is null, or the bug just moves somewhere quieter.

### VIII. Dependencies
Every dependency is permanent code you do not control. Before adding one, ask whether the project or the standard library can already do it with crypto.randomUUID() over a uuid package. When you do add one, say why, so the choice is visible rather than smuggled into the manifest.

### IX. Communication
Say what you did and why, not just a block of code. Flag concerns even when you did exactly what was asked, and be precise about uncertainty: "I am not sure this library supports streaming" tells the user what to verify; "I think this should work" does not.

### X. Common Failure Modes
A few patterns recur often enough to name: the Kitchen Sink (restructuring half the codebase while you are at it), the Wrong Abstraction (copy-paste twice before you abstract), the Optimistic Path (the happy path handled and the 500 ignored), and the Runaway Refactor (a fix that cascades across files). Catch yourself in any of these and the right move is to stop, not to push through.
