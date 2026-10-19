import * as os from 'os';
import * as vscode from 'vscode';
import { autoColor, normalizeHex } from './colors';
import {
	COLOR_THEME,
	ColorTarget,
	DEFAULT_COLORIZE,
	DEFAULT_WINDOW_TITLE,
	desiredSettings,
	HostConfig,
	HostInfo,
	HostsConfig,
	Identity,
	identityText,
	isGlob,
	isPlainObject,
	resolveIdentity,
	sshServerAddress,
} from './hosts';
import { ApplyResult, applyManagedSettings, machineSettingsPath, readSetting } from './machineSettings';

const SECTION = 'workspaceIdentity';

const PRESETS = [
	{ name: 'Red', emoji: '🔴', color: '#8B1A1A' },
	{ name: 'Orange', emoji: '🟠', color: '#9A4A00' },
	{ name: 'Yellow', emoji: '🟡', color: '#7A6000' },
	{ name: 'Green', emoji: '🟢', color: '#1E6B3A' },
	{ name: 'Blue', emoji: '🔵', color: '#1F4E8C' },
	{ name: 'Purple', emoji: '🟣', color: '#5B3A8C' },
	{ name: 'Brown', emoji: '🟤', color: '#5C4033' },
	{ name: 'Black', emoji: '⚫', color: '#2B2B2B' },
];

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel('Workspace Identity', { log: true });
	const controller = new Controller(context);
	context.subscriptions.push(
		log,
		controller,
		vscode.commands.registerCommand('workspaceIdentity.menu', () => controller.menu()),
		vscode.commands.registerCommand('workspaceIdentity.setForThisHost', () => controller.setForThisHost()),
		vscode.commands.registerCommand('workspaceIdentity.chooseTheme', () => controller.chooseTheme()),
		vscode.commands.registerCommand('workspaceIdentity.resetThisHost', () => controller.resetThisHost()),
		vscode.commands.registerCommand('workspaceIdentity.cleanUpThisHost', () => controller.cleanUp()),
		vscode.commands.registerCommand('workspaceIdentity.openRemoteSettings', () => controller.openRemoteSettings()),
		vscode.commands.registerCommand('workspaceIdentity.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)),
		vscode.commands.registerCommand('workspaceIdentity.showLog', () => log.show()),
	);
	controller.start();
}

export function deactivate(): void {
	// Managed settings stay on the host on purpose: they give the next window its identity.
}

