# Letta compatibility patches

These patches target `@letta-ai/letta-code` **0.34.4** and fail if their expected bundle anchors change. Docker applies them at build time. Run `node scripts/check.mjs letta-bundle` against the original pinned package before upgrading.

## Worker execution

`worker-execution.mjs` fixes a mismatch between one-shot workers and tools that return before their work finishes. A worker's final response becomes its task result; a promise to answer on a later notification is not a completed assignment.

The patch detects workers through runtime-scoped execution settings and subagent depth, including workers hosted by a shared listener. In workers:

- Bash ignores `run_in_background`, permits foreground sleep, and waits for the command's output. Its existing default timeout (2 minutes), maximum timeout (10 minutes), cancellation, output handling, and exit-code reporting remain in use.
- `exec_command` ignores the yield interval, waits for exit, and applies a 2-minute process timeout. It preserves shell, working-directory, output, and cancellation handling.
- External tools return their operation's result rather than an automatically generated background task receipt.
- Persistent Monitor calls are unavailable. A worker can report a monitoring requirement to its parent instead.
- Worker tool descriptions and parameter guidance match this execution policy. Parent tool definitions are not mutated. Letta's existing foreground handling for nested agents remains in place.

This governs Letta-managed execution; it is not a sandbox against arbitrary shell scripts that deliberately detach their own processes. The general-purpose worker instructions also prohibit shell detachment and require a completed result or an explicit blocker.

The general-purpose definition in `../agents/general-purpose.md` is installed at service startup, alongside the research definition. It uses the Telnyx GLM worker model configured by `ASSISTANT_TASK_MODEL`, with provider effort high. The main assistant prompt does not need to copy execution instructions into every assignment.

Tests extract and execute the actual patched bundle functions. Linux additionally runs the original reproduction (`sleep 20`, then exact integer multiplication) through the patched Bash implementation with a real shell. The command must return `202910851145973522` in its only response and emit no background notification. Windows skips this shell-specific test.

Rebuild and recreate the Letta service to activate bundle changes; changing these source files alone does not modify a running container. Run a fresh delegated task after activation to verify the complete model-to-worker path.

## Model requests

The model-requests.mjs patch routes native and forked workers to the configured Telnyx GLM model and applies provider effort high. For Haiku 5.5 it applies thinking and output effort independently: text uses adaptive thinking; voice sends thinking disabled with medium effort. Sampling parameters are omitted. The Claude mod supplies the model descriptor missing from the pinned catalog. Outgoing-request tests exercise the real Pi streaming adapter.
