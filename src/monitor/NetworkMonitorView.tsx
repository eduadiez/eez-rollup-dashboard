import { memo, useEffect, useRef } from "react";
import { mountMonitor } from "./client.js";
import pageStyles from "../App.module.css";
import "./monitor.css";

// The telemetry renderer owns the panels' contents; React owns their lifecycle.
// Memoization keeps dashboard health updates from replacing active inputs.
export const NetworkMonitorView = memo(function NetworkMonitorView() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (root.current) return mountMonitor(root.current);
  }, []);

  return (
    <main id="main" tabIndex={-1} ref={root} className={`${pageStyles.page} eez-monitor`}>
<div className="monitor-toolbar"><div><p className="eez-eyebrow">[ NETWORK MONITOR ]</p><h1 className="eez-page-heading"><strong>Two chains.</strong> One network.</h1><p className="eez-description">L1 and L2 activity, settlements, and cross-chain commitments.</p></div><div className="live-controls"><span id="network-status" className="status-pill loading" role="status">Connecting</span></div></div>
<div className="monitor-meta"><span id="last-update" className="muted">Waiting for network data</span><nav id="resource-links" className="resource-links" aria-label="Network explorers"></nav></div>
<aside id="composer-rpc" className="composer-rpc" aria-label="Composer RPC endpoints"></aside>

        <section className="panel settlement-policy" aria-labelledby="settlement-heading">
          <div className="panel-heading">
            <div><p className="eyebrow">[ SETTLEMENT POLICY ]</p><h2 id="settlement-heading">Settlement policy</h2></div>
            <span id="policy-status" className="status-pill loading"><i></i>Loading</span>
          </div>
          <div id="policy-rules" className="policy-rules"><p className="muted">Loading configured rules…</p></div>
          <div id="policy-progress" className="policy-progress"><p className="muted">Waiting for canonical settlement data…</p></div>
          <div id="latest-settlement" className="latest-settlement"></div>
        </section>
        <section className="hero-grid" aria-label="Network summary">
          <article className="chain-card l1-card">
            <div className="card-heading">
              <div><p className="eyebrow">[ CANONICAL SETTLEMENT ]</p><h2>L1</h2></div>
              <span id="l1-chain-id" className="chain-id">—</span>
            </div>
            <div className="head-number"><span>#</span><strong id="l1-latest">—</strong></div>
            <p className="head-hash mono" id="l1-hash">—</p>
            <p className="muted" id="l1-freshness">Block age unavailable</p>
            <div className="head-row">
              <div><small>SAFE</small><b id="l1-safe">—</b></div>
              <div><small>FINALIZED</small><b id="l1-finalized">—</b></div>
              <div><small>PEERS</small><b id="l1-peers">—</b></div>
            </div>
          </article>

          <article className="chain-card l2-card">
            <div className="card-heading">
              <div><p className="eyebrow">[ SYNCHRONOUS EXECUTION ]</p><h2>L2</h2></div>
              <span id="l2-chain-id" className="chain-id">—</span>
            </div>
            <div className="head-number"><span>#</span><strong id="l2-latest">—</strong></div>
            <p className="head-hash mono" id="l2-hash">—</p>
            <p className="muted" id="l2-freshness">Block age unavailable</p>
            <div className="head-row">
              <div><small>SAFE</small><b id="l2-safe">—</b></div>
              <div><small>FINALIZED</small><b id="l2-finalized">—</b></div>
              <div><small>UNSETTLED L2</small><b id="l2-lag">—</b></div>
            </div>
          </article>

          <article className="commit-card">
            <div className="card-heading">
              <div><p className="eyebrow">[ L1 ↔ L2 INVARIANT ]</p><h2>Commitment</h2></div>
              <span id="commit-status" className="status-pill loading"><i></i> Unknown</span>
            </div>
            <div className="commit-visual"><span>L1 registry</span><i></i><span>L2 canonical block</span></div>
            <dl>
              <div><dt>Registry root</dt><dd id="registry-root" className="mono">—</dd></div>
              <div><dt>Committed L2</dt><dd id="committed-block" className="mono">—</dd></div>
              <div><dt>Safe L2</dt><dd id="safe-root" className="mono">—</dd></div>
              <div><dt>Escrow</dt><dd id="escrow">—</dd></div>
            </dl>
          </article>
        </section>

        <section className="metric-strip" aria-label="Settlement metrics">
          <div><p>Protocol posts</p><strong id="protocol-batches">—</strong><small id="history-scope">recent settlement history</small></div>
          <div><p>Last interval</p><strong id="settlement-interval" className="metric-duration">—</strong><small>between L1 posts</small></div>
          <div><p>Blobs posted</p><strong id="blob-count">—</strong><small>in the displayed history</small></div>
          <div className="cost-metric"><p>Last post cost</p><strong id="latest-post-cost">—</strong><small>execution + blob fee</small></div>
          <div><p>Finality lag</p><strong id="finality-lag">—</strong><small>L2 blocks</small></div>
        </section>

        <section className="panel blob-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">[ DATA AVAILABILITY ]</p><h2>Recent blob settlements</h2></div>
            <div className="blob-heading-actions">
              <form id="blob-search-form" className="blob-search-form">
                <label className="blob-search"><span>Find settlement</span><span className="search-field"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input id="blob-search" type="search" autoComplete="off" spellCheck={false} aria-keyshortcuts="/" placeholder="L1:5433, L2:32592, or tx/blob hash" /><kbd aria-hidden="true">/</kbd></span></label>
                <button id="blob-search-submit" className="btn btn-solid small-action" type="submit">Search history</button>
                <button id="blob-search-clear" className="btn btn-outline small-action" type="button">Clear</button>
              </form>
              <p id="window-label" className="muted">Scanning recent L1 blocks</p>
              <p id="blob-search-status" className="blob-search-status muted">Type to filter the recent window; exact block numbers and full hashes search history automatically.</p>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>L1 block</th><th>Posting transaction</th><th>Blobs</th><th>Beacon</th><th>L2 range</th><th>Post tx cost</th><th>Result</th><th>Inspect</th></tr></thead>
              <tbody id="blob-rows"><tr><td colSpan={8} className="empty">Loading settlement history…</td></tr></tbody>
            </table>
          </div>
          <p className="muted settlement-cost-note">Receipt costs include this posting transaction’s execution and blobs. Companion transactions and builder payments are separate.</p>
        </section>

        <section className="panel decoder-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">[ PROTOCOL PAYLOAD ]</p><h2>EEZ blob decoder</h2></div>
            <p className="muted">Strict native semantic-stream decoding</p>
          </div>
          <form id="decoder-form">
            <label className="selector-input"><span>L1 blob transaction hash</span><input id="decoder-transaction" required autoComplete="off" spellCheck={false} placeholder="0x…" /></label>
            <button className="btn btn-solid btn-lg" type="submit">Decode transaction</button>
          </form>
          <details className="codec-guide">
            <summary>How ChainOperation is encoded</summary>
            <div className="codec-guide-body">
              <p className="guide-intro">A settlement has three encoding layers. Open each result's byte-layout explanation below to see the concrete sizes and values for that transaction.</p>
              <ol className="codec-layers">
                <li>
                  <h3>Ethereum blob packing</h3>
                  <p>The L1 type-3 transaction commits to one or more blobs by versioned hash. Each 131,072-byte blob contains 4,096 field elements. EEZ requires the most-significant byte of every 32-byte element to be zero and stores 31 logical bytes in the remaining bytes, in reverse order. That gives 126,976 logical bytes per blob.</p>
                </li>
                <li>
                  <h3>EEZ version-0 message envelope</h3>
                  <div className="wire-layout mono"><span>00</span><i>version</i><span>02</span><i>ChainOperation</i><span>chain_id</span><i>u64 little-endian</i><span>length</span><i>base-128 u32 varint</i><span>operations</span><i>payload bytes</i><span>01</span><i>CloseBlobStream</i><span>00…</span><i>padding</i></div>
                  <p>The native profile accepts one <code>ChainOperation</code> for synchronization, followed by complete <code>InitiateCrossChainTransaction</code> brackets containing <code>Call</code>, <code>StaticCall</code>, returns, and optional <code>Snapshot</code>/<code>Revert</code> regions. One <code>CloseBlobStream</code> ends meaningful bytes; all remaining blob bytes must be zero.</p>
                </li>
                <li>
                  <h3>Cross-chain semantics</h3>
                  <p>These are separate envelope messages after <code>ChainOperation</code>, not fields inside <code>ChainOperation.operations</code>. Each semantic transaction names its origin chain and carries opaque chain-defined <code>tx_data</code>. Calls encode the destination chain, source and target addresses, value for mutable calls, zero gas in this deployment, and exact calldata. <code>ReturnSuccess</code>/<code>ReturnFail</code> carry exact result bytes. The context stack derives every call's source chain.</p>
                  <div className="table-scroll"><table className="semantic-wire"><thead><tr><th>Byte / message</th><th>Wire fields</th><th>Meaning</th></tr></thead><tbody>
                    <tr><td><code>0x03</code> Initiate</td><td><code>origin_chain:u64 LE · len:varint · tx_data</code></td><td>Starts one originating cross-chain transaction.</td></tr>
                    <tr><td><code>0x04</code> Call</td><td><code>to_chain · from · to · value:u256 LE · gas · len · data</code></td><td>Opens a mutable nested call.</td></tr>
                    <tr><td><code>0x05</code> StaticCall</td><td><code>to_chain · from · to · gas · len · data</code></td><td>Opens a read-only nested call; no value field.</td></tr>
                    <tr><td><code>0x06/07</code> Return</td><td><code>len:varint · return_data</code></td><td>Closes the most recent call with success or failure.</td></tr>
                    <tr><td><code>0x08/09</code> Snapshot/Revert</td><td>no payload</td><td>Brackets a non-empty contiguous call region whose state effects are forcibly rolled back.</td></tr>
                    <tr><td><code>0x0a</code> Finish</td><td>no payload</td><td>Closes the semantic transaction after all calls and snapshots close.</td></tr>
                  </tbody></table></div>
                  <p>A failed return and a forced rollback are different facts: <code>ReturnFail</code> records one call's result, while <code>Snapshot … Revert</code> marks the whole enclosed call span as rolled back. The result view exposes both independently.</p>
                </li>
                <li>
                  <h3>Tagged operation payload</h3>
                  <p>The first operation byte selects an RLP body:</p>
                  <div className="table-scroll"><table className="codec-tags"><thead><tr><th>Tag</th><th>Format</th><th>RLP body</th></tr></thead><tbody>
                    <tr><td><code>0x00</code></td><td>Legacy calldata</td><td><code>[blockTxCounts, transactions, l2Entries]</code></td></tr>
                    <tr><td><code>0x01</code></td><td>Grouped calldata</td><td><code>[blockTxCounts, transactions, l2Entries, outboundGroupSizes]</code></td></tr>
                    <tr><td><code>0x02</code></td><td>Self-contained blocks</td><td><code>[blocks, l2Entries, outboundGroupSizes]</code></td></tr>
                    <tr><td><code>0x03</code></td><td>Derivable ordinary blocks</td><td><code>[profileId, ordinaryBlockCount, environment, records, terminalBlock, l2Entries, outboundGroupSizes]</code></td></tr>
                  </tbody></table></div>
                  <p>Tag <code>0x03</code>, profile 1, stores ordinary blocks as sparse transaction and environment records; gaps represent empty blocks. Full exceptions and the terminal block retain their headers. Reconstructing omitted headers requires execution replay.</p>
                  <p>For tag <code>0x02</code>, every element in <code>blocks</code> is a complete canonical block RLP carrying the header, transactions, ommers, and applicable body fields. The decoder derives transaction counts from those bodies. <code>l2Entries</code> carries ABI-encoded execution entries needed for reconstruction; <code>outboundGroupSizes</code> records how many source roots each outbound user transaction consumes.</p>
                </li>
              </ol>
              <aside><strong>Evidence boundary.</strong> The monitor validates bounded parsing and structural invariants. It does not replace KZG proof checks, beacon-sidecar verification, canonical block-hash linkage, or state-transition verification performed by the protocol tooling.</aside>
            </div>
          </details>
          <div id="decoder-result" className="decoder-result"><p className="muted">Choose Decode on a recent EEZ settlement, or paste its L1 transaction hash.</p></div>
          <p className="decoder-boundary">The decoder validates the blob envelope and payload structure. Cryptographic KZG and state-transition verification remain protocol responsibilities.</p>
        </section>

        <section className="blocks-grid">
          <article className="panel">
            <div className="panel-heading"><div><p className="eyebrow">[ SETTLEMENT CHAIN ]</p><h2>Latest L1 blocks</h2></div></div>
            <div className="table-scroll compact-table recent-block-scroll" tabIndex={0} role="region" aria-label="Latest L1 blocks">
              <table><thead><tr><th>Block</th><th>Age</th><th>Txs</th><th>Blobs</th><th>Gas</th></tr></thead><tbody id="l1-blocks"></tbody></table>
            </div>
          </article>
          <article className="panel">
            <div className="panel-heading"><div><p className="eyebrow">[ EXECUTION CHAIN ]</p><h2>Latest L2 blocks</h2></div></div>
            <div className="table-scroll compact-table recent-block-scroll" tabIndex={0} role="region" aria-label="Latest L2 blocks">
              <table className="l2-block-table"><thead><tr><th>Block</th><th>Age</th><th>Txs</th><th>Gas</th><th>Hash</th></tr></thead><tbody id="l2-blocks"></tbody></table>
            </div>
          </article>
        </section>

        <section className="panel correlation-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">[ CANONICAL INDEX ]</p><h2>Settlement correlation</h2></div>
            <p className="muted">Resolve exact relationships in either direction</p>
          </div>
          <form id="correlation-form">
            <label><span>Direction</span><select id="correlation-direction"><option value="l2-to-l1">L2 block → L1 settlement</option><option value="l1-to-l2">L1 block → L2 ranges</option></select></label>
            <label className="selector-input"><span>Block number or hash</span><input id="correlation-block" required autoComplete="off" spellCheck={false} placeholder="e.g. 15834 or 0x3dda" /></label>
            <button className="btn btn-solid btn-lg" type="submit">Resolve</button>
          </form>
          <div id="correlation-result" className="correlation-result"><p className="muted">Enter a canonical block number or hash.</p></div>
        </section>

        <section id="error-panel" className="panel error-panel hidden">
          <div className="panel-heading"><div><p className="eyebrow">[ PARTIAL DATA ]</p><h2>Collector warnings</h2></div></div>
          <ul id="errors"></ul>
        </section>
      <p id="duration" className="muted"></p>
    </main>
  );
});
