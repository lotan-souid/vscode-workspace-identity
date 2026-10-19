import { promises as fs } from 'fs';
import * as path from 'path';
import { applyEdits, FormattingOptions, modify, parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { DesiredSetting, isPlainObject, SettingPath } from './hosts';

/**
 * A host's Remote settings live in `<server data dir>/Machine/settings.json`, e.g.
 * `~/.vscode-server/data/Machine/settings.json`. The remote extension host keeps global storage under
 * `<server data dir>/User/...`, so walking up from there finds the data dir of whichever server build
 * is running (Stable, Insiders, forks, a custom install path).
 */
export function machineSettingsPath(globalStoragePath: string): string | undefined {
	let dir = path.resolve(globalStoragePath);
	for (;;) {
		if (path.basename(dir) === 'User') {
			return path.join(path.dirname(dir), 'Machine', 'settings.json');
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

interface ManagedEntry {
	path: string[];
	/** Whether the path held a value before it was first managed, and that value, for restoring it later. */
	hadPrevious: boolean;
	previous?: unknown;
}

/** Kept beside the settings file, so every window connected to the host shares it. */
interface HostState {
	version: 1;
	managed: Record<string, ManagedEntry>;
}

export interface ApplyResult {
	changed: boolean;
	written: SettingPath[];
	restored: SettingPath[];
}

const LOCK_STALE_MS = 10_000;

function stateFilePath(settingsFile: string): string {
	return path.join(path.dirname(settingsFile), '.workspace-identity.json');
}

/**
 * Makes the settings in `desired` hold in the settings file, and puts back what was there before for
 * every path it managed earlier but no longer wants. Comments and unrelated settings are left alone.
 */
export function applyManagedSettings(settingsFile: string, desired: readonly DesiredSetting[]): Promise<ApplyResult> {
	return withLock(settingsFile, async () => {
		const stateFile = stateFilePath(settingsFile);
		const original = (await readText(settingsFile)) ?? '';
		const baseline = original.trim() ? original : '{}';
		assertSettingsObject(settingsFile, baseline);

		const state = await readState(stateFile);
		const stateBefore = JSON.stringify(state);
		const formatting = detectFormatting(baseline);
		const wanted = new Map(desired.map(d => [pathKey(d.path), d]));
		const result: ApplyResult = { changed: false, written: [], restored: [] };
		let text = baseline;

		for (const [key, entry] of Object.entries(state.managed)) {
			if (wanted.has(key)) {
				continue;
			}
			text = setValue(text, entry.path, entry.hadPrevious ? entry.previous : undefined, formatting);
			text = removeIfEmptyObject(text, entry.path.slice(0, -1), formatting);
			delete state.managed[key];
			result.restored.push(entry.path);
		}

		for (const [key, { path: settingPath, value }] of wanted) {
			const current = getValue(text, settingPath);
			state.managed[key] ??= { path: [...settingPath], hadPrevious: current !== undefined, previous: current };
			if (!deepEqual(current, value)) {
				text = setValue(text, settingPath, value, formatting);
				result.written.push(settingPath);
			}
		}

		// State first: if the settings write then fails, the next run still knows what to restore.
		if (JSON.stringify(state) !== stateBefore) {
			await writeState(stateFile, state);
		}
		if (text !== baseline) {
			await writeAtomic(settingsFile, text);
			result.changed = true;
		}
		return result;
	});
}

/** The value at `settingPath` in the settings file, or undefined when it is missing. */
export async function readSetting(settingsFile: string, settingPath: SettingPath): Promise<unknown> {
	const text = await readText(settingsFile);
	return text === undefined ? undefined : getValue(text, settingPath);
}

function pathKey(settingPath: SettingPath): string {
	return JSON.stringify(settingPath);
}

function getValue(text: string, settingPath: SettingPath): unknown {
	let node: unknown = parse(text, [], { allowTrailingComma: true });
	for (const key of settingPath) {
		if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) {
			return undefined;
		}
		node = node[key];
	}
	return node;
}

/** `value` undefined removes the property. */
function setValue(text: string, settingPath: SettingPath, value: unknown, formattingOptions: FormattingOptions): string {
	return applyEdits(text, modify(text, [...settingPath], value, { formattingOptions }));
}

function removeIfEmptyObject(text: string, settingPath: SettingPath, formatting: FormattingOptions): string {
	if (settingPath.length === 0) {
		return text;
	}
	const value = getValue(text, settingPath);
	return isPlainObject(value) && Object.keys(value).length === 0 ? setValue(text, settingPath, undefined, formatting) : text;
}

function assertSettingsObject(file: string, text: string): void {
	const errors: ParseError[] = [];
	const root: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length) {
		const { error, offset } = errors[0];
		throw new Error(`${file} is not valid JSON (${printParseErrorCode(error)} at offset ${offset}), so it was left untouched.`);
	}
	if (!isPlainObject(root)) {
		throw new Error(`${file} does not hold a JSON object, so it was left untouched.`);
	}
}

/** Matches the file's indentation; VS Code itself writes settings with tabs. */
function detectFormatting(text: string): FormattingOptions {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const indent = /^([ \t]+)\S/m.exec(text)?.[1];
	if (!indent || indent.startsWith('\t')) {
		return { insertSpaces: false, tabSize: 4, eol };
	}
	return { insertSpaces: true, tabSize: indent.length, eol };
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every(key => deepEqual(a[key], b[key]));
	}
	return false;
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw err;
	}
}

async function readState(stateFile: string): Promise<HostState> {
	const text = await readText(stateFile);
	if (text) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (isPlainObject(parsed) && parsed.version === 1) {
				return { version: 1, managed: isPlainObject(parsed.managed) ? (parsed.managed as Record<string, ManagedEntry>) : {} };
			}
		} catch {
			// Unreadable state: start over rather than block the identity.
		}
	}
	return { version: 1, managed: {} };
}

function writeState(stateFile: string, state: HostState): Promise<void> {
	return writeAtomic(stateFile, JSON.stringify(state, null, '\t') + '\n');
}

/**
 * Writes through a temp file and a rename, so VS Code and other windows never read a half-written file.
 * A symlinked settings file (dotfiles) stays a symlink: the rename goes to its target.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
	const target = await fs.realpath(file).catch(() => file);
	const mode = (await fs.stat(target).catch(() => undefined))?.mode;
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.writeFile(tmp, text, 'utf8');
		if (mode !== undefined) {
			await fs.chmod(tmp, mode & 0o777);
		}
		await fs.rename(tmp, target);
	} catch (err) {
		await fs.rm(tmp, { force: true });
		throw err;
	}
}

/**
 * Every window connected to the host runs its own copy of the extension, and a config change reaches
 * them all at once, so read-modify-write cycles on the settings file are serialized with a lock file.
 */
async function withLock<T>(settingsFile: string, task: () => Promise<T>): Promise<T> {
	const dir = path.dirname(settingsFile);
	const lock = path.join(dir, '.workspace-identity.lock');
	await fs.mkdir(dir, { recursive: true });
	const deadline = Date.now() + LOCK_STALE_MS + 2_000;
	for (;;) {
		try {
			await (await fs.open(lock, 'wx')).close();
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw err;
			}
		}
		const stat = await fs.stat(lock).catch(() => undefined);
		if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
			// Left behind by a window that died mid-write.
			await fs.rm(lock, { force: true });
		} else if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${lock}.`);
		} else {
			await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 50));
		}
	}
	try {
		return await task();
	} finally {
		await fs.rm(lock, { force: true });
	}
}
