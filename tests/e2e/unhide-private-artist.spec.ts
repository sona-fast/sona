import { test, expect, type Page } from '@playwright/test';
import { gotoAfterLogin, gotoRetrying, loginRetrying, waitForHydration } from './admin-login';
import { dropOn, waitForDropAttachment } from './drop-files';

// The "Make a private artist public?" step on every form that can give a Keep
// private artist public work (SONA-236). The server refuses the first save with
// a 409 naming the artists; the page shows the dialog, Cancel changes nothing
// and keeps what the operator typed, and Make public resubmits the same form
// once with confirmUnhide=1, which saves and unticks Keep private. The unit
// suite covers each action; only a browser proves the enhance callbacks, the
// dialog, and the resubmit line up. The images list toggle has its own test in
// share-private-artist.spec.ts.
//
// Runs on the registry-sync project (playwright.config.ts), beside
// share-private-artist: the specs on that server already write artists and
// pieces, and its one worker keeps these saves from racing anything else.

// Matches ADMIN_PASSWORD in tests/e2e/wrangler.e2e-registry.toml (throwaway value).
const PASSWORD = 'e2e-admin-password';
const DIALOG = 'Make a private artist public?';

// A Keep private artist with a unique name, so a rerun against a reused DB
// still finds one row. No socials, so nothing is looked up.
async function privateArtist(page: Page, label: string) {
	const name = `${label} ${Date.now()}`;
	const created = await page.request.post('/api/artists', { data: { name, ledgerPrivate: true } });
	expect(created.ok()).toBe(true);
	const { id } = (await created.json()) as { id: number };
	return { id, name };
}

// True while /admin/artists still tags the artist private.
async function expectPrivateTag(page: Page, name: string, shown: boolean) {
	await gotoRetrying(page, `/admin/artists?q=${encodeURIComponent(name)}`);
	const row = page.getByRole('row').filter({ hasText: name });
	await expect(row).toHaveCount(1);
	await expect(row.getByText('private', { exact: true })).toHaveCount(shown ? 1 : 0);
}

// The table rows of /admin/images carrying `title`, newest first. The phone
// layout repeats each piece in a card list below the table.
function imageRows(page: Page, title: string) {
	return page.getByRole('table').getByRole('row').filter({ hasText: title });
}

test('the image edit page asks before publishing, keeps the edits on Cancel, and saves on Make public', async ({
	page,
	baseURL
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const artist = await privateArtist(page, 'Edit Page Artist');

	// An unpublished piece by them, through the upload action ("published" is
	// the form's Private box).
	const title = `Edit Unhide ${Date.now()}`;
	const upload = await page.request.post('/admin/upload', {
		form: { title, artistId: String(artist.id), count: '1', imageUrl_0: '/x1.png', published: 'on' },
		headers: { origin: baseURL! },
		maxRedirects: 0
	});
	expect(upload.status()).toBeLessThan(400);

	await gotoAfterLogin(page, '/admin/images?sort=uploaded&dir=desc');
	const href = await imageRows(page, title).getByRole('link', { name: 'Edit image' }).getAttribute('href');
	await gotoRetrying(page, href!);
	await waitForHydration(page);

	const titleField = page.locator('input[name="title"]');
	const privateBox = page.getByRole('checkbox', { name: /^Private/ });
	const featuredBox = page.getByRole('checkbox', { name: 'Featured on the art page' });
	const orderField = page.locator('input[name="featuredOrder"]');
	const save = page.getByRole('button', { name: 'Save Changes' });
	const dialog = page.getByRole('dialog', { name: DIALOG });
	const renamed = `${title} renamed`;

	// Edits beside the publish, so Cancel has something to lose and Make public
	// something to save.
	await titleField.fill(renamed);
	await featuredBox.check();
	await orderField.fill('7');
	await privateBox.uncheck();
	await save.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(artist.name);
	await page.screenshot({ path: testInfo.outputPath('edit-dialog.png') });

	// Cancel: still on the edit page, with every edit as typed.
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page).toHaveURL(new RegExp(`${href}$`));
	await expect(titleField).toHaveValue(renamed);
	await expect(featuredBox).toBeChecked();
	await expect(orderField).toHaveValue('7');
	await expect(privateBox).not.toBeChecked();
	await expect(save).toBeEnabled();
	await expectPrivateTag(page, artist.name, true);
	await gotoRetrying(page, href!);
	await waitForHydration(page);
	await expect(titleField).toHaveValue(title);
	await expect(privateBox).toBeChecked();

	// Make public: one save, with the edits, and the artist is public.
	await titleField.fill(renamed);
	await featuredBox.check();
	await orderField.fill('7');
	await privateBox.uncheck();
	await save.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(page).toHaveURL(/\/admin\/images$/);
	await gotoRetrying(page, '/admin/images?sort=uploaded&dir=desc');
	const row = imageRows(page, renamed);
	await expect(row).toHaveCount(1);
	await expect(row.getByRole('button', { name: 'Make private' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('edit-saved.png') });

	await gotoRetrying(page, href!);
	await expect(titleField).toHaveValue(renamed);
	await expect(featuredBox).toBeChecked();
	await expect(orderField).toHaveValue('7');
	await expect(privateBox).not.toBeChecked();
	await expectPrivateTag(page, artist.name, false);
});

// The focus half of the dialog, on the page where the Save button is disabled
// while the request is out: focus moves into the dialog, Escape closes it and
// saves nothing, and focus goes back to the button that submitted.
test('the dialog takes focus, Escape cancels, and focus returns to Save', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const artist = await privateArtist(page, 'Focus Artist');
	const title = `Focus Unhide ${Date.now()}`;
	const upload = await page.request.post('/admin/upload', {
		form: { title, artistId: String(artist.id), count: '1', imageUrl_0: '/x1.png', published: 'on' },
		headers: { origin: baseURL! },
		maxRedirects: 0
	});
	expect(upload.status()).toBeLessThan(400);

	await gotoAfterLogin(page, '/admin/images?sort=uploaded&dir=desc');
	const href = await imageRows(page, title).getByRole('link', { name: 'Edit image' }).getAttribute('href');
	await gotoRetrying(page, href!);
	await waitForHydration(page);

	const save = page.getByRole('button', { name: 'Save Changes' });
	const dialog = page.getByRole('dialog', { name: DIALOG });
	await page.getByRole('checkbox', { name: /^Private/ }).uncheck();
	await save.focus();
	await page.keyboard.press('Enter');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('focus-dialog.png') });
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(save).toBeFocused();
	await expect(page).toHaveURL(new RegExp(`${href}$`));
	await expectPrivateTag(page, artist.name, true);
});

