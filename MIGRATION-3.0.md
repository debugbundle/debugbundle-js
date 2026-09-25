# JavaScript SDK 3.0 migration

Version 3 keeps the existing installation and public capture APIs; no collector or additional service is required. Keep a pinned version 2 installation available during rollout.

## Application callbacks

`beforeSend` receives an isolated, sanitized event after capture returns. Do not rely on it having run when a capture method returns, or mutate shared application state expecting capture-time ordering. Optional callbacks execute on the JavaScript event loop and must return promptly. Arbitrary application closures cannot be moved to a worker without breaking their access to application state; a blocking callback can delay the host event loop. Hooks have a synchronous return contract; Promise returns are invalid and rejected Promises are contained rather than awaited. Throwing/invalid hooks retain the already protected original; valid replacement, replacement identity and null-drop semantics remain supported. Valid over-budget replacements are dropped rather than restoring pre-hook application content.

Cheap level and policy checks precede construction. Privacy-safe admission precedes callback execution. Queue pressure can discard an event before its hook runs. Final replacements are privacy-scanned, schema-validated and subjected to authoritative policy before delivery. Batching, queue limits, error/exception priority and bounded aggregate loss reports remain enforced independently of callbacks.

## Browser delivery

Pending hooks and finalized events share the same 512-event/8-MiB debug queue, including retained sends. Deferred preparation uses one coalesced task, at most 32 events per timer turn; explicit/batch flush prepares at most 256 records per batch. Each final replacement is charged before the next callback runs. Exceptions keep priority over ordinary logs. Session limits and the configured level are checked again against final events.

Patch 3.0.2 accounts for overlapping send ownership after acknowledgement, waits for an existing keepalive within the explicit flush deadline, and applies bounded retry policy to lifecycle delivery. Built-in direct HTTP delivery requires the canonical ingestion acknowledgement; bodyless custom and legacy relay responses remain compatible. Debug and analytics share one 60-KiB lifecycle budget per SDK instance. Accepted beacons retain their byte reservation because the browser exposes no completion signal; events that no longer fit use ordinary delivery while the page remains active.

Use `await sdk.flush()` before intentional navigation when hook-dependent delivery matters. Page-unload beacon delivery sends only finalized events; pending application hooks are not invoked from the unload handler, and those pending events may be lost. Flush waiting shares one deadline, using the configured request timeout clamped to 1–60,000 ms. Expiry stops waiting without releasing ownership of a still-running custom transport. Browser shutdown never guarantees delivery. Capture rules, breadcrumbs, analytics, acknowledgement/retry behavior and the browser relay remain supported.

From 3.0.1, direct ingestion uses authenticated keepalive fetch on page exit; relay mode keeps credential-free beacons. Both lifecycle paths cap individual request bodies at 60 KiB and keep the remainder queued for ordinary delivery while the page remains active. An event larger than that limit needs an ordinary send. The browser may terminate before any pending request or queued event is delivered.

## Node delivery

The existing bounded buffer owns pending hooks and transport work. A single sender finalizes each admitted event, charges its protected replacement before processing the next callback, and reuses finalized objects on retry. Final level, request/probe policy, capture rules, sampling and suppression still apply. Hook changes to valid event IDs remain supported. Reinitialization from a callback cannot send stale work through the new configuration. Hooks are no longer capture-time notifications; use explicit flush/shutdown when delivery needs to be awaited.

## Coordinated packages

The Node and browser packages share a coordinated 3.0 release line. Their core-owned `@debugbundle/shared-types` and `@debugbundle/redaction` dependencies retain their separately versioned 2.1.0 release line; SDK packaging must not rewrite those dependencies to the SDK's major version. Publish and verify those prerequisites before the SDKs, and qualify WordPress against the built browser archive.
