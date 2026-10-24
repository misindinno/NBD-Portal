# Scot IndexedDB reference review

Reviewed on 2026-10-24 from `D:\Code\Scot Portal`. Scot source was read, not changed.

## What Scot actually stores

`src/app/PersistentData.html` opens
`scot-workspace-cache-<scope>-<accessRevision>` (schema version 2). It has twelve
collection stores: clients, leads, followups, followupHistory, activityLogs,
saleData, products, productGroups, aliases, productStatuses, paymentFollowups and
paymentHistory, plus `meta` and `queries`.

Each record contains the source row object, retaining its business column names,
with separate index fields for client, lead, follow-up and date. A primary business
ID is used when present; legacy/missing or duplicate IDs have fallback keys. This
is a mirror of authorized application data, not every workbook tab or a clone of
cell formatting, formulas, merged cells and permissions. Client/factory visit data
is held in query snapshots, not one of the twelve full collection stores.

## Read and refresh behavior

- `PersistentData.bootstrap` verifies the session with the server on every
  startup; saved identity never grants access. It can reuse unchanged configuration.
- `AppData.preloadAllData` restores saved collections first, then uses two
  background workers to load authorized collections without blocking navigation.
- `PortalData` is the display repository; pages use saved collections or saved
  queries. `PortalSync` handles refresh and accepts acknowledged save results.
- `PersistentStateService.js` partitions records into 64 stable hash buckets.
  The browser downloads changed buckets in bounded batches and stores only a
  complete result. Missing ScriptCache pages trigger a snapshot fallback.
- Local persistence applies changed records/deletions and metadata in one
  transaction. Scope/access changes isolate data; logout purges the active cache.
- Refresh checks run on focus, visibility and a five-minute timer. This is polling,
  not sockets or guaranteed instantaneous propagation of spreadsheet edits.
- Business writes still go through authenticated Apps Script APIs. This Scot
  layer does not provide NBD's durable command outbox/retry-receipt protocol.

## Difference from current NBD

NBD's `IndexedDbCache.html` stores complete, verified lead snapshots in
`nbd-authorized-reads.snapshots`. `PortalReadCache.html` caches responses for
follow-ups, Today, Archive, calls, call totals and visits. Some are a filtered page
of results; changing filters can require another server read. It is not a complete
collection mirror for every sheet. Its `PortalSync.html` additionally implements
a separate durable outbox with authorization checks, conflict handling and receipts.

Deploying that code does not enable the three sync feature flags. Visit table
initialization and sync activation are separate operations.

## NBD adaptation

Interpret “whole sheet data format” as original business column names and all rows
the signed-in user may access. Retain Google Sheets as the shared source of truth
and the original workbook IDs. No PostgreSQL is required.

1. Inventory business sheets and define an explicit collection/column allowlist.
   Map leads, follow-ups, history, activity, custom field values, calls, public
   visits and client/factory visits with their own authorization rules. Include
   safe reference data for stages/configuration and display names. Do not export
   staff passwords, tokens, webhook secrets, internal queues or execution logs.
2. Introduce a versioned database scoped to portal, workbook, user and access
   revision. Store business rows separately from pending commands, with stable IDs,
   original column metadata, completeness, revision and last verification time.
   Preserve legitimate duplicate history rows; report malformed identifiers rather
   than silently dropping them. A partial download must never replace a full one.
3. Add authorized full-collection manifests and bounded pages. Stage each new
   generation, validate count/revision/hash, then atomically activate it. Use
   deltas/tombstones for updates, deletions and reassignment. Do not copy Scot's
   temporary ScriptCache dependency as a guarantee of durable delivery.
4. Add a shared display repository and migrate each screen to local filtering,
   search, sorting and pagination. Preload independently with low concurrency.
   Keep remote reads inside sync/bootstrap and explicit server-only workflows.
5. Preserve NBD's existing outbox. Overlay pending edits on confirmed data with
   visible pending/conflict status; only server-acknowledged changes enter the
   confirmed mirror. Revalidate authorization and conflicts on every commit.
6. Refresh in the background while the portal is open, with focus/reconnect checks,
   bounded polling and periodic source reconciliation. Triggers can flag changes
   but must not be the only mechanism for detecting API/import/manual edits.
7. Pilot behind a separate feature flag in one portal before all six. Verify cold
   and warm loads, complete row/column parity, local filtering, cross-user isolation,
   reassignment/revocation, direct Sheet edits/deletes, offline/reconnect, duplicate
   replay, partial downloads, storage eviction and multi-tab saves. Record latency
   and server-call counts. Rollback must retain unresolved outbox commands.

This is the reviewed migration design. The full-collection adaptation is not yet
implemented or enabled by the visit deployment work.
