// Test-only stub for `$app/environment`, which is normally provided by the
// SvelteKit Vite plugin (not loaded in the minimal vitest config). Aliased in
// vitest.config.ts so server modules that read `dev` are importable in unit tests.
export const dev = false;
export const browser = false;
export const building = false;
export const version = 'test';
