# Cross-network development

Implementation of [#43](https://github.com/mekoand/sub2sub/issues/43), part of [#42](https://github.com/mekoand/sub2sub/issues/42). Distribution and explicit existing-connection migration are implemented by #44; real two-device acceptance and product documentation are tracked in #45.

`device_settings.crossNetwork` is a device-wide opt-in, defaulting to false. The independent Node service owns the setting, outgoing cross-network operations and incoming tasks. Enabling the setting does not start accepting tasks. A stopped provider continues to serve authorized status, cancellation and results under the existing protocol.

One invitation can carry both a private HTTPS endpoint and a Tailcat address. The caller first attempts the pinned HTTPS endpoint. Only a transport failure before any HTTP request was sent permits trying Tailcat. Certificate failures stop the operation. Failures after submission retain the original task and never cause automatic execution replay. Both paths retain application TLS pinning and pairing/task-file authorization.

The helper wraps `github.com/tailscale/tailcat` v0.6.0. It carries opaque TLS bytes for virtual TCP port 443, forwarding only to the Node service's loopback listener. It exposes neither HTTP management nor a shell, UDP service or arbitrary destination proxy. Node keeps task records and credentials; the helper keeps its network key, PSK and chosen bootstrap region so saved addresses survive restarts. Public DERP is the default; availability and throughput are not guaranteed. Tailcat may use direct UDP after discovery; `connectionRoute: tailcat` does not assert whether an individual connection used a relay.

The setting refuses to turn off during cross-network requests, accepted tasks or unresolved outgoing execution. Pending outgoing task identities survive Node restart. A later original-task status check or explicit cancellation allows resolving them. If status cannot be confirmed, the service stays enabled and reports the task requiring attention. The management UI restores the actual setting after a rejected change.

## Build and verify

Use Go 1.27.1 or later and the locked module dependencies:

```sh
cd transport/tailcat
go build -o ../../bin/sub2sub-tailcat .
```

On Windows, build `../../bin/sub2sub-tailcat.exe`. For distribution, use `node scripts/build-tailcat.mjs /absolute/new/helper-directory [platform] [arch]`, then `node scripts/package.mjs /absolute/new/sub2sub --tailcat-dir /absolute/helper-directory`. The builder collects licenses from linked Go modules, records the target and checksum, and excludes local identities. `npm run release` builds a matching helper for each supported archive. Installation validates the helper bytes and runs its offline `--version` check before changing a host installation. Source-only packages retain private-network operation.

Existing pairings do not gain a Tailcat address when either device enables the setting. Use `edit_peer` with `migrate: true` after both devices opt in. It retrieves the provider endpoint through the original pairing, then verifies that pairing over Tailcat before saving. When the old endpoint is unavailable, provide a new invitation from that same provider; its fingerprint must match. The invitation is not consumed to create a replacement pairing. Pair ID, token, file consent and task/session history remain attached to the existing connection. Failure leaves the saved connection unchanged. Older providers must update first; an old caller can continue using its saved private endpoint but must update to read a new cross-network invitation.

```sh
npm ci --omit=optional --ignore-scripts
npm run check
node --test test/cross-network.test.mjs
npm test
```

The default regression uses an external byte-forwarding fixture and the simulated Codex executable. To run the pairing/task/restart regression through the compiled real Tailcat helper and public DERP, set `SUB2SUB_REAL_TAILCAT` to its absolute path and run:

```sh
node --test --test-name-pattern='explicitly enabled devices pair' test/cross-network.test.mjs
```

This is a same-host transport check with simulated task execution. It does not establish physical two-device, cross-network, Windows-hardware or real-AI acceptance. `SUB2SUB_TAILCAT` can select a helper executable for development; it is not a remote input or user-facing relay setting.
