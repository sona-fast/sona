import type { FursuitPhoto } from './types';
import { LICENSES } from './license';

// Mock fursuit photos for local dev / preview (FURTRACK_MODE=mock).
// These let us build and demo the UI WITHOUT ever calling FurTrack. Only
// displayable (CC / Public Domain) licenses appear here, mirroring what the
// live path is allowed to return. Image URLs are placeholders.
export const MOCK_PHOTOS: FursuitPhoto[] = [
	{
		id: 1926975,
		furtrackUrl: 'https://www.furtrack.com/p/1926975',
		imageUrl: 'https://placehold.co/900x1200/17121c/f5a623?text=Fursuit+Photo',
		width: 2864,
		height: 4088,
		photographer: 'GraphFox Photography',
		photographerUrl: 'https://www.furtrack.com/user/graphfox',
		event: 'FWA 2026',
		character: 'sparky',
		tags: ['fox', 'fursuit'],
		takenAt: '2026-03-21',
		license: LICENSES['cc-by-nc-nd']
	},
	{
		id: 1918883,
		furtrackUrl: 'https://www.furtrack.com/p/1918883',
		imageUrl: 'https://placehold.co/1200x900/17121c/f5a623?text=Fursuit+Photo',
		width: 4000,
		height: 3000,
		photographer: 'Critter Lens',
		photographerUrl: 'https://www.furtrack.com/user/critterlens',
		event: 'MFF 2025',
		character: 'sparky',
		tags: ['fox', 'fursuit', 'dance'],
		takenAt: '2025-12-04',
		license: LICENSES['cc-by']
	},
	{
		id: 1918882,
		furtrackUrl: 'https://www.furtrack.com/p/1918882',
		imageUrl: 'https://placehold.co/1000x1000/17121c/f5a623?text=Fursuit+Photo',
		width: 3000,
		height: 3000,
		photographer: 'PawPrint Studios',
		photographerUrl: 'https://www.furtrack.com/user/pawprint',
		event: 'Anthrocon 2025',
		character: 'sparky',
		tags: ['fox', 'fursuit', 'portrait'],
		takenAt: '2025-07-05',
		license: LICENSES['cc-by-nc']
	},
	{
		id: 1918881,
		furtrackUrl: 'https://www.furtrack.com/p/1918881',
		imageUrl: 'https://placehold.co/1200x800/17121c/f5a623?text=Fursuit+Photo',
		width: 4500,
		height: 3000,
		photographer: 'WildRuffer',
		photographerUrl: 'https://www.furtrack.com/user/wildruffer',
		event: 'FWA 2026',
		character: 'sparky',
		tags: ['fox', 'fursuit', 'outdoor'],
		takenAt: '2026-03-22',
		license: LICENSES['public-domain']
	},
	{
		id: 1918880,
		furtrackUrl: 'https://www.furtrack.com/p/1918880',
		imageUrl: 'https://placehold.co/900x1200/17121c/f5a623?text=Fursuit+Photo',
		width: 2800,
		height: 3700,
		photographer: 'NocVision Media',
		photographerUrl: 'https://www.furtrack.com/user/nocvision',
		event: 'MFF 2025',
		character: 'sparky',
		tags: ['fox', 'fursuit', 'lowlight'],
		takenAt: '2025-12-06',
		license: LICENSES['cc-by-nd']
	},
	// Non-displayable licenses — excluded from public display, shown as "excluded"
	// in the admin import review so that path is exercised in dev.
	{
		id: 1918879,
		furtrackUrl: 'https://www.furtrack.com/p/1918879',
		imageUrl: 'https://placehold.co/1000x1000/17121c/888?text=All+Rights+Reserved',
		width: 3000,
		height: 3000,
		photographer: 'StudioLumen',
		photographerUrl: 'https://www.furtrack.com/user/studiolumen',
		event: 'FWA 2026',
		character: 'sparky',
		tags: ['fox', 'fursuit'],
		takenAt: '2026-03-22',
		license: LICENSES['all-rights-reserved']
	},
	{
		id: 1918878,
		furtrackUrl: 'https://www.furtrack.com/p/1918878',
		imageUrl: 'https://placehold.co/1000x1000/17121c/888?text=Unspecified',
		width: 2600,
		height: 3400,
		photographer: 'Anon Shutterpup',
		photographerUrl: 'https://www.furtrack.com/user/anonshutterpup',
		event: 'MFF 2025',
		character: 'sparky',
		tags: ['fox', 'fursuit'],
		takenAt: '2025-12-05',
		license: LICENSES['photographer-discretion']
	}
];
