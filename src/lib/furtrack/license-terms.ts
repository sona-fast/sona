// Localized license terms. The English source lives verbatim in license.ts
// (LicenseInfo.terms), which is also what the admin panel uses. Public-facing
// components render the translated version via this map instead, keyed by the
// license key. Falls back to the English `terms` if a key is ever unmapped.
import * as m from '$lib/paraglide/messages';
import type { LicenseInfo, LicenseKey } from './license';

const TERMS: Record<LicenseKey, () => string> = {
	'cc-by': m.license_terms_cc_by,
	'cc-by-nd': m.license_terms_cc_by_nd,
	'cc-by-nc': m.license_terms_cc_by_nc,
	'cc-by-nc-nd': m.license_terms_cc_by_nc_nd,
	'public-domain': m.license_terms_public_domain,
	'photographer-discretion': m.license_terms_photographer_discretion,
	'photographer-license': m.license_terms_photographer_license,
	'all-rights-reserved': m.license_terms_all_rights_reserved,
	unknown: m.license_terms_unknown
};

/** Localized plain-language terms for a resolved license. */
export function licenseTerms(license: LicenseInfo): string {
	return TERMS[license.key]?.() ?? license.terms;
}