// In Japanese the dialog reads in Japanese, names the artist, and its buttons
// are the Japanese labels. The images list toggle is the shortest way there.
test('the dialog reads in Japanese', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	await page.context().addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'ja', domain: 'localhost', path: '/' }]);
	const artist = await privateArtist(page, 'Japanese Artist');
	const title = `Japanese Unhide ${Date.now()}`;
	const upload = await page.request.post('/admin/upload', {
		form: { title, artistId: String(artist.id), count: '1', imageUrl_0: '/x1.png', published: 'on' },
		headers: { origin: baseURL! },
		maxRedirects: 0
	});
	expect(upload.status()).toBeLessThan(400);

	await gotoAfterLogin(page, '/admin/images?sort=uploaded&dir=desc');
	await waitForHydration(page);
	await imageRows(page, title).getByRole('button', { name: '公開する' }).click();
	const dialog = page.getByRole('dialog', { name: '非公開のアーティストを公開しますか？' });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(`${artist.name}は「非公開にする」に設定されています。`);
	await expect(dialog.getByRole('button', { name: 'キャンセル' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: '公開する' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('ja-dialog.png') });
	await dialog.getByRole('button', { name: 'キャンセル' }).click();
	await expect(dialog).toHaveCount(0);
});

// A 1x1 PNG, so the upload page's dimension probe decodes it.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

test('the upload page asks before a published upload, keeps the tile on Cancel, and saves one piece', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const artist = await privateArtist(page, 'Upload Artist');
	// No stored file: the tile only needs a URL back.
	await page.route('**/api/upload', (route) =>
		route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/x-unhide.png' }) })
	);

	await gotoAfterLogin(page, '/admin/upload');
	await waitForHydration(page);
	// setInputFiles' own change event doesn't reach Svelte's delegated handler
	// (see upload.spec.ts), so dispatch one.
	await page.setInputFiles('input[type="file"]', { name: 'unhide.png', mimeType: 'image/png', buffer: PNG });
	await page.evaluate(() =>
		document.querySelector('input[type="file"]')!.dispatchEvent(new Event('change', { bubbles: true }))
	);
	const tileUrl = page.locator('input[name="imageUrl_0"]');
	await expect(tileUrl).toHaveValue('/x-unhide.png');

	const title = `Upload Unhide ${Date.now()}`;
	const titleField = page.locator('input[name="title"]');
	const artistSelect = page.locator('select[name="artistId"]');
	const submit = page.getByRole('button', { name: 'Upload Artwork' });
	const dialog = page.getByRole('dialog', { name: DIALOG });
	await titleField.fill(title);
	await artistSelect.selectOption({ label: artist.name });
	await expect(page.getByRole('checkbox', { name: /^Private/ })).not.toBeChecked();

	await submit.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(artist.name);
	await page.screenshot({ path: testInfo.outputPath('upload-dialog.png') });

	// Cancel: the tile, the title, and the artist are all still there.
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page).toHaveURL(/\/admin\/upload$/);
	await expect(tileUrl).toHaveValue('/x-unhide.png');
	await expect(titleField).toHaveValue(title);
	await expect(artistSelect).toHaveValue(String(artist.id));
	await expect(submit).toBeEnabled();

	// Make public: exactly one piece, published, and the artist is public.
	await submit.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(page).toHaveURL(/\/admin\/images$/);
	await gotoRetrying(page, '/admin/images?sort=uploaded&dir=desc');
	const rows = imageRows(page, title);
	await expect(rows).toHaveCount(1);
	await expect(rows.getByRole('button', { name: 'Make private' })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('upload-saved.png') });
	await expectPrivateTag(page, artist.name, false);
});

