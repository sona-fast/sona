import { describe, it, expect } from "vitest";
import { serialize, parse } from "cookie";
import {
  SESSION_COOKIE,
  VIEWER_TZ_COOKIE,
  THEME_MODE_COOKIE,
  RESET_TOKEN_COOKIE,
} from "./config";

// SvelteKit's `cookies` API is a thin wrapper over the `cookie` package, and
// that package tightens name/value validation across majors (0.7 started
// throwing on input 0.6 accepted). A bump that rejects one of our names, or
// changes how a value survives the round trip, breaks admin login — this makes
// `npm test` say so instead of an e2e run.
const NAMES = [
  SESSION_COOKIE,
  // The dev name isn't SESSION_COOKIE under vitest (dev=false), so pin both.
  "sona_admin_session",
  "__Host-sona_admin_session",
  VIEWER_TZ_COOKIE,
  THEME_MODE_COOKIE,
  RESET_TOKEN_COOKIE,
];

const PATHS = ["/", "/admin", "/admin/reset"];

describe("cookie serializer", () => {
  it.each(NAMES)("serializes %s on every path we use", (name) => {
    for (const path of PATHS) {
      expect(() =>
        serialize(name, "value", {
          path,
          httpOnly: true,
          secure: true,
          sameSite: "lax",
        }),
      ).not.toThrow();
    }
  });

  it.each(NAMES)("round-trips %s through parse", (name) => {
    const value = "a-value_with.chars";
    expect(parse(serialize(name, value, { path: "/" }))[name]).toBe(value);
  });

  it("round-trips values needing percent-encoding", () => {
    // Reset tokens and IANA zone names carry characters (=, /) that the
    // serializer has to encode and parse has to give back verbatim.
    const value = "America/Los_Angeles=";
    expect(
      parse(serialize(RESET_TOKEN_COOKIE, value, { path: "/admin/reset" }))[
        RESET_TOKEN_COOKIE
      ],
    ).toBe(value);
  });
});
