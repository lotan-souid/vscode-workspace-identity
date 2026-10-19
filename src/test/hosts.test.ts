import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
	DEFAULT_COLORIZE,
	DEFAULT_WINDOW_TITLE,
	desiredSettings,
	findHostConfig,
	HostInfo,
	hostNames,
	resolveIdentity,
	sshServerAddress,
} from '../hosts';

const host = (hostname: string, addresses: string[] = []): HostInfo => ({ remoteName: 'ssh-remote', addresses, hostname, user: 'lot' });

test('sshServerAddress takes the server side of SSH_CONNECTION', () => {
	assert.equal(sshServerAddress('192.168.0.198 51209 192.168.0.146 22'), '192.168.0.146');
	assert.equal(sshServerAddress('fe80::1 51209 fe80::2 22\n'), 'fe80::2');
	assert.equal(sshServerAddress(undefined), undefined);
	assert.equal(sshServerAddress('garbage'), undefined);
});

test('hostNames covers the hostname, its first label and the addresses', () => {
	assert.deepEqual(hostNames(host('ip-10-0-0-5.ec2.internal', ['10.0.0.5'])), ['ip-10-0-0-5.ec2.internal', 'ip-10-0-0-5', '10.0.0.5']);
	assert.deepEqual(hostNames(host('box')), ['box']);
});

test('findHostConfig: exact beats pattern, first pattern wins, case-insensitive', () => {
	const hosts = { 'prod-*': { label: 'any prod' }, 'PROD-DB': { label: 'db' }, 'prod-d?': { label: 'second pattern' } };
	assert.equal(findHostConfig(hosts, ['prod-db'])?.config.label, 'db');
	assert.equal(findHostConfig(hosts, ['prod-dx'])?.rule, 'prod-*');
	assert.equal(findHostConfig(hosts, ['dev'])?.rule, undefined);
	assert.equal(findHostConfig({ 'dev': 'oops' as never }, ['dev']), undefined);
});

test('resolveIdentity falls back to an automatic identity only when autoColor is on', () => {
	assert.equal(resolveIdentity(host('dev-box'), {}, false), undefined);
	const auto = resolveIdentity(host('dev-box'), {}, true);
	assert.equal(auto?.label, 'dev-box');
	assert.equal(auto?.rule, undefined);
	assert.match(auto?.color ?? '', /^#[0-9A-F]{6}$/);
});

test('resolveIdentity applies the matching entry, also by address', () => {
	const hosts = { 'prod-*': { label: ' PROD ', emoji: '🔴', color: '#8b1a1a', theme: 'Red' } };
	assert.deepEqual(resolveIdentity(host('prod-db'), hosts, true),
		{ key: 'prod-db', label: 'PROD', emoji: '🔴', color: '#8B1A1A', theme: 'Red', settings: {}, rule: 'prod-*' });
	assert.equal(resolveIdentity(host('vm-ubuntu-01', ['192.168.0.146']), { '192.168.0.146': { label: 'VM' } }, false)?.label, 'VM');
});

test('a host with its own theme keeps the theme\'s colors unless a color is set', () => {
	assert.equal(resolveIdentity(host('dev'), { dev: { theme: 'Monokai' } }, true)?.color, undefined);
	assert.equal(resolveIdentity(host('dev'), { dev: { theme: 'Monokai', color: '#1E6B3A' } }, true)?.color, '#1E6B3A');
	assert.equal(resolveIdentity(host('dev'), { dev: { color: 'none' } }, true)?.color, undefined);
	assert.match(resolveIdentity(host('dev'), { dev: { label: 'DEV' } }, true)?.color ?? '', /^#[0-9A-F]{6}$/);
});

test('desiredSettings writes theme, per-key colors and the title', () => {
	const id = resolveIdentity(host('prod-db'), { 'prod-db': { label: 'PROD', emoji: '🔴', color: '#8B1A1A', theme: 'Red' } }, false)!;
	const desired = new Map(desiredSettings(id, { colorize: ['statusBar'], windowTitle: '${identity} · ${rootName}' }).map(d => [d.path.join(' > '), d.value]));
	assert.deepEqual(Object.fromEntries(desired), {
		'workbench.colorTheme': 'Red',
		'workbench.colorCustomizations > statusBar.background': '#8B1A1A',
		'workbench.colorCustomizations > statusBar.foreground': '#FFFFFF',
		'window.title': '🔴 PROD · ${rootName}',
	});
});

test('desiredSettings flattens extra colors and lets identity fields win', () => {
	const id = resolveIdentity(host('dev'), {
		dev: {
			theme: 'Light',
			color: 'none',
			settings: {
				'editor.fontSize': 15,
				'workbench.colorTheme': 'Dark',
				'workbench.colorCustomizations': { 'editor.background': '#101010' },
			},
		},
	}, true)!;
	const desired = desiredSettings(id, { colorize: DEFAULT_COLORIZE, windowTitle: '' });
	assert.deepEqual(desired, [
		{ path: ['editor.fontSize'], value: 15 },
		{ path: ['workbench.colorTheme'], value: 'Light' },
		{ path: ['workbench.colorCustomizations', 'editor.background'], value: '#101010' },
	]);
});

test('package.json defaults match the code', () => {
	const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
	const props = pkg.contributes.configuration.properties;
	assert.equal(props['workspaceIdentity.windowTitle'].default, DEFAULT_WINDOW_TITLE);
	assert.deepEqual(props['workspaceIdentity.colorize'].default, DEFAULT_COLORIZE);
});
