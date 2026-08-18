# Security policy

Sona is self-hosted: the same code runs on [sona.fast](https://sona.fast) and
on every deployed instance of this repository. A vulnerability here affects
all of them, so reports stay private until a fix ships.

## Reporting a vulnerability

Report it through [GitHub private vulnerability
reporting](https://github.com/sona-fast/sona/security/advisories/new). If you
don't have a GitHub account, email <security@sona.fast>.

Don't put vulnerability details in a public issue, discussion, or pull
request. Every instance runs this code, and a public report exposes them all
before a fix exists.

If you found the problem on a specific site (its `/.well-known/security.txt`
points here), report it here rather than to that site's operator. Operators
deploy this code as-is; the fix has to land in this repository either way.

## What to expect

- A reply acknowledging your report, normally within a few days.
- An assessment of the report and, for confirmed vulnerabilities, a fix
  released to all instances plus a published advisory once they've had time
  to update.
- Credit in the advisory if you want it.

## Scope

The latest release and `main` are supported; older versions get fixes only by
updating. Vulnerabilities in dependencies are best reported upstream, but a
report here is welcome when Sona's use of the dependency is what's exploitable.
