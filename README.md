# Archon provider: opencode-v2

Experimental external provider for a supervised pilot. Uses Archon's official provider protocol and the official OpenCode V2 client. No Archon engine or shared workflow changes.

Exact tested versions:

- Archon: `9155ff15d1d557c1fee4e5e1627e14d0beafcf73` (CLI 0.11.1).
- OpenCode CLI and `@opencode/client`: **2.0.32**.
- Bun compiler: **1.4.3**. Dependency versions/integrity hashes are in `bun.lock`.
- Model: `opencode-go/deepseek-v4.1-flash`.

## Build and check

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun test
```

Optional live tests spend subscription usage and create native OpenCode session history:

```sh
bun run test:live
ARCHON_CHECKOUT=/path/to/exact/archon-checkout LOG_LEVEL=silent bun test/pinned-host.ts
```

The supplied Linux x64 executable is the unchanged artifact tested before publication preparation. Six tests passed, including authenticated tool/JSON, cancellation and timeout tests. A separate cancellation test through the exact pinned Archon process host also passed. Publication preparation rechecks the checksum, type checking and three offline tests; live tests are not repeated merely to package the release.

## Behavior and limits

One foreground session per plugin process, explicit model selection, block streaming, built-in shell/file tools, cancellation and owned-process cleanup. A private-pipe non-AI cleanup monitor handles forced termination by the pinned host. Binary/API versions are checked; other HTTP origins and non-V2 API routes are rejected. There is no V1 fallback.

Structured output is **best-effort** JSON Schema validation, not grammar enforcement. Unsupported: resume/fork, Archon native tools (`manage_run`), user plugins/skills/MCP/hooks/subagents, portable tool restrictions, environment injection, effort/fallback controls, sandbox/container execution, budgets and usage reporting. Background-work visibility is `unobserved`; arbitrary shell code is not sandboxed.

Native OpenCode authentication is reused through its supported database path override; credentials are never copied. The plugin itself checks database accessibility without reading credential values; OpenCode handles authentication. Credential preflight reports `not_checked/native`; only an actual model call proves authorization. Sessions remain in native history. Temporary HOME/config/state/cache and an allowlist of 12 built-ins isolate personal settings, project configuration, skills and MCP. System OpenCode configuration causes a fail-closed review requirement.

## Install after review

This release targets only the exact Archon commit above; the manifest's CLI version gate alone does not verify a Git commit. Set `ARCHON_CHECKOUT` to that checkout and verify its HEAD before invoking the official installer:

```sh
test "$(git -C "$ARCHON_CHECKOUT" rev-parse HEAD)" = 9155ff15d1d557c1fee4e5e1627e14d0beafcf73
bun "$ARCHON_CHECKOUT/packages/cli/src/cli.ts" plugin install dadu523/archon-provider-opencode-v2@v0.1.0
```

The installer verifies the release checksum and descriptor. Restart an existing Archon server after an approved install. Keep an existing working provider as the default/orchestrator; this plugin has no `manage_run` bridge. Review installation and configuration before starting a workflow. Scheduling, merging and deployment are outside this plugin.

## License and provenance

Provider code: MIT (`LICENSE`). Unmodified `vendor/provider-contract` is copied from the exact Archon pin; Cole Medin's MIT notice is preserved in `vendor/ARCHON-LICENSE`. Dependency and compiled Bun runtime notices are included in `licenses/` and the release's `THIRD_PARTY_NOTICES.txt`. OpenCode CLI itself is not bundled.

[Provider specification](https://github.com/coleam00/Archon/blob/9155ff15d1d557c1fee4e5e1627e14d0beafcf73/packages/docs-web/src/content/docs/contributing/adding-a-community-provider.mdx) · [Publishing contract](https://github.com/coleam00/Archon/blob/9155ff15d1d557c1fee4e5e1627e14d0beafcf73/packages/docs-web/src/content/docs/guides/publishing-plugins.md) · [Official V2 client](https://github.com/anomalyco/opencode/tree/v2.0.32/packages/client).

Closed/unmerged [PR #2760](https://github.com/coleam00/Archon/pull/2760) and [PR #2761](https://github.com/coleam00/Archon/pull/2761) were technical references only; neither implementation was installed into Archon.
