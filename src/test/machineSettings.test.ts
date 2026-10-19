import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { applyManagedSettings, machineSettingsPath, readSetting } from '../machineSettings';

const CC = 'workbench.colorCustomizations';

async function tempSettings(content?: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-'));
	const file = path.join(dir, 'Machine', 'settings.json');
	if (content !== undefined) {
		await fs.mkdir(path.dirname(file));
		await fs.writeFile(file, content);
	}
	return file;
}

test('machineSettingsPath finds Machine next to the User dir', () => {
	assert.equal(
		machineSettingsPath('/home/lot/.vscode-server/data/User/globalStorage/lotsuid.vscode-workspace-identity'),
		'/home/lot/.vscode-server/data/Machine/settings.json');
	assert.equal(
		machineSettingsPath('/home/lot/.vscode-server/data/User/profiles/abc/globalStorage/x'),
		'/home/lot/.vscode-server/data/Machine/settings.json');
	assert.equal(machineSettingsPath('/tmp/nowhere'), undefined);
});

test('creates the file when missing, and a second run changes nothing', async () => {
	const file = await tempSettings();
	const desired = [{ path: ['workbench.colorTheme'], value: 'Red' }, { path: [CC, 'statusBar.background'], value: '#8B1A1A' }];
	const first = await applyManagedSettings(file, desired);
	assert.equal(first.changed, true);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Red');
	assert.equal(await readSetting(file, [CC, 'statusBar.background']), '#8B1A1A');
	assert.equal((await applyManagedSettings(file, desired)).changed, false);
});

test('keeps comments and unrelated settings, and restores earlier values', async () => {
	const original = [
		'{',
		'\t// my remote tweaks',
		'\t"editor.fontSize": 14,',
		'\t"workbench.colorTheme": "Mine",',
		`\t"${CC}": { "editor.background": "#000000" },`,
		'}',
		'',
	].join('\n');
	const file = await tempSettings(original);
	await applyManagedSettings(file, [{ path: ['workbench.colorTheme'], value: 'Red' }, { path: [CC, 'statusBar.background'], value: '#8B1A1A' }]);
	const applied = await fs.readFile(file, 'utf8');
	assert.match(applied, /\/\/ my remote tweaks/);
	assert.match(applied, /\n\t"workbench\.colorTheme": "Red"/);
	assert.equal(await readSetting(file, [CC, 'editor.background']), '#000000');

	// Nothing wanted any more: the theme goes back to "Mine" and the added color goes away.
	const result = await applyManagedSettings(file, []);
	assert.equal(result.restored.length, 2);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Mine');
	assert.deepEqual(await readSetting(file, [CC]), { 'editor.background': '#000000' });
	assert.match(await fs.readFile(file, 'utf8'), /\/\/ my remote tweaks/);
});

test('drops an object it emptied, and leaves no state behind for managed paths', async () => {
	const file = await tempSettings('{}');
	await applyManagedSettings(file, [{ path: [CC, 'titleBar.activeBackground'], value: '#123456' }]);
	await applyManagedSettings(file, []);
	assert.deepEqual(await readSetting(file, []), {});
	const state = JSON.parse(await fs.readFile(path.join(path.dirname(file), '.workspace-identity.json'), 'utf8'));
	assert.deepEqual(state.managed, {});
});

test('refuses to touch a file with JSON errors', async () => {
	const broken = '{ "editor.fontSize": 14 ';
	const file = await tempSettings(broken);
	await assert.rejects(applyManagedSettings(file, [{ path: ['workbench.colorTheme'], value: 'Red' }]), /not valid JSON/);
	assert.equal(await fs.readFile(file, 'utf8'), broken);
});

test('follows the file\'s indentation', async () => {
	const file = await tempSettings('{\n  "editor.fontSize": 14\n}\n');
	await applyManagedSettings(file, [{ path: ['workbench.colorTheme'], value: 'Red' }]);
	assert.match(await fs.readFile(file, 'utf8'), /\n {2}"workbench\.colorTheme": "Red"/);
});

test('concurrent windows end up with one consistent result', async () => {
	const file = await tempSettings('{ "editor.fontSize": 14 }');
	const desired = [{ path: ['workbench.colorTheme'], value: 'Red' }];
	await Promise.all([1, 2, 3, 4].map(() => applyManagedSettings(file, desired)));
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Red');
	await applyManagedSettings(file, []);
	assert.deepEqual(await readSetting(file, []), { 'editor.fontSize': 14 });
});

test('rejects damaged recovery data without overwriting settings or state', async () => {
	for (const content of [
		'', '{', '{"version":2,"managed":{}}', '{"version":1}',
		JSON.stringify({ version: 1, managed: { bad: { path: [], hadPrevious: false } } }),
		JSON.stringify({ version: 1, managed: { '["x"]': { path: ['y'], hadPrevious: true, previous: 1 } } }),
		JSON.stringify({ version: 1, managed: { '["x"]': { path: ['x'], hadPrevious: true } } }),
		JSON.stringify({ version: 1, managed: { '["__proto__"]': { path: ['__proto__'], hadPrevious: false } } }),
	]) {
		const file = await tempSettings('{"keep":1}');
		const stateFile = path.join(path.dirname(file), '.workspace-identity.json');
		await fs.writeFile(stateFile, content);
		await assert.rejects(applyManagedSettings(file, []), /recovery data/);
		assert.equal(await fs.readFile(file, 'utf8'), '{"keep":1}');
		assert.equal(await fs.readFile(stateFile, 'utf8'), content);
	}
});

