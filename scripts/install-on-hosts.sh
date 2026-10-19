#!/usr/bin/env bash
# Installs or updates the newest packaged VSIX on remote hosts over SSH, through the VS Code Server that
# Remote-SSH already put on each host. VS Code's own automatic install never updates an installed copy.
#
# Usage: scripts/install-on-hosts.sh host [host ...]     (hosts as in your ~/.ssh/config)
set -euo pipefail

cd "$(dirname "$0")/.."
vsix=$(ls -t vscode-workspace-identity-*.vsix 2>/dev/null | head -1 || true)
[ -n "$vsix" ] || { echo "No .vsix here; run 'npm run package' first." >&2; exit 1; }
[ $# -gt 0 ] || { echo "Usage: $0 host [host ...]" >&2; exit 1; }
echo "Installing $vsix"

failed=0
for host in "$@"; do
	echo "== $host"
	# Relative to the remote home directory.
	remote_vsix=".vscode-workspace-identity.vsix"
	if ! scp -q "$vsix" "$host:$remote_vsix"; then
		echo "   copy failed" >&2; failed=1; continue
	fi
	ssh "$host" bash -s -- "$remote_vsix" <<'REMOTE' || failed=1
set -euo pipefail
# The server CLI resolves relative paths against the home directory, not the current one.
vsix="$PWD/$1"
trap 'rm -f "$vsix"' EXIT
# Newest server first. Current layout: ~/.vscode-server/cli/servers/Stable-<commit>/server; older: ~/.vscode-server/bin/<commit>.
cli=$(ls -td ~/.vscode-server/cli/servers/*/server/bin/code-server ~/.vscode-server/bin/*/bin/code-server 2>/dev/null | head -1 || true)
if [ -z "$cli" ]; then
	echo "   no VS Code Server here yet: connect once with Remote-SSH, then run this again" >&2
	exit 1
fi
"$cli" --install-extension "$vsix" --force 2>&1 | sed 's/^/   /'
REMOTE
done

[ "$failed" -eq 0 ] && echo "Done. Reload the open windows on these hosts to run the new version."
exit "$failed"
