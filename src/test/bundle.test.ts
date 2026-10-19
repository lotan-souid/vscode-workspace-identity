import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// The unit tests import the sources, which resolve dependencies from node_modules. The shipped bundle
// has no node_modules next to it, so load it the way VS Code does, with only `vscode` provided.
test('the bundle loads on its own', async () => {
	const bundle = path.join(__dirname, '..', '..', 'dist', 'extension.js');
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wsi-bundle-'));
	await fs.mkdir(path.join(dir, 'dist'));
	await fs.mkdir(path.join(dir, 'node_modules', 'vscode'), { recursive: true });
	await fs.copyFile(bundle, path.join(dir, 'dist', 'extension.js'));
	await fs.writeFile(path.join(dir, 'node_modules', 'vscode', 'index.js'), 'module.exports = {};\n');

	const extension = require(path.join(dir, 'dist', 'extension.js'));
	assert.equal(typeof extension.activate, 'function');
	assert.equal(typeof extension.deactivate, 'function');
});
