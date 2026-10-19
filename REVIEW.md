# Code, security, logic and usage review

Reviewed 2026-10-19; fixes released in 0.0.4.

## Findings addressed

| Severity | Finding | Resolution |
| --- | --- | --- |
| High | Cleanup removed recovery entries before writing restored settings. A failed settings write permanently lost the backup. | Keep all recovery entries until the settings write succeeds; prune afterward. Regression tests cover failure before and after restoring settings. |
| High | Corrupt, unknown-version, or structurally invalid recovery data could be discarded or used without validation. | Validate the version, entries, paths and previous-value metadata; stop without changing settings or recovery content if invalid. |
| Medium | Predictable temporary files and default file permissions could expose sensitive settings or permit collisions. | Use UUID filenames, exclusive creation and initial mode 0600. Recovery data stays private, including existing files from older versions. Preserve settings file permissions and valid symlinks. |
| Medium | VS Code and other editors do not participate in the extension's lock. | Re-read settings before replacement and stop if the content changed. |
| Medium | Unawaited theme synchronization failures escaped the controller's error handling. Repeated events could save duplicate or stale config. | Run synchronization through the controller queue and check current rule state before writing. |
| Medium | A failed or suspended apply could still launch the theme picker and affect User settings. | Require a successful apply and reject host-theme selection while paused after cleanup. |
| Medium | Translating wildcard patterns to repeated `.*` expressions allowed exponential backtracking. | Use a bounded wildcard matching algorithm. Test a pathological pattern and literal punctuation. |
| Low | Cleanup removed pre-existing empty color objects; invalid scalar containers were unsafe to modify. | Track parent preservation and refuse nested writes into non-object containers. |

## VS Code guidance checked

- [Extension host](https://code.visualstudio.com/api/advanced-topics/extension-host): the workspace extension runs alongside the remote filesystem and uses VS Code's public API for commands, settings and UI.
- [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust): extension configuration is application-scoped, independent of workspace content. Runtime code does not execute workspace commands or load workspace scripts; restricted-mode support remains appropriate.
- [VS Code API](https://code.visualstudio.com/api/references/vscode-api#WorkspaceConfiguration): central configuration uses `ConfigurationTarget.Global`; commands, events and UI objects are registered for disposal.
- [Testing extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension) and [publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension): verify the TypeScript API baseline, independent bundle loading and the packaged VSIX. Bundle target remains Node 18 for VS Code 1.90 compatibility.

## Verification

- TypeScript strict compilation and type checking.
- 35 tests across five suites, including real temporary files and a VS Code API double for controller behavior.
- Concurrent applies, failed apply/cleanup/finalization, invalid recovery data, external edits, formatting/comments, symlinks, permissions, color contrast, rule selection and pathological wildcard matching.
- Production VSIX build and package-content inspection; only the manifest, documentation and bundled runtime are shipped.
- `npm audit`: no known vulnerabilities reported for the locked dependency graph at review time.
- Installer shell syntax and static review; no runtime shell execution, network access or telemetry in the extension.

## Limits and operational notes

- Controller tests use an API double. A real graphical Extension Development Host and live Remote-SSH/WSL/container sessions were not exercised in this environment. Manually verify native theme-picker preview/cancellation, Settings Sync, and propagation between real windows before distribution.
- Remote settings discovery and host theme selection rely on VS Code Server's settings layout and built-in theme-picker behavior. These are not public APIs for writing the Remote layer; verify them when updating VS Code.
- The lock serializes extension windows, not other editors. The content check narrows external-write races; it cannot make read/rename atomic with unrelated writers. Stale locks are reclaimed after 10 seconds, so unusually slow or suspended writes can still race.
- Configuration is shared on the host. Clients with different identity maps can overwrite each other's preferences, as documented in README.
- Invalid recovery files require restoration from backup. Deleting one discards the information needed to restore earlier settings.
- Recovery writes are retry-safe for the tested process/write failures; no filesystem `fsync` guarantee is made for power loss.
- This private repository has no distribution license; packaging intentionally retains its existing `--skip-license` option.
