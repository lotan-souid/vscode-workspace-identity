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