test('failed cleanup keeps the backup so another window can retry', async t => {
	const file = await tempSettings('{"workbench.colorTheme":"Original"}');
	await applyManagedSettings(file, [{ path: ['workbench.colorTheme'], value: 'Managed' }]);
	const rename = fs.rename;
	const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
		if (args[1] === file) {
			throw new Error('simulated settings write failure');
		}
		return rename(...args);
	});
	await assert.rejects(applyManagedSettings(file, []), /simulated/);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Managed');
	mock.mock.restore();
	await applyManagedSettings(file, []);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Original');
});

test('failed initial apply keeps the original value recoverable', async t => {
	const file = await tempSettings('{"workbench.colorTheme":"Original"}');
	const rename = fs.rename;
	const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
		if (args[1] === file) {
			throw new Error('simulated failure');
		}
		return rename(...args);
	});
	const desired = [{ path: ['workbench.colorTheme'], value: 'Managed' }];
	await assert.rejects(applyManagedSettings(file, desired), /simulated/);
	mock.mock.restore();
	await applyManagedSettings(file, desired);
	await applyManagedSettings(file, []);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Original');
});

test('cleanup can recover after settings were restored but pruning state failed', async t => {
	const file = await tempSettings('{"workbench.colorTheme":"Original"}');
	await applyManagedSettings(file, [{ path: ['workbench.colorTheme'], value: 'Managed' }]);
	const rename = fs.rename;
	const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
		if (String(args[1]).endsWith('.workspace-identity.json')) {
			throw new Error('simulated state write failure');
		}
		return rename(...args);
	});
	await assert.rejects(applyManagedSettings(file, []), /simulated/);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Original');
	mock.mock.restore();
	await applyManagedSettings(file, []);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Original');
});

test('detects edits made outside the extension lock before replacing settings', async t => {
	const file = await tempSettings('{}');
	const rename = fs.rename;
	const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
		await rename(...args);
		if (String(args[1]).endsWith('.workspace-identity.json')) {
			await fs.writeFile(file, '{"editor.fontSize":17}');
		}
	});
	await assert.rejects(applyManagedSettings(file, [{ path: ['workbench.colorTheme'], value: 'Managed' }]), /changed while applying/);
	assert.deepEqual(await readSetting(file, []), { 'editor.fontSize': 17 });
	mock.mock.restore();
});

test('preserves empty existing color objects, and removes extension-created ones after new colors are added', async () => {
	for (const existing of [false, true]) {
		const file = await tempSettings(existing ? JSON.stringify({ [CC]: {} }) : '{}');
		const first = { path: [CC, 'statusBar.background'], value: '#123456' };
		const second = { path: [CC, 'titleBar.activeBackground'], value: '#654321' };
		await applyManagedSettings(file, [first]);
		await applyManagedSettings(file, [first, second]);
		await applyManagedSettings(file, []);
		assert.deepEqual(await readSetting(file, []), existing ? { [CC]: {} } : {});
	}
});

test('refuses to replace a scalar color container', async () => {
	const original = JSON.stringify({ [CC]: null });
	const file = await tempSettings(original);
	await assert.rejects(applyManagedSettings(file, [{ path: [CC, 'statusBar.background'], value: '#123456' }]), /parent is not an object/);
	assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('atomic writes preserve settings symlinks and permissions and keep recovery data private', async () => {
	const file = await tempSettings('{"workbench.colorTheme":"Original"}');
	const target = file + '.dotfile';
	await fs.rename(file, target);
	await fs.chmod(target, 0o640);
	await fs.symlink(target, file);
	await applyManagedSettings(file, [{ path: ['workbench.colorTheme'], value: 'Managed' }]);
	assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
	assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
	assert.equal((await fs.stat(path.join(path.dirname(file), '.workspace-identity.json'))).mode & 0o777, 0o600);
	await applyManagedSettings(file, []);
	assert.equal(await readSetting(file, ['workbench.colorTheme']), 'Original');
	assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['.workspace-identity.json', 'settings.json', 'settings.json.dotfile']);
});

test('tightens permissions on existing recovery data even for an unchanged identity', async () => {
	const file = await tempSettings('{}');
	const desired = [{ path: ['workbench.colorTheme'], value: 'Managed' }];
	await applyManagedSettings(file, desired);
	const stateFile = path.join(path.dirname(file), '.workspace-identity.json');
	await fs.chmod(stateFile, 0o644);
	assert.equal((await applyManagedSettings(file, desired)).changed, false);
	assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
});