class Controller implements vscode.Disposable {
	private readonly remoteName = vscode.env.remoteName;
	/** Undefined in a local window: there is no per-machine settings layer to write to there. */
	private readonly settingsFile: string | undefined;
	private readonly status = vscode.window.createStatusBarItem('workspaceIdentity.status', vscode.StatusBarAlignment.Left, 10_000);
	private readonly disposables: vscode.Disposable[] = [this.status];
	private host: HostInfo | undefined;
	private identity: Identity | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private timer: NodeJS.Timeout | undefined;
	/** Set by Clean Up, so this window stops re-applying until it reloads. */
	private suspended = false;
	/** The last failure, shown in the status bar until an apply succeeds. */
	private lastError: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.settingsFile = this.remoteName ? machineSettingsPath(context.globalStorageUri.fsPath) : undefined;
		this.status.name = 'Workspace Identity';
		this.status.command = 'workspaceIdentity.menu';
	}

	private get version(): string {
		return `v${this.context.extension.packageJSON.version}`;
	}

	start(): void {
		if (!this.remoteName) {
			log.info('Local window: there is no per-machine settings layer here, so nothing is applied.');
			return;
		}
		log.info(`Workspace Identity ${this.version} running on ${os.hostname()} (${this.remoteName}).`);
		if (!this.settingsFile) {
			this.lastError = `Cannot locate the Remote settings file from ${this.context.globalStorageUri.fsPath}.`;
			log.error(this.lastError);
			this.render();
			return;
		}
		log.info(`Remote settings file: ${this.settingsFile}`);
		this.render();
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SECTION)) {
				this.scheduleApply();
			} else if (e.affectsConfiguration(COLOR_THEME)) {
				void this.enqueue(() => this.syncThemeBack());
			}
		}));
		void this.apply();
	}

	dispose(): void {
		clearTimeout(this.timer);
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** Runs tasks one after another, so this window never has two read-modify-write cycles in flight. */
	private enqueue<T>(task: () => Promise<T>): Promise<T | undefined> {
		const run = this.queue.then(task).catch(err => {
			this.report(err);
			return undefined;
		});
		this.queue = run;
		return run;
	}

	private scheduleApply(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.apply(), 200);
	}

	private apply(): Promise<ApplyResult | undefined> {
		return this.enqueue(async () => {
			const file = this.settingsFile;
			if (!file) {
				return undefined;
			}
			const options = readOptions();
			const address = sshServerAddress(process.env.SSH_CONNECTION);
			this.host = {
				remoteName: this.remoteName,
				addresses: address ? [address] : [],
				hostname: os.hostname(),
				user: os.userInfo().username,
			};
			this.identity = resolveIdentity(this.host, options.hosts, options.autoColor);
			if (this.suspended) {
				this.render();
				return undefined;
			}
			const result = await applyManagedSettings(file, this.identity ? desiredSettings(this.identity, options) : []);
			if (result.changed) {
				const rule = this.identity?.rule ? `rule "${this.identity.rule}"` : 'automatic';
				log.info(`Applied ${this.identity ? identityText(this.identity) : 'no identity'} (${rule}): ${result.written.length} written, ${result.restored.length} restored.`);
			}
			this.lastError = undefined;
			this.render();
			return result;
		});
	}

	/**
	 * Once a theme lives in this host's Remote settings, VS Code's own theme picker writes its choice
	 * there too. Carry that choice back to the central config, which stays the source of truth.
	 */
	private async syncThemeBack(): Promise<void> {
		const id = this.identity;
		if (this.suspended || !this.settingsFile || !id?.rule || !id.theme) {
			return;
		}
		const remoteTheme = await readSetting(this.settingsFile, [COLOR_THEME]).catch(() => undefined);
		if (typeof remoteTheme !== 'string' || remoteTheme === id.theme) {
			return;
		}
		const config = readHosts()[id.rule];
		// Another event/window may have saved this theme, or a new config may be awaiting apply.
		if (!config || config.theme === remoteTheme || config.theme !== id.theme) {
			return;
		}
		await writeHost(id.rule, { ...config, theme: remoteTheme });
		log.info(`Theme "${remoteTheme}" saved to rule "${id.rule}".`);
		// Every window on the host gets here; one notification is enough.
		if (vscode.window.state.focused) {
			void vscode.window.showInformationMessage(`Workspace Identity: theme "${remoteTheme}" saved for ${id.rule}.`);
		}
	}

	/**
	 * Always visible in a remote window: it is also the sign that the extension is installed and running
	 * on the host, since a workspace extension that is installed only locally does not run there at all.
	 */
	private render(): void {
		const id = this.identity;
		const host = this.host;
		const name = id ? identityText(id) : os.hostname();
		const tooltip = new vscode.MarkdownString(undefined, true);
		this.status.backgroundColor = undefined;

		if (this.lastError) {
			this.status.text = '$(warning) Workspace Identity';
			this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			tooltip.appendMarkdown(`**Could not apply the identity**\n\n${escapeMarkdown(this.lastError)}\n\n`);
		} else if (!host) {
			this.status.text = '$(sync~spin) Workspace Identity';
			tooltip.appendMarkdown('**Starting…**\n\n');
		} else if (this.suspended) {
			this.status.text = `$(debug-pause) ${name}`;
			tooltip.appendMarkdown('**Paused** in this window until it reloads.\n\n');
		} else if (id) {
			this.status.text = `$(vm) ${name}`;
			tooltip.appendMarkdown(`**${escapeMarkdown(name)}**\n\n`);
		} else {
			this.status.text = `$(vm-outline) ${name}`;
			tooltip.appendMarkdown('**No identity:** no entry in `workspaceIdentity.hosts` matches this host, and automatic colors are off.\n\n');
		}

		if (host) {
			const rows: [string, string][] = [
				['Hostname', host.hostname],
				['Address', host.addresses.join(', ') || '—'],
				['User', host.user],
			];
			if (id) {
				rows.push(['Rule', id.rule ?? 'automatic'], ['Theme', id.theme ?? 'global'], ['Color', id.color ?? 'none']);
			}
			tooltip.appendMarkdown('| | |\n|---|---|\n');
			for (const [label, value] of rows) {
				tooltip.appendMarkdown(`| ${label} | ${escapeMarkdown(value)} |\n`);
			}
		}
		tooltip.appendMarkdown(`\n---\n\n$(check) Workspace Identity ${escapeMarkdown(this.version)} is running on this host. Click for actions.`);
		this.status.tooltip = tooltip;
		this.status.show();
	}

	private report(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		log.error(message);
		this.lastError = message;
		this.render();
		void vscode.window.showErrorMessage(`Workspace Identity: ${message}`, 'Open Remote Settings').then(answer => {
			if (answer) {
				void this.openRemoteSettings();
			}
		});
	}

	private requireRemote(): string | undefined {
		if (!this.remoteName) {
			void vscode.window.showInformationMessage(
				'Workspace Identity works in remote windows (SSH, WSL, containers). A local window has no per-machine settings layer to write to.');
			return undefined;
		}
		if (!this.settingsFile) {
			void vscode.window.showErrorMessage('Workspace Identity: cannot locate the Remote settings file on this host. See the log for details.');
			return undefined;
		}
		return this.settingsFile;
	}

	/** The `workspaceIdentity.hosts` key to edit: the rule that matches this host, or a new entry for it. */
	private async pickRule(): Promise<string | undefined> {
		await this.queue;
		const own = this.identity?.key ?? os.hostname();
		const rule = this.identity?.rule;
		if (!rule) {
			return own;
		}
		if (!isGlob(rule)) {
			return rule;
		}
		const pick = await vscode.window.showQuickPick([
			{ label: `Only ${own}`, description: 'add an entry for this host', rule: own },
			{ label: `Every host matching ${rule}`, description: 'edit the shared rule', rule },
		], { title: 'Workspace Identity: what to change', ignoreFocusOut: true });
		return pick?.rule;
	}

	/** The entry for `rule`, or a copy of the rule this host matches today, as a starting point. */
	private baseConfig(rule: string): HostConfig {
		const hosts = readHosts();
		return hosts[rule] ?? (this.identity?.rule ? hosts[this.identity.rule] : undefined) ?? {};
	}

	async menu(): Promise<void> {
		const id = this.identity;
		const items = [
			{ label: '$(edit) Set identity for this host…', command: 'workspaceIdentity.setForThisHost' },
			{ label: '$(symbol-color) Choose theme for this host…', command: 'workspaceIdentity.chooseTheme' },
			{ label: '$(settings-gear) Open Workspace Identity settings', command: 'workspaceIdentity.openSettings' },
			{ label: '$(go-to-file) Open this host\'s Remote settings file', command: 'workspaceIdentity.openRemoteSettings' },
			{ label: '$(output) Show log', command: 'workspaceIdentity.showLog' },
		];
		const pick = await vscode.window.showQuickPick(items, {
			title: `Workspace Identity ${this.version}${id ? `: ${identityText(id)}` : ''}`,
			placeHolder: `Running on ${this.host ? `${this.host.user}@${this.host.hostname}` : os.hostname()}`,
		});
		if (pick) {
			await vscode.commands.executeCommand(pick.command);
		}
	}

	async setForThisHost(): Promise<void> {
		if (!this.requireRemote()) {
			return;
		}
		const rule = await this.pickRule();
		if (!rule) {
			return;
		}
		const base = this.baseConfig(rule);
		const title = `Workspace Identity: ${rule}`;

		const label = await vscode.window.showInputBox({
			title,
			prompt: 'Label shown in the window title and the status bar',
			value: base.label ?? this.identity?.label ?? rule,
			ignoreFocusOut: true,
		});
		if (label === undefined) {
			return;
		}
		const theme = await pickTheme(title, base.theme);
		if (!theme) {
			return;
		}
		const look = await pickColor(title, this.identity?.key ?? rule, base, theme !== 'global');
		if (!look) {
			return;
		}

		const config: HostConfig = { ...base, label: label.trim() || undefined, ...look, theme: theme === 'global' ? undefined : base.theme };
		if (theme === 'choose') {
			await this.seedThemeAndPick(rule, config);
		} else {
			await writeHost(rule, config);
		}
	}

	async chooseTheme(): Promise<void> {
		if (!this.requireRemote()) {
			return;
		}
		const rule = await this.pickRule();
		if (rule) {
			await this.seedThemeAndPick(rule, this.baseConfig(rule));
		}
	}

	/**
	 * VS Code's theme picker writes to Remote settings only when the theme is already set there, so
	 * put a theme there first, wait for VS Code to load it, and only then open the picker. Its choice
	 * comes back through syncThemeBack.
	 */
	private async seedThemeAndPick(rule: string, config: HostConfig): Promise<void> {
		const file = this.settingsFile;
		if (this.suspended) {
			void vscode.window.showInformationMessage('Workspace Identity is paused after cleanup. Reload this window before choosing a host theme.');
			return;
		}
		if (!file) {
			return;
		}
		const alreadyRemote = (await readSetting(file, [COLOR_THEME]).catch(() => undefined)) !== undefined;
		const loaded = alreadyRemote ? Promise.resolve(true) : waitForConfigChange(COLOR_THEME, 5_000);
		await writeHost(rule, { ...config, theme: config.theme ?? currentTheme() });
		const result = await this.apply();
		if (!result || !(await loaded)) {
			// Opening the picker now would change the theme of every window, not just this host's.
			void vscode.window.showWarningMessage(
				'Workspace Identity: VS Code has not loaded this host\'s Remote settings yet. Run "Preferences: Color Theme" in a moment; it will then apply to this host only.');
			return;
		}
		await vscode.commands.executeCommand('workbench.action.selectTheme');
	}

	async resetThisHost(): Promise<void> {
		if (!this.requireRemote()) {
			return;
		}
		await this.queue;
		const rule = this.identity?.rule;
		if (!rule) {
			const auto = this.identity ? ' It has an automatic color; turn off workspaceIdentity.autoColor to remove that.' : '';
			void vscode.window.showInformationMessage(`Workspace Identity: no entry in workspaceIdentity.hosts matches this host.${auto}`);
			return;
		}
		const message = isGlob(rule)
			? `This host matches the rule "${rule}", which may cover other hosts too. Remove the rule?`
			: `Remove the identity of "${rule}"?`;
		if (await vscode.window.showWarningMessage(message, { modal: true }, 'Remove') === 'Remove') {
			await writeHost(rule, undefined);
		}
	}

	async cleanUp(): Promise<void> {
		const file = this.requireRemote();
		if (!file) {
			return;
		}
		const answer = await vscode.window.showWarningMessage(
			'Remove every setting Workspace Identity wrote to this host\'s Remote settings?',
			{
				modal: true,
				detail: 'Earlier values are put back. Do this before uninstalling the extension from the host: while it stays installed, the next window on this host applies the identity again.',
			},
			'Remove');
		if (answer !== 'Remove') {
			return;
		}
		this.suspended = true;
		this.render();
		const result = await this.enqueue(() => applyManagedSettings(file, []));
		if (result) {
			log.info(`Clean up: ${result.restored.length} settings restored.`);
			void vscode.window.showInformationMessage(`Workspace Identity: ${result.restored.length} settings removed from this host.`);
		}
	}

	async openRemoteSettings(): Promise<void> {
		const file = this.requireRemote();
		if (!file) {
			return;
		}
		if (await readSetting(file, []) === undefined) {
			void vscode.window.showInformationMessage(`Workspace Identity: ${file} does not exist yet.`);
			return;
		}
		await vscode.window.showTextDocument(vscode.Uri.file(file));
	}
}

