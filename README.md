# Hypersnap v2

A read-only follower of [Hypersnap](https://github.com/farcasterorg/hypersnap) (epoch 0) that verifies blocks itself and can run on Cloudflare or a home PC. This is Arca's own implementation. It is backward compatible with the Hypersnap v1 read API for a small set of endpoints. It is not a Snapchain node and it does not speak libp2p.

Milestone 1 follows finalized blocks and shard chunks, checks them, stores per-FID message state, archives the raw bytes, and serves `info`, `castsByFid`, and `userDataByFid`.

## License

GPL-3.0-only, the same license as Hypersnap. Hypersnap is GPL-3.0. The `.proto` files descend from Snapchain (MIT) and were taken from Hypersnap; MIT allows redistributing them inside a GPL work. Apache-2.0 was not used because it is incompatible with GPL-3.0. See `LICENSE` and `proto/NOTICE`.

## Architecture

```
public HTTPS nodes
  HTTP JSON  /v1/info, /v1/events     (haatz.quilibrium.com)
  gRPC HTTP/2 HubService              (snap.farcaster.xyz:3383)
        |
        v
Epoch0Adapter  ----failover---->  another upstream
        |
        v
verify (header hash, commits, parent, message signatures)
        |
        +--> per-FID state (local SQLite, or one Durable Object per FID)
        +--> raw block archive (filesystem, or R2)
        |
        v
/v1/info  /v1/castsByFid  /v1/userDataByFid
```

The follower is read-only. It does not gossip, vote, or hold validator keys. A full validator needs UDP/QUIC and cannot run on Cloudflare, so v2 starts as a follower of already-finalized units.

Two storage backends share one SQL schema (`src/state/sql.ts`):

- `LocalStore` uses Node's `node:sqlite`. This is the home-PC and test backend.
- `FidStateDurableObject` is one Cloudflare Durable Object with SQLite storage per FID. `FollowerDurableObject` keeps cursors and counters and is what the cron trigger calls.

Raw blocks go through `BlockArchive`. Tests use an in-memory map and a local directory. The Worker binding is R2 (`BLOCK_ARCHIVE`). Nothing in this repo creates that bucket.

## Chain adapter

Epoch 0 is the current Hypersnap mode: nodes are read nodes of Snapchain-certified blocks. That assumption lives only in `Epoch0Adapter`.

- Info and the cross-check oracle are plain HTTPS JSON (`/v1/info`, `/v1/events`).
- Blocks and shard chunks are HubService gRPC over HTTPS HTTP/2 (`GetBlocks`, `GetShardChunks`). Hypersnap's HTTP router does not expose `/v1/blocks`. The public Hypersnap HTTP node at `haatz.quilibrium.com` answers info and events; its gRPC port does not serve these methods, so the follower fails over.
- Default order is haatz, then `https://snap.farcaster.xyz:3383`. snap.farcaster.xyz is a Snapchain-line read node of the same epoch-0 chain (the heights and validator commits match). An upstream that errors or returns bytes that fail verification is skipped.
- The server treats `stop_block_number` as an exclusive key. The adapter adds one so callers pass an inclusive stop.

`PostPivotAdapter` is the slot for a later Hypersnap chain or proof-of-work pivot (FIP #19, Hypersnap PRs #28 and #34). It throws. Plugging that in means a new adapter behind the same `ChainAdapter` interface. The verifier, store, and read API stay put.

Shard 0 is the block shard (`GetBlocks`). Shards 1 and 2 are message shards (`GetShardChunks`). The default follow set is shards 0 and 2. Heights are independent.

## Compatibility

Served responses follow the Hypersnap v1 JSON shapes for:

| Endpoint | Notes |
| --- | --- |
| `GET /v1/info` | `dbStats`, `numShards`, `shardInfos`, `version`, `peer_id`, `nextEngineVersionTimestamp`. Counts are this follower's local state, not the upstream node's totals. `peer_id` is `hypersnap-v2`. `numFidRegistrations` is distinct FIDs seen, not IdRegistry registrations. |
| `GET /v1/castsByFid` | `{ messages, nextPageToken? }`. Includes cast adds and cast removes. A removed cast add is hidden; the remove message stays. Default order is ascending timestamp, then hash. `pageSize` defaults to 100 and caps at 1000. `page_size` and `page_token` are accepted. |
| `GET /v1/userDataByFid` | Same page shape. One row per user-data type; a newer add replaces the older one. |

A missing `fid` is HTTP 400 with `Content-Type: text/plain` and this body:

```
Invalid query parameters: missing field `fid`
```

Message JSON uses the v1 names: `hashScheme` `HASH_SCHEME_BLAKE3`, `signatureScheme` `SIGNATURE_SCHEME_ED25519`, `network` `FARCASTER_NETWORK_MAINNET`, hash and signer as `0x` hex, signature as standard base64. Cast adds include both `parentCastId` and `parentUrl` (the unused one is null). Cast-remove `targetHash` is base64.

Page tokens are opaque base64url of `timestamp\nhash`. They are not interchangeable with Hypersnap v1 tokens.

Other user messages (reactions, links) are stored in the same table and are not returned by these two routes. The rest of the v1 HTTP surface is not implemented (`/v1/events`, reactions, links, casts by parent, storage limits, submit, sync, and so on).

## What is verified

For every block and shard chunk, before it is applied:

- Header hash: blake3 of the exact header protobuf bytes equals the embedded 32-byte hash. Nested bytes are hashed as they arrived. They are not re-encoded.
- Shard chunk hash is blake3 of the exact `ShardHeader` bytes, same as a block header.
- Block witness hash: blake3 of the exact `ShardWitness` equals `header.shard_witnesses_hash`.
- Block event hash: each event hash is blake3 of its `BlockEventData`. `events_hash` is blake3 of those hashes concatenated. No events means an empty `events_hash`, not the hash of empty input.
- Parent link: height 1 must use the block genesis text or the shard genesis bytes `0x0020`. Later heights must match the previous unit when this process has one. The first unit of a mid-chain range is a checkpoint: its parent is recorded and not independently proven.
- Chain id must be 1 on blocks. Header version is recorded (observed as 13) and not checked against the engine schedule.
- Commits: each signature is ed25519 (RFC 8032, `zip215: false`, matching dalek `verify_strict`) over the prost encoding of a precommit `Vote` (type, height bytes, round if non-zero, `ShardHash` bytes, voter pubkey). The signer must be in the validator set for that shard and height. Signers must be unique. Quorum is malachite's rule, `weight * 3 > total * 2`, with weight 1. At current height that set has 7 validators, so 5 signatures are enough.
- User messages inside transactions: hash is blake3(data_bytes) truncated to 20 bytes, signature is ed25519 over that hash, schemes must be blake3 and ed25519, and the message FID must match the transaction FID. A bad user message is dropped and counted. It does not fail the block.
- HTTP oracle: when `/v1/events` has a `BLOCK_CONFIRMED` for that height, its `blockHash` must equal the hash we computed. A missing event is not a failure (the page is only the recent tip). An oracle HTTP failure is recorded as skipped; the signatures still have to check. A hash mismatch fails that upstream and failover continues. Public nodes return HTTP 400 `Shard not found` for `/v1/events?shard_index=0`, so the block shard's oracle check is skipped. Message shards 1 and 2 do return `BLOCK_CONFIRMED` events and are cross-checked.

The epoch-0 validator history is the Snapchain mainnet `validators.toml` (vendored in `config/validators.toml`). Hypersnap's own file is missing set v18 (moria and isengard, effective at heights 48,632,000 / 49,147,000 / 49,311,000), and current blocks are signed by that set. The runtime copy is `src/generated/validators.json`.

### Not verified yet

- Shard `state_root` and per-FID account roots. Those are a Merkle trie over the full history. The observed root is 20 bytes, not 32, and it cannot be recomputed from one chunk.
- User-message inclusion. The signed hash covers the header only, and the header commits to `shard_root`, which we do not recompute. A bad upstream can omit a real message or insert an extra message that has a valid user signature. Messages that fail their own hash, signature, or FID check are still rejected.
- Signer registration for the FID, storage limits, and on-chain event authenticity against Ethereum.
- The full engine protocol-version schedule. Only `chain_id == 1` is enforced.
- That every historical parent back to genesis has been seen. Sync starts at the recent tip.

## Run locally

Node 22 or newer.

```bash
npm install
npm test
npm run follow -- --max 4
npm run serve
```

`npm run follow` reads a short inclusive window (default 4 units per shard, lag 2 so the HTTP oracle has usually seen the height) from the public nodes, verifies each unit, writes `data/state.sqlite`, and archives raw bytes under `data/archive`. Override with `HYPERSNAP_DATA_DIR`, `HYPERSNAP_SHARDS` (comma-separated), and `HYPERSNAP_ORACLE`.

`npm run serve` listens on `PORT` (default 8787) and answers the three read routes from that sqlite file.

`npm run record-fixtures` refreshes `test/fixtures` from the public gRPC node. Tests do not use the network. They replay those fixtures.

## Home PC

The same two commands are the home-PC node. No Cloudflare account, no Durable Objects, no R2. State is one sqlite file. The archive is a directory of `.pb` files (`blocks/shard-0/<height>.pb`, `chunks/shard-2/<height>.pb`). Point `HYPERSNAP_DATA_DIR` at a disk you want to keep. This milestone follows the tip only. It does not backfill the full history, so disk use stays small.

## Cloudflare

`wrangler.jsonc` is the Worker entry. `src/worker.ts` exports the fetch handler and a cron (`*/1 * * * *`) that calls `FollowerDurableObject.tick()`. Each tick follows at most `MAX_PER_SHARD` units (default 2) on shards `0,2`, using the same verifier and failover list. Bindings:

- `FOLLOWER` and `FID_STATE`: SQLite Durable Objects
- `BLOCK_ARCHIVE`: R2 bucket name `hypersnap-v2-blocks` (declared only)

Do not deploy this from a checkout that should not spend Cloudflare credits. `wrangler deploy` and any command that creates the bucket or the Worker are out of scope. `npx wrangler types` only writes `src/generated/worker-configuration.d.ts`.

`compatibility_date` is `2026-10-23`, with `nodejs_compat`. Observability logs and traces are enabled in the config.

## Open limits

- Tip follower, not a full historical sync. No trie, so no state-root proof and no cryptographic message inclusion.
- No gossip, no consensus, no keys, no write API.
- Durable Object fanout is one RPC per FID per batch. A chunk with many FIDs does that many storage calls. Cron batches stay small on purpose.
- Hypersnap HTTP does not serve blocks. Epoch 0 block bytes come from HubService gRPC on a node of the same certified chain.
- Page tokens differ from v1. `dbStats` describe local follower state.
- Shard 1 is supported by the same chunk path and is not in the default shard list.
- Replaying a unit increments the follower meta counters. The local read API uses `COUNT(*)` for `dbStats`. The Worker info endpoint uses the meta counters.
