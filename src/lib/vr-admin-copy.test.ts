import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// VR admin copy pins: the too-large error must advise removing UNUSED
// blendshapes (never "strip them" wholesale — that would delete the VRM's
// expressions and visemes), and the downloadable hint must keep its honesty
// clause: for VRM the viewer fetches the same file, so the toggle only hides
// the button. The model-format hint is pinned here too, in both locales;
// the rendered EN string is additionally asserted in
// tests/e2e/vr-admin-form.spec.ts.
function messages(locale: string): Record<string, string> {
	const path = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
	return JSON.parse(readFileSync(path, 'utf8'));
}

describe('VR too-large error copy', () => {
	const en = messages('en');
	const ja = messages('ja');

	it('en blames blendshapes and advises removing only unused ones', () => {
		expect(en.admin_vr_error_too_large).toContain('Blendshapes');
		expect(en.admin_vr_error_too_large).toContain("Remove the blendshapes you aren't using");
		expect(en.admin_vr_error_too_large).not.toContain('reducing texture sizes');
	});

	it('ja blames ブレンドシェイプ and never suggests shrinking textures', () => {
		expect(ja.admin_vr_error_too_large).toContain('使っていないブレンドシェイプ');
		expect(ja.admin_vr_error_too_large).not.toContain('テクスチャサイズを下げ');
	});

	it('both locales keep the {size} and {max} placeholders', () => {
		for (const msg of [en.admin_vr_error_too_large, ja.admin_vr_error_too_large]) {
			expect(msg).toContain('{size}');
			expect(msg).toContain('{max}');
		}
	});
});

describe('VR downloadable-switch hint copy', () => {
	it('keeps the honesty clause: hiding the button does not prevent access', () => {
		expect(messages('en').admin_vr_downloadable_hint).toContain('without preventing access');
		expect(messages('ja').admin_vr_downloadable_hint).toContain('アクセスは防げません');
	});
});

describe('VR model-format hint copy', () => {
	it('en names both VRM versions and keeps the FBX viewer caveat', () => {
		const hint = messages('en').admin_vr_model_hint;
		expect(hint).toContain('VRM 0.x and 1.0');
		expect(hint).toContain("viewer won't display them");
	});

	it('ja names the VRM versions and keeps the FBX viewer caveat', () => {
		const hint = messages('ja').admin_vr_model_hint;
		expect(hint).toContain('VRM 0.x');
		expect(hint).toContain('1.0');
		expect(hint).toContain('ビューアには表示されません');
	});
});
