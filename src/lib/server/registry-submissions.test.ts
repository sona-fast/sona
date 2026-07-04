import { describe, it, expect } from 'vitest';
import { approvedSubmissionGlobalId, artistInCatalog } from './registry-submissions';
import type { RegistryArtist, RegistrySubmission } from './registry';

function sub(partial: Partial<RegistrySubmission>): RegistrySubmission {
	return {
		id: 1,
		kind: 'create',
		targetGlobalId: null,
		payload: JSON.stringify({ displayName: 'Jinho', socials: {} }),
		matchedGlobalId: null,
		status: 'pending',
		reviewerNote: null,
		createdAt: '2026-07-01T00:00:00Z',
		decidedAt: null,
		...partial
	};
}

function catalogEntry(partial: Partial<RegistryArtist>): RegistryArtist {
	return {
		globalId: 'g-jinho',
		displayName: 'Jinho',
		avatarUrl: null,
		bio: null,
		socials: {},
		aliases: [],
		version: 1,
		status: 'active',
		mergedInto: null,
		updatedAt: '2026-07-01T00:00:00Z',
		...partial
	};
}

describe('approvedSubmissionGlobalId', () => {
	it('links an unlinked artist when its create submission is approved', () => {
		const artist = { name: 'Jinho', globalId: null };
		const subs = [sub({ status: 'approved', matchedGlobalId: 'g-jinho' })];
		expect(approvedSubmissionGlobalId(artist, subs)).toBe('g-jinho');
	});

	it('uses targetGlobalId for an approved update submission', () => {
		const artist = { name: 'Jinho', globalId: 'g-jinho' };
		// An update targets an already-linked artist, so nothing new to stamp.
		const subs = [sub({ kind: 'update', targetGlobalId: 'g-jinho', status: 'approved' })];
		expect(approvedSubmissionGlobalId(artist, subs)).toBeNull();
	});

	it('does not link while the submission is still pending', () => {
		const artist = { name: 'Jinho', globalId: null };
		const subs = [sub({ status: 'pending', matchedGlobalId: 'g-jinho' })];
		expect(approvedSubmissionGlobalId(artist, subs)).toBeNull();
	});

	it('does not link a rejected submission', () => {
		const artist = { name: 'Jinho', globalId: null };
		const subs = [sub({ status: 'rejected' })];
		expect(approvedSubmissionGlobalId(artist, subs)).toBeNull();
	});

	it('returns null when no submission matches the artist name', () => {
		const artist = { name: 'Someone Else', globalId: null };
		const subs = [sub({ status: 'approved', matchedGlobalId: 'g-jinho' })];
		expect(approvedSubmissionGlobalId(artist, subs)).toBeNull();
	});

	it('takes the newest (first) matching submission', () => {
		const artist = { name: 'Jinho', globalId: null };
		const subs = [
			sub({ id: 2, status: 'approved', matchedGlobalId: 'g-new' }),
			sub({ id: 1, status: 'rejected' })
		];
		expect(approvedSubmissionGlobalId(artist, subs)).toBe('g-new');
	});
});

describe('artistInCatalog', () => {
	it('matches an unlinked artist to the catalog by display name', () => {
		const artist = { name: 'Jinho', globalId: null };
		expect(artistInCatalog(artist, [catalogEntry({})])).toBe(true);
	});

	it('matches by a shared social handle even when names differ', () => {
		const artist = { name: 'Different Name', globalId: null, twitterUrl: 'https://x.com/jinho' };
		const entry = catalogEntry({ displayName: 'Jinho', socials: { twitterUrl: 'https://twitter.com/jinho' } });
		expect(artistInCatalog(artist, [entry])).toBe(true);
	});

	it('is false for an artist absent from the catalog', () => {
		const artist = { name: 'Nobody', globalId: null };
		expect(artistInCatalog(artist, [catalogEntry({})])).toBe(false);
	});

	it('ignores tombstoned / non-active catalog entries', () => {
		const artist = { name: 'Jinho', globalId: null };
		expect(artistInCatalog(artist, [catalogEntry({ status: 'tombstoned' })])).toBe(false);
	});
});