function readHosts(): HostsConfig {
	const hosts = vscode.workspace.getConfiguration(SECTION).get<unknown>('hosts');
	return isPlainObject(hosts) ? (hosts as HostsConfig) : {};
}

function readOptions() {
	const config = vscode.workspace.getConfiguration(SECTION);
	return {
		hosts: readHosts(),
		autoColor: config.get<boolean>('autoColor', true),
		colorize: config.get<ColorTarget[]>('colorize', [...DEFAULT_COLORIZE]),
		windowTitle: config.get<string>('windowTitle', DEFAULT_WINDOW_TITLE),
	};
}

/** `config` undefined removes the entry. */
async function writeHost(rule: string, config: HostConfig | undefined): Promise<void> {
	const settings = vscode.workspace.getConfiguration(SECTION);
	const hosts: HostsConfig = Object.assign(Object.create(null), settings.inspect<HostsConfig>('hosts')?.globalValue);
	if (config) {
		hosts[rule] = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '')) as HostConfig;
	} else {
		delete hosts[rule];
	}
	// `hosts` is application-scoped, so Global always lands in the local User settings, which Settings Sync carries.
	await settings.update('hosts', hosts, vscode.ConfigurationTarget.Global);
}

function currentTheme(): string | undefined {
	return vscode.workspace.getConfiguration().get<string>(COLOR_THEME);
}

