// Settings tab ids + the ?tab= deep-link resolver (SONA-114: the admin-wide
// key-expiry notice links to ?tab=account). Pure module so the resolution is
// unit-testable outside the component.
//
// SETTINGS_TAB_IDS is the single source of truth (SONA-119): the tablist
// renders from it, TabId is derived from it, and tabs.test.ts asserts the
// component's per-tab CSS and its data-tab section markers agree with it — the
// one place the list can't be read from at build time.
export const SETTINGS_TAB_IDS = ['site', 'connections', 'storage', 'account', 'observability'] as const;
export type TabId = (typeof SETTINGS_TAB_IDS)[number];

const isTabId = (t: string | null): t is TabId => SETTINGS_TAB_IDS.includes(t as TabId);

/** The tabs actually offered: 'observability' only exists while its opt-in gate
 * is on, so it is both hidden from the tablist and unresolvable from ?tab=. */
export function visibleTabIds(observabilityEnabled: boolean): readonly TabId[] {
	return SETTINGS_TAB_IDS.filter((id) => id !== 'observability' || observabilityEnabled);
}

/** Resolve a ?tab= param to the tab to show: unknown, absent, or currently
 * hidden values fall back to 'site'. */
export function resolveTabId(param: string | null, observabilityEnabled: boolean): TabId {
	return isTabId(param) && visibleTabIds(observabilityEnabled).includes(param) ? param : 'site';
}