const STICKER_ZONE = '.upload-zone.multi';

// The manual pack page: a published pack with a Keep private artist on a
// sticker asks first. The default artist is made in the form's own New artist
// dialog, so a resubmit that made artists again would show as a second row.
test('the manual pack page asks before publishing, keeps the form on Cancel, and saves one pack', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const artist = await privateArtist(page, 'Sticker Artist');
	await page.route('**/api/upload', (route) =>
		route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: '/img/stickers/unhide.png' }) })
	);

	await gotoAfterLogin(page, '/admin/stickers/manual');
	await waitForHydration(page);
	await waitForDropAttachment(page, STICKER_ZONE);
	await dropOn(page, STICKER_ZONE, [{ name: 'sticker.png', type: 'image/png' }]);
	await expect(page.locator('input[name="sticker[0][imageUrl]"]')).toHaveValue('/img/stickers/unhide.png');

	const stamp = Date.now();
	const packName = `Unhide Pack ${stamp}`;
	const defaultName = `Pack Default ${stamp}`;
	const nameField = page.locator('input[name="name"]');
	const description = page.locator('textarea[name="description"]');
	const published = page.locator('input[name="published"]');
	const save = page.getByRole('button', { name: 'Save pack' });
	const dialog = page.getByRole('dialog', { name: DIALOG });

	await nameField.fill(packName);
	await description.fill('Typed before saving');
	await page.getByRole('button', { name: 'New artist', exact: true }).click();
	const newArtist = page.getByRole('dialog', { name: 'New Artist' });
	await newArtist.getByLabel('Artist Name').fill(defaultName);
	await newArtist.getByRole('button', { name: 'Create Artist' }).click();
	await expect(newArtist).toHaveCount(0);
	await expect(page.locator('select[name="defaultArtistId"] option:checked')).toHaveText(defaultName);
	await page.locator('select[name="sticker[0][artistId]"]').selectOption({ label: artist.name });
	await page.locator('.switch-label').first().click();
	await expect(published).toBeChecked();

	await save.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(artist.name);
	await page.screenshot({ path: testInfo.outputPath('manual-dialog.png') });

	// Cancel: the whole form is as typed.
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page).toHaveURL(/\/admin\/stickers\/manual$/);
	await expect(nameField).toHaveValue(packName);
	await expect(description).toHaveValue('Typed before saving');
	await expect(published).toBeChecked();
	await expect(page.locator('select[name="sticker[0][artistId]"]')).toHaveValue(String(artist.id));
	await expect(save).toBeEnabled();

	// Make public: one pack, one default artist, and the sticker artist is public.
	await save.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(page).toHaveURL(/\/admin\/stickers$/);
	const packRows = page.getByRole('row').filter({ hasText: packName });
	await expect(packRows).toHaveCount(1);
	await expect(packRows.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
	await page.screenshot({ path: testInfo.outputPath('manual-saved.png') });
	await expectPrivateTag(page, artist.name, false);
	await expectPrivateTag(page, defaultName, false);
});

