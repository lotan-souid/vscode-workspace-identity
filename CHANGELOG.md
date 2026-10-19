# Changelog

## 0.0.5 — 2026-10-19

- Document the Windows Git Bash workflow for building a VSIX and updating Linux Remote-SSH hosts.
- Clarify that local updates and Settings Sync do not upgrade existing remote installations.
- Explain installer prerequisites, package selection, supported hosts and version verification.
- Clarify Marketplace auto-update requirements when migrating from VSIX installations.
- No runtime code changes since 0.0.4.

## 0.0.4 — 2026-10-19

- Preserve recovery data until Remote settings are successfully restored, so failed cleanup can be retried safely.
- Reject corrupt or unsupported recovery files instead of silently discarding backups.
- Create temporary settings and recovery files privately; secure recovery files left by earlier versions.
- Detect settings edits made outside the extension lock before replacing the file.
- Preserve existing empty color objects and refuse to overwrite scalar color containers.
- Serialize theme synchronization, report asynchronous failures, and avoid redundant or stale config updates.
- Stop the theme picker when applying Remote settings fails or the extension is paused after cleanup.
- Match host wildcards without regular-expression backtracking.
- Add regression tests for recovery failures, permissions, symlinks, concurrent windows, and controller behavior.
