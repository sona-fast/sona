import { describe, it, expect } from 'vitest';
import { dropFiles, matchesAccept } from './drop-files';

// The accept filter is the security-relevant half (SONA-216): the accept
// ATTRIBUTE only constrains the file picker, so without this an admin dropping
// a .txt on a zone would POST it to /api/upload.
describe('matchesAccept', () => {
	const f = (name: string, type = '') => ({ name, type });

	it('matches extensions case-insensitively', () => {
		expect(matchesAccept(f('avatar.vrm'), '.vrm,.fbx')).toBe(true);
		expect(matchesAccept(f('AVATAR.VRM'), '.vrm,.fbx')).toBe(true);
		expect(matchesAccept(f('avatar.fbx'), '.VRM,.FBX')).toBe(true);
		expect(matchesAccept(f('notes.txt'), '.vrm,.fbx')).toBe(false);
		// The extension must be at the END, not anywhere in the name.
		expect(matchesAccept(f('vrm.txt'), '.vrm')).toBe(false);
	});

	it('matches exact MIME types', () => {
		expect(matchesAccept(f('a.png', 'image/png'), 'image/png,image/webp')).toBe(true);
		expect(matchesAccept(f('a.gif', 'image/gif'), 'image/png,image/webp')).toBe(false);
		// A file the OS gave no type is not an exact-MIME match.
		expect(matchesAccept(f('a.png'), 'image/png')).toBe(false);
	});

	it('matches wildcard MIME types', () => {
		expect(matchesAccept(f('a.avif', 'image/avif'), 'image/*')).toBe(true);
		expect(matchesAccept(f('a.webm', 'video/webm'), 'image/*')).toBe(false);
		expect(matchesAccept(f('a.webm', 'video/webm'), 'image/*,video/*')).toBe(true);
	});

	it('tolerates spaces around the comma list', () => {
		expect(matchesAccept(f('a.webm', 'video/webm'), 'image/png, video/webm')).toBe(true);
		expect(matchesAccept(f('a.fbx'), '.vrm, .fbx')).toBe(true);
	});

	it('accepts everything when accept is empty', () => {
		expect(matchesAccept(f('notes.txt', 'text/plain'), '')).toBe(true);
		expect(matchesAccept(f('notes.txt', 'text/plain'), '  ,  ')).toBe(true);
	});
});

// No jsdom in this repo (environment: 'node'), so the attachment runs against a
// hand-rolled element: EventTarget gives real listener semantics, and classList
// only needs add/remove/contains.
class FakeEl extends EventTarget {
	classes = new Set<string>();
	classList = {
		add: (c: string) => this.classes.add(c),
		remove: (c: string) => this.classes.delete(c),
		contains: (c: string) => this.classes.has(c)
	};
}

type PickedFile = { name: string; type: string };

function dragEvent(type: string, files: PickedFile[] = []) {
	return Object.assign(new Event(type), { dataTransfer: { files, dropEffect: '' } });
}

describe('dropFiles', () => {
	function setup(disabled?: () => boolean) {
		const el = new FakeEl();
		const calls: { files: PickedFile[]; rejected: PickedFile[] }[] = [];
		const attach = dropFiles({
			accept: 'image/png,.vrm',
			onFiles: (files, rejected) =>
				calls.push({ files: files as unknown as PickedFile[], rejected: rejected as unknown as PickedFile[] }),
			disabled
		});
		const cleanup = attach(el as unknown as HTMLElement);
		return { el, calls, cleanup };
	}

	it('toggles drag-over on dragover and clears it on dragleave', () => {
		const { el } = setup();
		el.dispatchEvent(dragEvent('dragover'));
		expect(el.classes.has('drag-over')).toBe(true);
		el.dispatchEvent(dragEvent('dragleave'));
		expect(el.classes.has('drag-over')).toBe(false);
	});

	it('sets the copy drop effect so the cursor reads as an upload', () => {
		const { el } = setup();
		const ev = dragEvent('dragover');
		el.dispatchEvent(ev);
		expect(ev.dataTransfer.dropEffect).toBe('copy');
	});

	it('partitions dropped files and clears the highlight', () => {
		const { el, calls } = setup();
		el.dispatchEvent(dragEvent('dragenter'));
		expect(el.classes.has('drag-over')).toBe(true);
		const good = { name: 'a.png', type: 'image/png' };
		const model = { name: 'b.vrm', type: '' };
		const bad = { name: 'notes.txt', type: 'text/plain' };
		el.dispatchEvent(dragEvent('drop', [good, bad, model]));
		expect(el.classes.has('drag-over')).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0].files).toEqual([good, model]);
		expect(calls[0].rejected).toEqual([bad]);
	});

	it('ignores an empty drop', () => {
		const { el, calls } = setup();
		el.dispatchEvent(dragEvent('drop', []));
		expect(calls).toHaveLength(0);
	});

	it('suppresses the highlight and the drop while disabled', () => {
		const { el, calls } = setup(() => true);
		const ev = dragEvent('dragover');
		el.dispatchEvent(ev);
		expect(el.classes.has('drag-over')).toBe(false);
		expect(ev.dataTransfer.dropEffect).toBe('none');
		el.dispatchEvent(dragEvent('drop', [{ name: 'a.png', type: 'image/png' }]));
		expect(calls).toHaveLength(0);
	});

	it('leaves an event a nested target already handled alone', () => {
		const { el, calls } = setup(() => true);
		const over = Object.assign(new Event('dragover', { cancelable: true }), {
			dataTransfer: { files: [], dropEffect: 'copy' }
		});
		over.preventDefault();
		el.dispatchEvent(over);
		// A disabled instance would have set 'none'; the inner target's 'copy' stays.
		expect(over.dataTransfer.dropEffect).toBe('copy');
		const drop = Object.assign(new Event('drop', { cancelable: true }), {
			dataTransfer: { files: [{ name: 'a.png', type: 'image/png' }], dropEffect: '' }
		});
		drop.preventDefault();
		el.dispatchEvent(drop);
		expect(calls).toHaveLength(0);
	});

	it('removes its listeners on cleanup', () => {
		const { el, calls, cleanup } = setup();
		cleanup?.();
		el.dispatchEvent(dragEvent('dragover'));
		el.dispatchEvent(dragEvent('drop', [{ name: 'a.png', type: 'image/png' }]));
		expect(el.classes.has('drag-over')).toBe(false);
		expect(calls).toHaveLength(0);
	});
});