// The publish switch on /admin/stickers: a pack whose sticker credits a Keep
// private artist asks first, Escape publishes nothing, and Make public does.
test('the sticker pack switch asks before publishing', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const artist = await privateArtist(page, 'Switch Artist');
	// An unpublished pack, through the manual pack action.
	const packName = `Switch Pack ${Date.now()}`;
	const created = await page.request.post('/admin/stickers/manual', {
		form: {
			name: packName,
			'sticker[0][imageUrl]': '/img/stickers/switch.png',
			'sticker[0][format]': 'png',
			'sticker[0][artistId]': String(artist.id)
		},
		headers: { origin: baseURL! },
		maxRedirects: 0
	});
	// Without an HTML Accept header the action answers in JSON.
	expect(await created.json()).toMatchObject({ type: 'redirect', location: '/admin/stickers' });

	await gotoAfterLogin(page, '/admin/stickers');
	await waitForHydration(page);
	const row = page.getByRole('row').filter({ hasText: packName });
	const toggle = row.getByRole('switch');
	const dialog = page.getByRole('dialog', { name: DIALOG });
	await expect(toggle).toHaveAttribute('aria-checked', 'false');

	await toggle.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(artist.name);
	await page.screenshot({ path: testInfo.outputPath('switch-dialog.png') });
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(toggle).toBeFocused();
	await expect(toggle).toHaveAttribute('aria-checked', 'false');

	await toggle.click();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(toggle).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('row').filter({ hasText: packName })).toHaveCount(1);
	await page.screenshot({ path: testInfo.outputPath('switch-published.png') });
	await expectPrivateTag(page, artist.name, false);
});

// The edit pack page shares the manual page's form, so it asks the same way:
// the pack's manager is the Keep private artist here.
test('publishing a pack on its edit page asks first and keeps the edits', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const artist = await privateArtist(page, 'Manager Artist');
	const packName = `Edit Pack ${Date.now()}`;
	const created = await page.request.post('/admin/stickers/manual', {
		form: {
			name: packName,
			managerArtistId: String(artist.id),
			telegramUrl: 'https://t.me/addstickers/e2e_edit_pack',
			'sticker[0][imageUrl]': '/img/stickers/edit.png',
			'sticker[0][format]': 'png'
		},
		headers: { origin: baseURL! },
		maxRedirects: 0
	});
	expect(await created.json()).toMatchObject({ type: 'redirect', location: '/admin/stickers' });

	await gotoAfterLogin(page, '/admin/stickers');
	const href = await page
		.getByRole('row')
		.filter({ hasText: packName })
		.getByRole('link', { name: 'Edit pack' })
		.getAttribute('href');
	await gotoRetrying(page, href!);
	await waitForHydration(page);
	const nameField = page.locator('input[name="name"]');
	const telegramField = page.locator('input[name="telegramUrl"]');
	const published = page.locator('input[name="published"]');
	const save = page.getByRole('button', { name: 'Save Changes' });
	const dialog = page.getByRole('dialog', { name: DIALOG });
	const renamed = `${packName} renamed`;

	// Both fields start with a saved value, which is what a re-render puts back.
	await nameField.fill(renamed);
	await telegramField.fill('https://t.me/addstickers/e2e_edit_pack_2');
	await page.locator('.switch-label').first().click();
	await expect(published).toBeChecked();
	await save.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(artist.name);
	await page.screenshot({ path: testInfo.outputPath('pack-edit-dialog.png') });

	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(nameField).toHaveValue(renamed);
	await expect(telegramField).toHaveValue('https://t.me/addstickers/e2e_edit_pack_2');
	await expect(published).toBeChecked();

	await save.click();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(page).toHaveURL(/\/admin\/stickers$/);
	const rows = page.getByRole('row').filter({ hasText: renamed });
	await expect(rows).toHaveCount(1);
	await expect(rows.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
	await page.screenshot({ path: testInfo.outputPath('pack-edit-saved.png') });
	await gotoRetrying(page, href!);
	await expect(telegramField).toHaveValue('https://t.me/addstickers/e2e_edit_pack_2');
	await expectPrivateTag(page, artist.name, false);
});

