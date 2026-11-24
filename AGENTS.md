# MMO Auto Review

The canonical project memory entry point is `memory/index.md`; current scope is
in `context.md`, and active coordinator state is in `memory/state.json`.
Before resuming, read those files and the active task/handoff they reference,
then reconcile actual Git files and supervised worker processes before writing.
Product implementation follows the user's Brain × Hands policy: use supervised
Grok/Antigravity workers with exclusive ownership; the coordinator owns review,
verification and memory documents.
