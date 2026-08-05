// Settings tab ids + the ?tab= deep-link resolver (SONA-114: the admin-wide
// key-expiry notice links to ?tab=account). Pure module so the resolution is
// unit-testable outside the component.
const TAB_IDS = ['site', 'connections', 'storage', 'account', 'observability'] as const;
export type TabId = (typeof TAB_IDS)[number];

const isTabId = (t: string | null): t is TabId => TAB_IDS.includes(t as TabId);

/** Resolve a ?tab= param to the tab to show: unknown/absent values fall back to
 * 'site', and 'observability' only resolves while its opt-in gate is on. */
export function resolveTabId(param: string | null, observabilityEnabled: boolean): TabId {
	return isTabId(param) && (param !== 'observability' || observabilityEnabled) ? param : 'site';
}
