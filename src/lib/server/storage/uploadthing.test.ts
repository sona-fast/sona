import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UploadThingStorage } from './uploadthing';
import { ZeroKeepError } from './types';

// Stub UTApi at the module boundary — UploadThingStorage constructs its own
// instance, so the class itself is replaced with one exposing our mocks.
const { listFiles, deleteFiles } = vi.hoisted(() => ({
	listFiles: vi.fn(),
	deleteFiles: vi.fn(async () => ({ success: true, deletedCount: 0 }))
}));
vi.mock('uploadthing/server', () => ({
	UTApi: class {
		listFiles = listFiles;
		deleteFiles = deleteFiles;
	}
}));

const HOUR = 60 * 60 * 1000;

describe('UploadThing deleteOrphans', () => {
	beforeEach(() => {
		listFiles.mockReset();
		deleteFiles.mockClear();
		// Real listFiles shape: { files: [{ key, uploadedAt: <epoch millis> }] }.
		listFiles.mockResolvedValue({
			files: [
				{ key: 'referenced-key', uploadedAt: Date.now() - 100 * HOUR },
				{ key: 'old-orphan-key', uploadedAt: Date.now() - 100 * HOUR },
				{ key: 'fresh-orphan-key', uploadedAt: Date.now() }
			]
		});
	});

	it('deletes only orphans older than the gate; referenced and fresh files survive', async () => {
		const storage = new UploadThingStorage({ token: 'test-token' });
		const deleted = await storage.deleteOrphans(['https://app123.ufs.sh/f/referenced-key'], {
			olderThan: new Date(Date.now() - 48 * HOUR)
		});
		expect(deleted).toBe(1);
		expect(deleteFiles).toHaveBeenCalledTimes(1);
		expect(deleteFiles).toHaveBeenCalledWith(['old-orphan-key']);
	});

	it('dryRun reports the count without deleting', async () => {
		const storage = new UploadThingStorage({ token: 'test-token' });
		const count = await storage.deleteOrphans(['https://app123.ufs.sh/f/referenced-key'], {
			olderThan: new Date(Date.now() - 48 * HOUR),
			dryRun: true
		});
		expect(count).toBe(1);
		expect(deleteFiles).not.toHaveBeenCalled();
	});

	it('abortOnEmptyKeepSet refuses to sweep when no reference maps to a key', async () => {
		const storage = new UploadThingStorage({ token: 'test-token' });
		await expect(
			storage.deleteOrphans(['https://twitter.com/someone'], { abortOnEmptyKeepSet: true })
		).rejects.toBeInstanceOf(ZeroKeepError);
		expect(deleteFiles).not.toHaveBeenCalled();
	});
});
