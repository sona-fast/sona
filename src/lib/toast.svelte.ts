// Global toast/notification store. Used to surface action outcomes — especially
// errors from form actions and fetch() calls — consistently across the app.
// Usage: `import { toast } from '$lib/toast.svelte'; toast.error('Something failed')`.

export type ToastType = 'error' | 'success' | 'info';

interface Toast {
	id: number;
	type: ToastType;
	message: string;
}

let toasts = $state<Toast[]>([]);
let counter = 0;

/** Reactive list of active toasts (read in the Toaster component). */
export function getToasts(): Toast[] {
	return toasts;
}

export function dismissToast(id: number) {
	toasts = toasts.filter((t) => t.id !== id);
}

/** Show a toast. ttl=0 keeps it until dismissed. Returns its id. */
export function pushToast(type: ToastType, message: string, ttl = 5000): number {
	const id = ++counter;
	toasts.push({ id, type, message });
	if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
	return id;
}

export const toast = {
	error: (message: string, ttl = 7000) => pushToast('error', message, ttl),
	success: (message: string, ttl = 4000) => pushToast('success', message, ttl),
	info: (message: string, ttl = 5000) => pushToast('info', message, ttl)
};
