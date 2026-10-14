# Automatic TMCP usage publication

The existing mcp-inventory-refresh process collects tools/list once, sanitizes the response through mcp-usage-docs.mjs, and atomically writes ~/.drive-worker/mcp-tools-cache.json. The existing DriveWorker inventory refresh reads that cache. No additional daemon or duplicate tools/list probe is introduced.

A registry fingerprint, source commit and 15-minute maximum age fence stale schemas. Descriptions are untrusted reference data; examples/defaults, external URLs, credential-like strings and sensitive-field values are omitted. Input nested structures/unions/required fields are retained. Omitted const/pattern constraints require consulting current tools/list before a call.

MCP_INDEX.md and MCP_INDEX.json retain their existing IDs. Per-server Markdown document IDs are reserved in MCP_SYNC_MANIFEST.json with Drive v2 ETag compare-and-swap before creation. Creation uses a preallocated Drive v3 ID and no transport retry. A timeout is reconciled against the same ID; it never allocates a second ID for the same reservation. A local journal and tagged remote discovery support restart recovery. Only readback-verified documents receive links.

Markdown automatic blocks carry hashes. Notes outside them are preserved. Edited automatic blocks, duplicate mappings and changed ETags fail closed. Removed servers become inactive, never deleted. Collection failure leaves the last successful document unchanged and separately marks stale in the index/manifest.

Drive v3 If-Match was experimentally found ineffective on 2026-10-14. All mutable document/index writes use Drive v2 metadata ETags and If-Match, verified with a real stale-ETag 412. Do not replace this with unguarded v3 media PATCH.

Deployment must keep mcp-inventory-refresh alongside mcp-usage-docs.mjs in the immutable release, and point ~/bin/mcp-inventory-refresh at that script. The collector resolves its helper relative to its real path. Keep registry, secrets, existing job state and cluster arbitration unchanged. Coordinate an idle window before changing the DriveWorker launcher.
