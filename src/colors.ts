const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Returns `#RRGGBB` in upper case, or undefined when `input` is not a 3- or 6-digit hex color. */
export function normalizeHex(input: string): string | undefined {
	const match = HEX_RE.exec(input.trim());
	if (!match) {
		return undefined;
	}
	const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
	return '#' + hex.toUpperCase();
}

/** `h` in degrees, `s` and `l` in [0, 1]. */
export function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
	};
	const byte = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
	return ('#' + byte(f(0)) + byte(f(8)) + byte(f(4))).toUpperCase();
}

/** FNV-1a, 32 bit. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** A stable color for `seed`, dark enough that white text on it meets WCAG AA (4.5:1). */
export function autoColor(seed: string): string {
	const hue = hash(seed.toLowerCase()) % 360;
	// Yellows and greens look much lighter than blues at the same HSL lightness, so darken until white reads well.
	for (let lightness = 0.32; ; lightness -= 0.02) {
		const hex = hslToHex(hue, 0.55, lightness);
		if (relativeLuminance(hex) <= 1.05 / 4.5 - 0.05 || lightness <= 0.1) {
			return hex;
		}
	}
}

function linear(channel: number): number {
	const v = channel / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#RRGGBB` color. */
export function relativeLuminance(hex: string): number {
	const n = parseInt(hex.slice(1, 7), 16);
	return 0.2126 * linear((n >> 16) & 0xff) + 0.7152 * linear((n >> 8) & 0xff) + 0.0722 * linear(n & 0xff);
}

/** Black or white, whichever contrasts more with `background` (`#RRGGBB`). */
export function contrastForeground(background: string): string {
	const l = relativeLuminance(background);
	return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
}

/** `#RRGGBB` plus an alpha byte. */
export function withAlpha(hex: string, alpha: number): string {
	const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
	return hex.slice(0, 7) + a.toString(16).padStart(2, '0').toUpperCase();
}
