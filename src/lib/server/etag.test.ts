import { describe, it, expect } from 'vitest';
import { singleValidator, r2ConditionalTag } from './etag';

describe('singleValidator', () => {
	it('accepts one entity-tag, weak or strong, and returns it verbatim', () => {
		expect(singleValidator('"abc"')).toBe('"abc"');
		expect(singleValidator('W/"abc"')).toBe('W/"abc"');
		// An etag is not a comma-free token — %x21/%x23-7E includes ',' — so a
		// header split on commas would read this as two tags.
		expect(singleValidator('"a,b"')).toBe('"a,b"');
		expect(singleValidator('  "abc"  ')).toBe('"abc"');
	});

	it('refuses anything that does not name exactly one entity', () => {
		for (const value of ['"v1", W/"v2"', '*', 'not-a-quoted-etag', 'W/ "abc"', 'w/"abc"', '"abc', '']) {
			expect(singleValidator(value)).toBeNull();
		}
		expect(singleValidator(null)).toBeNull();
	});

	it('refuses characters that are not etagc, so none can reach a header', () => {
		// CR, LF and NUL are the ones that would matter in an outbound request or
		// a response header; SP and DEL are simply not in the grammar.
		for (const bad of ['\r', '\n', '\0', ' ', '\x7F', '"']) {
			expect(singleValidator(`"a${bad}b"`)).toBeNull();
		}
		// obs-text IS in the grammar and must survive.
		expect(singleValidator('"a\xE9b"')).toBe('"a\xE9b"');
	});

	it('bounds the length at 256 inclusive', () => {
		const max = `"${'x'.repeat(254)}"`;
		expect(max).toHaveLength(256);
		expect(singleValidator(max)).toBe(max);
		expect(singleValidator(`"${'x'.repeat(255)}"`)).toBeNull();
	});
});

describe('r2ConditionalTag', () => {
	it('strips the quotes R2 refuses to accept', () => {
		// workerd rejects a quoted tag outright: "Conditional ETag should not be
		// wrapped in quotes".
		expect(r2ConditionalTag('"abc"')).toBe('abc');
		expect(r2ConditionalTag('"a,b"')).toBe('a,b');
	});

	it('refuses a weak tag, which R2 would compare strongly and never match', () => {
		expect(r2ConditionalTag('W/"abc"')).toBeNull();
	});

	it('refuses a quoted wildcard, which unquoting would turn INTO the wildcard', () => {
		// `"*"` is a legal single entity-tag naming the opaque value `*` (RFC 9110
		// §13.1.2 makes the wildcard the unquoted production), so singleValidator
		// takes it — but handing R2 the stripped `*` matches any object, and the
		// client is told 304 for bytes it has never seen.
		expect(singleValidator('"*"')).toBe('"*"');
		expect(r2ConditionalTag('"*"')).toBeNull();
	});

	it('refuses everything singleValidator does, so no unparseable tag reaches R2', () => {
		// R2 THROWS rather than ignoring a tag it cannot parse, so this screening
		// is what keeps a hand-rolled client's header from becoming a 500.
		for (const value of ['garbage', 'abc', '*', '"v1", "v2"', '"a\rb"']) {
			expect(r2ConditionalTag(value)).toBeNull();
		}
	});
});
