import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';
import { applyManagedSettings, readSetting } from '../machineSettings';

/** Runs the shipped entrypoint against a small API double and real temporary settings files. */
async function extensionHarness(remoteName: string | undefined = 'ssh-remote') {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-controller-'));
	const settingsFile = path.join(dir, 'Machine', 'settings.json');
	const listeners = new Set<(event: { affectsConfiguration: (section: string) => boolean }) => void>();
	const commands = new Map<string, () => Promise<void>>();
	const errors: string[] = [];
	const executed: string[] = [];
	const state = { hosts: { '*': { theme: 'Original' } }, failUpdate: false, updates: 0, renders: 0 };
	const disposable = () => ({ dispose() {} });
	const emit = (section: string) => {
		for (const listener of [...listeners]) {
			listener({ affectsConfiguration: candidate => candidate === section });
		}
	};
	const api = {
		env: { remoteName },
		StatusBarAlignment: { Left: 1 },
		ConfigurationTarget: { Global: 1 },
		Disposable: { from: (...items: { dispose(): void }[]) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
		MarkdownString: class { appendMarkdown() { return this; } },
		ThemeColor: class {},
		window: {
			state: { focused: true },
			createOutputChannel: () => ({ ...disposable(), info() {}, error() {}, show() {} }),
			createStatusBarItem: () => ({ ...disposable(), show: () => state.renders++ }),
			showErrorMessage: async (message: string) => { errors.push(message); },
			showInformationMessage: async () => undefined,
			showWarningMessage: async () => undefined,
			showQuickPick: async () => ({ rule: '*' }),
		},
		commands: {
			registerCommand: (name: string, handler: () => Promise<void>) => {
				commands.set(name, handler);
				return disposable();
			},
			executeCommand: async (name: string) => { executed.push(name); },
		},
		workspace: {
			onDidChangeConfiguration: (listener: Parameters<typeof listeners.add>[0]) => {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			},
			getConfiguration: () => ({
				get: (key: string, fallback: unknown) => key === 'hosts' ? state.hosts : fallback,
				inspect: () => ({ globalValue: state.hosts }),
				update: async (_key: string, value: typeof state.hosts) => {
					state.updates++;
					if (state.failUpdate) {
						throw new Error('simulated User settings failure');
					}
					state.hosts = value;
				},
			}),
		},
	};
	const extensionModule: { exports: { activate?: (context: vscode.ExtensionContext) => void } } = { exports: {} };
	const bundle = await fs.readFile(path.join(__dirname, '..', '..', 'dist', 'extension.js'), 'utf8');
	runInNewContext(bundle, {
		module: extensionModule, exports: extensionModule.exports,
		require: (name: string) => name === 'vscode' ? api : require(name),
		process, console, setTimeout, clearTimeout,
	});
	const subscriptions: { dispose(): void }[] = [];
	extensionModule.exports.activate!({
		subscriptions,
		globalStorageUri: { fsPath: path.join(dir, 'User', 'globalStorage', 'test') },
		extension: { id: 'test.identity', packageJSON: { version: 'test' } },
	} as unknown as vscode.ExtensionContext);
	return {
		state, errors, executed, emit, settingsFile,
		command: (name: string) => commands.get(`workspaceIdentity.${name}`)!(),
		dispose: async () => {
			subscriptions.forEach(item => item.dispose());
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'controller did not settle');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

test('local activation leaves machine settings untouched', async () => {
	const harness = await extensionHarness('');
	try {
		assert.equal(harness.state.renders, 0);
		await assert.rejects(fs.stat(harness.settingsFile), { code: 'ENOENT' });
	} finally {
		await harness.dispose();
	}
});

test('theme events are serialized, saved once, and settings failures are reported', async () => {
	const h = await extensionHarness();
	try {
		await waitFor(() => h.state.renders >= 2);
		await applyManagedSettings(h.settingsFile, [{ path: ['workbench.colorTheme'], value: 'Picked' }]);
		h.emit('workbench.colorTheme');
		h.emit('workbench.colorTheme');
		await waitFor(() => h.state.updates === 1);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(h.state.hosts['*'].theme, 'Picked');
		assert.equal(h.state.updates, 1);
		h.state.failUpdate = true;
		h.emit('workspaceIdentity');
		await waitFor(() => h.state.renders >= 3);
		await applyManagedSettings(h.settingsFile, [{ path: ['workbench.colorTheme'], value: 'Another' }]);
		h.emit('workbench.colorTheme');
		await waitFor(() => h.errors.length === 1);
		assert.match(h.errors[0], /simulated User settings failure/);
	} finally {
		await h.dispose();
	}
});

test('theme picker does not open after applying Remote settings fails', async () => {
	const h = await extensionHarness();
	try {
		await waitFor(() => h.state.renders >= 2);
		await fs.writeFile(path.join(path.dirname(h.settingsFile), '.workspace-identity.json'), 'broken');
		await h.command('chooseTheme');
		assert.equal(h.errors.length, 1);
		assert.deepEqual(h.executed, []);
		assert.equal(await readSetting(h.settingsFile, ['workbench.colorTheme']), 'Original');
	} finally {
		await h.dispose();
	}
});