function waitForConfigChange(section: string, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			listener.dispose();
			resolve(false);
		}, timeoutMs);
		const listener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(section)) {
				clearTimeout(timer);
				listener.dispose();
				resolve(true);
			}
		});
	});
}

/**
 * With a theme of its own, a host is already set apart, so the first choice leaves the frame to the
 * theme; a frame color then only adds to it.
 */
async function pickColor(title: string, key: string, current: HostConfig, hasTheme: boolean): Promise<Pick<HostConfig, 'color' | 'emoji'> | undefined> {
	type Item = vscode.QuickPickItem & { look?: Pick<HostConfig, 'color' | 'emoji'> };
	const auto = autoColor(key);
	const items: Item[] = [
		...(hasTheme ? [{ label: '$(symbol-color) Theme colors only', description: 'no frame color', look: { color: undefined, emoji: current.emoji } }] : []),
		...(current.color ? [{ label: '$(check) Keep current', description: current.color, look: { color: current.color, emoji: current.emoji } }] : []),
		...PRESETS.map(p => ({ label: `${p.emoji} ${p.name}`, description: p.color, look: { color: p.color, emoji: p.emoji } })),
		{ label: '$(sparkle) Automatic', description: `${auto}, from the host name`, look: { color: auto, emoji: undefined } },
		{ label: '$(edit) Custom…', description: 'a #RRGGBB color' },
		...(hasTheme ? [] : [{ label: '$(circle-slash) No color', look: { color: 'none', emoji: undefined } }]),
	];
	const pick = await vscode.window.showQuickPick(items, {
		title,
		placeHolder: hasTheme ? 'Frame color on top of the theme (optional)' : 'Color for this host\'s window frame',
		ignoreFocusOut: true,
	});
	if (!pick || pick.look) {
		return pick?.look;
	}
	const hex = await vscode.window.showInputBox({
		title,
		prompt: 'Color as #RRGGBB',
		value: current.color,
		validateInput: value => (normalizeHex(value) ? undefined : 'Use #RGB or #RRGGBB'),
		ignoreFocusOut: true,
	});
	return hex === undefined ? undefined : { color: normalizeHex(hex), emoji: current.emoji };
}

type ThemeChoice = 'keep' | 'choose' | 'global';

async function pickTheme(title: string, current: string | undefined): Promise<ThemeChoice | undefined> {
	const items: (vscode.QuickPickItem & { choice: ThemeChoice })[] = [
		...(current ? [{ label: `$(check) Keep ${current}`, choice: 'keep' as const }] : []),
		{ label: '$(symbol-color) Choose a theme…', description: 'the theme picker, with live preview', choice: 'choose' },
		{ label: '$(globe) Use the global theme', description: 'the same theme as every other window', choice: 'global' },
	];
	return (await vscode.window.showQuickPick(items, { title, placeHolder: 'Color theme for this host', ignoreFocusOut: true }))?.choice;
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}
