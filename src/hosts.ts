import { autoColor, contrastForeground, normalizeHex, withAlpha } from './colors';

/** One entry of `workspaceIdentity.hosts`. */
export interface HostConfig {
	label?: string;
	emoji?: string;
	/** `#RRGGBB`, `#RGB`, or `none`. */
	color?: string;
	theme?: string;
	settings?: Record<string, unknown>;
}

export type HostsConfig = Record<string, HostConfig>;

export interface HostInfo {
	/** `vscode.env.remoteName`, e.g. `ssh-remote`; undefined in a local window. */
	remoteName?: string;
	/** Addresses the host was reached at, from `SSH_CONNECTION`. */
	addresses: readonly string[];
	/** `os.hostname()` on the remote machine. */
	hostname: string;
	user: string;
}

export interface Identity {
	/** The hostname: the name every window on the host agrees on. */
	key: string;
	label: string;
	emoji?: string;
	/** `#RRGGBB`. */
	color?: string;
	theme?: string;
	settings: Record<string, unknown>;
	/** The `workspaceIdentity.hosts` key that matched; undefined for an automatic identity. */
	rule?: string;
}

/** Keys into nested settings objects, e.g. `['workbench.colorCustomizations', 'titleBar.activeBackground']`. */
export type SettingPath = readonly string[];

export interface DesiredSetting {
	path: SettingPath;
	value: unknown;
}

export type ColorTarget = 'titleBar' | 'activityBar' | 'statusBar';

export interface IdentityOptions {
	colorize: readonly ColorTarget[];
	windowTitle: string;
}

export const COLOR_THEME = 'workbench.colorTheme';
export const COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations';
export const WINDOW_TITLE = 'window.title';

// Keep in sync with the defaults in package.json (a test checks this).
export const DEFAULT_WINDOW_TITLE = '${identity} — ${dirty}${activeEditorShort}${separator}${rootName}';
export const DEFAULT_COLORIZE: readonly ColorTarget[] = ['titleBar', 'activityBar', 'statusBar'];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGlob(rule: string): boolean {
	return /[*?]/.test(rule);
}

/**
 * The server side of `SSH_CONNECTION` (`client-ip client-port server-ip server-port`): the address the
 * client connected to. The remote extension host sees workspace URIs as `file:`, so the SSH alias the
 * window was opened with is not available there; this address is the closest thing to it.
 */
export function sshServerAddress(sshConnection: string | undefined): string | undefined {
	const parts = sshConnection?.trim().split(/\s+/);
	return parts?.length === 4 ? parts[2] : undefined;
}

/** Case-insensitive; `*` matches any run of characters, `?` exactly one. */
export function globToRegExp(pattern: string): RegExp {
	const body = [...pattern]
		.map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
		.join('');
	return new RegExp(`^${body}$`, 'i');
}

/** Every name a rule may match: the hostname, its first label, and the SSH addresses. */
export function hostNames(host: HostInfo): string[] {
	const names = [host.hostname, host.hostname.split('.')[0], ...host.addresses];
	return [...new Set(names.filter(name => name.length > 0))];
}

/** Exact names (case-insensitive) beat patterns; among patterns, the first one declared wins. */
export function findHostConfig(hosts: HostsConfig, names: readonly string[]): { rule: string; config: HostConfig } | undefined {
	const rules = Object.keys(hosts).filter(rule => isPlainObject(hosts[rule]));
	for (const name of names) {
		const rule = rules.find(r => !isGlob(r) && r.toLowerCase() === name.toLowerCase());
		if (rule) {
			return { rule, config: hosts[rule] };
		}
	}
	for (const rule of rules.filter(isGlob)) {
		const re = globToRegExp(rule);
		if (names.some(name => re.test(name))) {
			return { rule, config: hosts[rule] };
		}
	}
	return undefined;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Undefined when no rule matches and automatic colors are off: the host then gets no identity. */
export function resolveIdentity(host: HostInfo, hosts: HostsConfig, autoColorEnabled: boolean): Identity | undefined {
	const key = host.hostname;
	const match = findHostConfig(hosts, hostNames(host));
	if (!match && !autoColorEnabled) {
		return undefined;
	}
	const config: HostConfig = match?.config ?? {};
	const theme = nonEmpty(config.theme);
	return {
		key,
		label: nonEmpty(config.label) ?? key,
		emoji: nonEmpty(config.emoji),
		color: resolveColor(config.color, theme, autoColorEnabled ? key : undefined),
		theme,
		settings: isPlainObject(config.settings) ? config.settings : {},
		rule: match?.rule,
	};
}

/**
 * An explicit color wins, and `none` turns coloring off. Otherwise a host with its own theme keeps the
 * theme's colors, since a frame color painted over them clashes; only a host with neither gets an
 * automatic color.
 */
function resolveColor(color: unknown, theme: string | undefined, autoSeed: string | undefined): string | undefined {
	const explicit = nonEmpty(color);
	if (explicit?.toLowerCase() === 'none') {
		return undefined;
	}
	const hex = normalizeHex(explicit ?? '');
	if (hex) {
		return hex;
	}
	return theme || autoSeed === undefined ? undefined : autoColor(autoSeed);
}

export function identityText(identity: Identity): string {
	return [identity.emoji, identity.label].filter(Boolean).join(' ');
}

export function colorCustomizations(color: string, targets: readonly ColorTarget[]): Record<string, string> {
	const fg = contrastForeground(color);
	const colors: Record<string, string> = {};
	if (targets.includes('titleBar')) {
		colors['titleBar.activeBackground'] = color;
		colors['titleBar.activeForeground'] = fg;
		colors['titleBar.inactiveBackground'] = withAlpha(color, 0.8);
		colors['titleBar.inactiveForeground'] = withAlpha(fg, 0.6);
	}
	if (targets.includes('activityBar')) {
		colors['activityBar.background'] = color;
		colors['activityBar.foreground'] = fg;
		colors['activityBar.inactiveForeground'] = withAlpha(fg, 0.6);
	}
	if (targets.includes('statusBar')) {
		colors['statusBar.background'] = color;
		colors['statusBar.foreground'] = fg;
	}
	return colors;
}

/**
 * The Remote settings this identity needs. `workbench.colorCustomizations` is managed per color key, so
 * colors the user set on the host by hand survive; identity fields win over the same keys in `settings`.
 */
export function desiredSettings(identity: Identity, options: IdentityOptions): DesiredSetting[] {
	const desired = new Map<string, DesiredSetting>();
	const put = (path: SettingPath, value: unknown) => desired.set(JSON.stringify(path), { path, value });

	for (const [key, value] of Object.entries(identity.settings)) {
		if (key !== COLOR_CUSTOMIZATIONS) {
			put([key], value);
		} else if (isPlainObject(value)) {
			for (const [colorKey, colorValue] of Object.entries(value)) {
				put([key, colorKey], colorValue);
			}
		}
	}
	if (identity.theme) {
		put([COLOR_THEME], identity.theme);
	}
	if (identity.color) {
		for (const [colorKey, colorValue] of Object.entries(colorCustomizations(identity.color, options.colorize))) {
			put([COLOR_CUSTOMIZATIONS, colorKey], colorValue);
		}
	}
	if (options.windowTitle.trim()) {
		put([WINDOW_TITLE], options.windowTitle.split('${identity}').join(identityText(identity)));
	}
	return [...desired.values()];
}
