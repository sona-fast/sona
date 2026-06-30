const SESSION_COOKIE = 'sparky_admin_session';
const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days

export function verifyPassword(input: string, adminPassword: string): boolean {
	return input === adminPassword;
}

export function createSessionCookie(): string {
	const token = crypto.randomUUID();
	return [
		`${SESSION_COOKIE}=${token}`,
		`Path=/`,
		`HttpOnly`,
		`Secure`,
		`SameSite=Strict`,
		`Max-Age=${SESSION_DURATION}`
	].join('; ');
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function getSessionToken(cookieHeader: string | null): string | null {
	if (!cookieHeader) return null;
	const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
	return match ? match[1] : null;
}
