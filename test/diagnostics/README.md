# OAuth restart connection reproduction

## Live server smoke test

```sh
node --import tsx test/diagnostics/live-mcp-smoke.mjs https://your-domain.ngrok-free.dev
node --import tsx test/diagnostics/live-mcp-smoke.mjs https://your-domain.ngrok-free.dev --capture
```

This opt-in diagnostic uses the running server at localhost:3000 and its public ngrok address, rather than starting a test server. It verifies health and unauthenticated rejection, registers a diagnostic OAuth client, and prints a request number. Enter that number in the real MCP terminal within two minutes to approve. A single approved connection slot must be available; the diagnostic does not disconnect existing clients or approve itself.

After human approval it checks PKCE exchange, MCP initialization and all 23 tool descriptions through both routes, actual command execution, disposable file write/read, byte-for-byte original PNG return, and 32 KiB compact output with continuation. `--capture` also requests a small native screenshot without retaining or printing its pixels. Cookies, codes, tokens, private file contents, and image payloads stay out of diagnostic output. Finally it revokes its own token and verifies rejection, then removes its temporary files; DCR registration metadata remains. It leaves the server running. This tests the SDK client through the live endpoints, not the ChatGPT application's own connector UI.

The OAuth integration test restarts a local HTTP server on the same port. Node fetch can reuse an idle keep-alive socket from the previous instance before it observes the remote close. A subsequent POST then fails with `ECONNRESET` or `UND_ERR_SOCKET` instead of reaching the new instance.

The original OAuth scenario failed 3 out of 30 runs during diagnosis. A reduced test needs only a consumed health response, normal close, same-port restart, and a POST; it reproduces without OAuth state or token storage. Socket tracing confirmed a failed POST for server generation 6 was sent over a connection accepted by generation 5. The temporary tracing has been removed.

Restart fixtures now use `test/helpers/http-fixture.ts`. Each server generation owns a dedicated Undici Agent, raw fetch, and MCP SDK clients. Keep-alive is enabled within a generation. Restart closes SDK clients, cancels unread responses, retires the pool (with bounded force-destroy for unfinished requests), normally closes the server, and starts a new generation on the same port. Old fetch/client handles cannot follow the new pool. The global dispatcher is unchanged, and no POST is retried. All fixture and diagnostic code lives under `test/`.

The earlier `Connection: close` workaround passed 30 repetitions. That result describes the previous workaround; the generation-owned pool has its own regression and repetition checks below.

On 2026-10-29, the generation-owned Agent implementation passed all 30 repetitions of the original OAuth scenario (0/30 failed). The 40-cycle same-port regression and terminal six-hour persistence tests also passed with keep-alive enabled.

Reproduce the previous behavior (expected to fail):

```sh
node test/diagnostics/legacy-http-restart.mjs 40
```

Verify the fix:

```sh
TMPDIR=/tmp npm test -- test/restart-fixture.test.ts test/http-restart.integration.test.ts test/oauth.integration.test.ts test/terminal-oauth.integration.test.ts
TMPDIR=/tmp node test/diagnostics/oauth-restart-repro.mjs 30
```

The reduced regression test performs 40 same-port restarts, observes actual socket reuse within a generation and verifies every request uses a socket accepted by that generation. The legacy reproduction is timing-dependent; a successful run does not disprove the race. The diagnostic runner only prints request methods, paths, and connection errors; it does not print authorization headers, query strings, or response bodies.

This manages the test client's pools. It does not dispose external ChatGPT/ngrok client pools or change production keep-alive behavior. Normal close preserves Approved sessions; refresh and restart must not extend the six-hour deadline.

## macOS process-group termination

On macOS, a group signal can return `EPERM` after the parent exits even when no live group members remain. [Apple XNU's `killpg1`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c#L1612-L1621) excludes zombies and can return `EPERM` when the group exists but no eligible members are found. A signal-zero `EPERM` is also ambiguous. Confirming group membership and live status distinguishes this case from a genuinely denied live group; permission failures must remain reported and retryable.

Run the closed-stdin shell lifecycle diagnostic on macOS:

```sh
node --import tsx test/diagnostics/process-signal-repro.mjs 200
```

It records signal errors, signal-zero probes, and process-group member states. The race is timing-dependent, so a successful run alone does not disprove it.

On 2026-10-29, the original shutdown handling failed 2/200 repetitions with empty groups. After checking Darwin group membership/live status on `EPERM`, there were 0/1000 shutdown failures, while transient syscall errors remained observable in the diagnostic. Deterministic tests also verify that a denied live group still fails and can be retried after permission recovers.

## Original image and native capture checks

```sh
TMPDIR=/tmp npm test -- test/image-tools.integration.test.ts test/screen-capture.integration.test.ts test/output-budget.integration.test.ts
node scripts/build-native.mjs
TMPDIR=/tmp node --import tsx test/diagnostics/screen-capture-smoke.mjs --capture
```

Automated capture tests invoke a real external process implemented by `test/fixtures/capture-helper.mjs`. The opt-in native smoke invokes the real Swift helper through MCP, discards image content after validation, and prints only counts/dimensions/byte sizes or errors. It requires a logged-in macOS desktop and screen recording permission. Without `--capture` it only checks target discovery.

On 2026-10-29 the real helper returned display 2940×1912, a 32×24-point region at 64×48 pixels (scale 2), and a window at 2940×1846. Initial window capture exposed a WindowServer initialization assertion; initializing AppKit before window filter geometry resolved it. No screenshots are retained by this diagnostic. The final automated suite passed 91 tests, typecheck, and TypeScript/Swift build.
