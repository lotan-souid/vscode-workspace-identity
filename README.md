# Workspace Identity

Every remote host gets its own color theme, window color and title, so you can tell at a glance which machine a VS Code window is connected to. Everything else stays shared.

## How it works

VS Code layers settings like this, weakest first:

```
Default < User (local, synced by Settings Sync) < Remote [SSH: host] < Workspace < Folder
```

The **Remote** layer is a file on the host itself, `~/.vscode-server/data/Machine/settings.json`, and it applies only to windows connected to that host. Workspace Identity keeps one central map of hosts in your **User** settings, and writes each host's part of it into that host's Remote settings. Your other User settings stay global.

- Only the keys it manages are touched. Comments and the other settings in the file are kept.
- `workbench.colorCustomizations` is managed per color key. Colors you set on the host by hand survive.
- Values that were there before are put back when an entry is removed. Recovery data is retained until restoration succeeds.
- If recovery data is corrupt or unsupported, settings are left untouched. Restore `.workspace-identity.json` from backup before retrying; deleting it loses the earlier values.

## Configuration

In User settings (`Preferences: Open User Settings (JSON)`):

```jsonc
"workspaceIdentity.hosts": {
  "prod-*":  { "label": "PROD", "emoji": "🔴", "color": "#8B1A1A", "theme": "Default Dark Modern" },
  "dev-box": { "label": "DEV",  "emoji": "🟢", "theme": "Solarized Light" },
  "gpu-01":  { "label": "GPU",  "settings": { "terminal.integrated.fontSize": 15 } }
},
"workspaceIdentity.autoColor": true,
"workspaceIdentity.colorize": ["titleBar", "activityBar", "statusBar"],
"workspaceIdentity.windowTitle": "${identity} — ${dirty}${activeEditorShort}${separator}${rootName}"
```

| Field | Meaning |
|---|---|
| key | Hostname or the IP address you connect to, case-insensitive. `*` and `?` are wildcards. An exact name beats a pattern; among patterns the first listed wins. |
| `label`, `emoji` | Shown in the window title (`${identity}`) and the status bar. |
| `color` | Title bar, activity bar and status bar color; `none` for no color. Without it, a host with its own `theme` keeps the theme's colors, and any other host gets a stable color from its name (`autoColor`). |
| `theme` | Color theme for this host. Leave it out to keep the global theme. |
| `settings` | Any other setting to override on this host. |

Each host is matched by its hostname, its short hostname, and the address you connected to over SSH. The alias from your local `~/.ssh/config` never reaches the host, so it cannot be matched.

## Status bar

Every remote window where the extension runs shows an item at the left of the status bar. That item is also how you know the extension is installed on the host. A workspace extension installed only on your local machine does not run in a remote window at all; the Extensions view lists it under *SSH: host* with an *Install in SSH: …* button.

| Item | Meaning |
|---|---|
| `$(vm) 🔴 PROD` | Identity applied |
| `$(vm-outline) host` | Running, but no entry matches and `autoColor` is off |
| `$(warning) Workspace Identity` (red) | The last apply failed; hover for the reason |
| `$(debug-pause) host` | Paused by *Clean Up* until the window reloads |

Hover for the hostname, address, user, matching rule, theme, color and extension version.

## Commands

Click the status bar item, or open the Command Palette under **Workspace Identity**:

- **Set Identity for This Host…** prompts for the label, color and theme, then saves them to the central map.
- **Choose Theme for This Host…** opens VS Code's theme picker with live preview, applied to this host only. Once a host has a theme, the regular `Preferences: Color Theme` also changes only that host, and the choice is saved back to the central map.
- **Remove Identity of This Host**, **Clean Up Remote Settings on This Host**, **Open This Host's Remote Settings File**, **Show Log**.

## Installing on hosts

The extension runs on the remote host (`extensionKind: workspace`). In a remote window, only the copy on the host runs. A copy on your own computer idles: local windows have no per-machine settings layer.

### Automatically on every host, without the Marketplace

1. **Install the VSIX on your own computer.** Settings Sync does not carry a VSIX-installed extension to your other computers, so repeat this on each one.
   ```sh
   code --install-extension vscode-workspace-identity-<version>.vsix
   ```
2. **List it in your User settings.** This setting is synced.
   ```jsonc
   "remote.defaultExtensionsIfInstalledLocally": ["lotsuid.vscode-workspace-identity"]
   ```

From then on, every remote window checks whether the host has the extension. If it does not, VS Code packs your local copy and installs it there.

### Updating hosts

The automatic install checks only whether the extension is present, never its version, so a new version needs one more step:

1. Install the new VSIX on your own computer, so new hosts get it.
2. Update existing hosts over SSH:
   ```sh
   scripts/install-on-hosts.sh host1 host2
   ```
   The script uses the VS Code Server that Remote-SSH already put on each host. Run it from any machine that can SSH to them, such as Git Bash on Windows.
3. Reload the open windows on those hosts.

### By hand, on one host

In a terminal of a remote window, run `code --install-extension vscode-workspace-identity-<version>.vsix`.

### Through the Marketplace

Publish the extension. Then `"remote.SSH.defaultExtensions": ["<publisher>.vscode-workspace-identity"]` installs it on every host, and the Marketplace keeps every copy updated.

### Own the publisher ID

When installing on a host or syncing, VS Code first looks for the extension ID in the Marketplace and prefers what it finds there over your local copy. Use a publisher ID you have registered, so nobody else can publish an extension under this ID.

## Things to know

- **Workspace settings win.** A repo whose `.vscode/settings.json` sets a theme or colors overrides the host identity.
- **All clients should share one config.** The identity is stored on the host. Two computers with different `workspaceIdentity.hosts` (no Settings Sync) will keep overwriting each other's choice.
- **A short flash on connect.** The local theme can show for a moment until VS Code has loaded the host's Remote settings.
- **Title bar colors** need `window.titleBarStyle: custom`.
- **`window.autoDetectColorScheme`**, when on, makes VS Code use `workbench.preferred*ColorTheme` instead of `workbench.colorTheme`.
- **Uninstalling** leaves the managed settings on the host. Run *Clean Up Remote Settings on This Host* first.
- **Local windows** have no per-machine settings layer, so they are left as they are.

## Development

Node is needed only on the machine you develop on. The hosts that run the extension use the Node bundled with VS Code Server. The project pins Node 24 LTS in `.nvmrc`:

```sh
nvm install       # reads .nvmrc
npm install
npm test          # logic, filesystem and controller tests (VS Code API double)
npm run build     # bundle to dist/extension.js
npm run package   # build a .vsix
```

`F5` opens an Extension Development Host. When this project is open over Remote-SSH, that window is connected to the same host. The Remote settings it writes therefore apply to **every** window on that host, including the one you develop in.

Files on the host, next to `Machine/settings.json`:

- `.workspace-identity.json` holds what was managed and the values to restore.
- `.workspace-identity.lock` serializes writes between windows.

Review findings, verification and manual test limits are recorded in [REVIEW.md](https://github.com/lotan-souid/vscode-workspace-identity/blob/main/REVIEW.md); changes are listed in [CHANGELOG.md](CHANGELOG.md).
