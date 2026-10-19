import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoColor, contrastForeground, hslToHex, normalizeHex, withAlpha } from '../colors';

test('normalizeHex accepts 3 and 6 digits, with or without #', () => {
	assert.equal(normalizeHex('#abc'), '#AABBCC');
	assert.equal(normalizeHex('1e6b3a'), '#1E6B3A');
	assert.equal(normalizeHex(' #1E6B3A '), '#1E6B3A');
	assert.equal(normalizeHex('red'), undefined);
	assert.equal(normalizeHex('#12345'), undefined);
});

test('hslToHex hits the primaries', () => {
	assert.equal(hslToHex(0, 1, 0.5), '#FF0000');
	assert.equal(hslToHex(120, 1, 0.5), '#00FF00');
	assert.equal(hslToHex(240, 1, 0.5), '#0000FF');
	assert.equal(hslToHex(0, 0, 1), '#FFFFFF');
});

test('autoColor is stable, case-insensitive and readable with white text', () => {
	assert.equal(autoColor('dev-box'), autoColor('DEV-BOX'));
	assert.notEqual(autoColor('dev-box'), autoColor('prod-db'));
	assert.match(autoColor('dev-box'), /^#[0-9A-F]{6}$/);
	assert.equal(contrastForeground(autoColor('dev-box')), '#FFFFFF');
});

test('contrastForeground picks the readable side', () => {
	assert.equal(contrastForeground('#FFFFFF'), '#000000');
	assert.equal(contrastForeground('#FFE066'), '#000000');
	assert.equal(contrastForeground('#000000'), '#FFFFFF');
	assert.equal(contrastForeground('#8B1A1A'), '#FFFFFF');
});

test('withAlpha appends an alpha byte', () => {
	assert.equal(withAlpha('#8B1A1A', 0.8), '#8B1A1ACC');
	assert.equal(withAlpha('#FFFFFF', 0), '#FFFFFF00');
});