// The VR avatar form, new and edit: credits on a published avatar make their
// artists public, so it asks first, naming every private artist credited.
test('a new published VR avatar asks first, names every private artist, and saves once', async ({
	page
}, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const first = await privateArtist(page, 'VR Base Artist');
	const second = await privateArtist(page, 'VR Texture Artist');

	await gotoAfterLogin(page, '/admin/vr/new');
	await waitForHydration(page);
	const avatarName = `Unhide Avatar ${Date.now()}`;
	const description = page.locator('textarea[name="description"]');
	const published = page.getByRole('checkbox', { name: 'Published' });
	// The box is visually hidden; the switch drawn over it takes the click.
	const publishedSwitch = page.locator('label.switch-label').filter({ has: page.locator('input[name="published"]') });
	const create = page.getByRole('button', { name: 'Create avatar' });
	const dialog = page.getByRole('dialog', { name: DIALOG });

	await page.locator('input[name="name"]').fill(avatarName);
	await page.locator('select[name="characterId"]').selectOption({ label: 'Taro' });
	await description.fill('Typed before saving');
	await page.getByRole('button', { name: 'Add credit' }).click();
	await page.locator('select[name="credit[0][artistId]"]').selectOption({ label: first.name });
	await page.getByRole('button', { name: 'Add credit' }).click();
	await page.locator('select[name="credit[1][artistId]"]').selectOption({ label: second.name });
	await page.locator('select[name="credit[1][role]"]').selectOption('texture');
	await publishedSwitch.click();
	await expect(published).toBeChecked();

	await create.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(`Keep private is ticked for ${first.name} and ${second.name}.`);
	await page.screenshot({ path: testInfo.outputPath('vr-new-dialog.png') });

	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page).toHaveURL(/\/admin\/vr\/new$/);
	await expect(page.locator('input[name="name"]')).toHaveValue(avatarName);
	await expect(description).toHaveValue('Typed before saving');
	await expect(page.locator('select[name="credit[1][artistId]"]')).toHaveValue(String(second.id));
	await expect(published).toBeChecked();
	await expect(create).toBeEnabled();

	await create.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(page).toHaveURL(/\/admin\/vr$/);
	await expect(page.getByRole('link', { name: `Edit ${avatarName}` })).toHaveCount(1);
	await page.screenshot({ path: testInfo.outputPath('vr-new-saved.png') });
	await expectPrivateTag(page, first.name, false);
	await expectPrivateTag(page, second.name, false);
});

test('publishing a VR avatar on its edit page asks first and keeps the edits', async ({ page, baseURL }, testInfo) => {
	await loginRetrying(page, PASSWORD);
	await page.waitForLoadState('load');
	const artist = await privateArtist(page, 'VR Edit Artist');
	// An unpublished avatar crediting them, through the new-avatar action.
	const stamp = Date.now();
	const avatarName = `Edit Avatar ${stamp}`;
	const created = await page.request.post('/admin/vr/new', {
		form: {
			name: avatarName,
			slug: `edit-avatar-${stamp}`,
			characterId: '1',
			externalUrl: 'https://hub.vroid.com/e2e-edit',
			permissionSource: 'Seller page',
			'credit[0][artistId]': String(artist.id),
			'credit[0][role]': 'base'
		},
		headers: { origin: baseURL! },
		maxRedirects: 0
	});
	// Without an HTML Accept header the action answers in JSON.
	expect(await created.json()).toMatchObject({ type: 'redirect', location: '/admin/vr' });

	await gotoAfterLogin(page, '/admin/vr');
	const href = await page.getByRole('link', { name: `Edit ${avatarName}` }).getAttribute('href');
	await gotoRetrying(page, href!);
	await waitForHydration(page);
	const description = page.locator('textarea[name="description"]');
	const published = page.getByRole('checkbox', { name: 'Published' });
	// The box is visually hidden; the switch drawn over it takes the click.
	const publishedSwitch = page.locator('label.switch-label').filter({ has: page.locator('input[name="published"]') });
	const save = page.getByRole('button', { name: 'Save changes' });
	const dialog = page.getByRole('dialog', { name: DIALOG });

	// The two text fields start with saved values, which is what a re-render
	// puts back.
	const externalUrl = page.locator('input[name="externalUrl"]');
	const permission = page.locator('input[name="permissionSource"]');
	const edit = async () => {
		await description.fill('Edited before publishing');
		await externalUrl.fill('https://hub.vroid.com/e2e-edited');
		await permission.fill('Edited permission');
		await publishedSwitch.click();
	};
	await edit();
	await save.click();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(artist.name);
	await page.screenshot({ path: testInfo.outputPath('vr-edit-dialog.png') });

	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(description).toHaveValue('Edited before publishing');
	await expect(externalUrl).toHaveValue('https://hub.vroid.com/e2e-edited');
	await expect(permission).toHaveValue('Edited permission');
	await expect(published).toBeChecked();
	await expectPrivateTag(page, artist.name, true);
	await gotoRetrying(page, href!);
	await waitForHydration(page);

	await edit();
	await save.click();
	await dialog.getByRole('button', { name: 'Make public' }).click();
	await expect(page).toHaveURL(/\/admin\/vr$/);
	await gotoRetrying(page, href!);
	await expect(description).toHaveValue('Edited before publishing');
	await expect(externalUrl).toHaveValue('https://hub.vroid.com/e2e-edited');
	await expect(permission).toHaveValue('Edited permission');
	await expect(published).toBeChecked();
	await page.screenshot({ path: testInfo.outputPath('vr-edit-saved.png') });
	await expectPrivateTag(page, artist.name, false);
});
