export function mountMonitor(root) {
const listeners = [];
function listen(element, type, handler) {
  element.addEventListener?.(type, handler);
  listeners.push([element, type, handler]);
}
const byId = (id) => root.querySelector(`[id="${id}"]`);
const state = {
  loading: false,
  timer: null,
  socket: null,
  reconnectTimer: null,
  liveTimer: null,
  ageTimer: null,
  reconnectDelay: 1000,
  pollMilliseconds: 5000,
  revision: 0,
  stopped: false,
  snapshot: null,
  heads: {},
  headHistory: {},
  pendingChains: {},
  blobQuery: "",
  settlementLookup: null,
  settlementSearchLoading: false,
  settlementSearchTimer: null,
  settlementSearchRequest: 0,
};

function h(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function apiUrl(path) {
  return new URL(`/monitor/${path}`, window.location.origin);
}

function compactHash(value, front = 8, back = 6) {
  if (!value) return "—";
  return value.length > front + back + 1 ? `${value.slice(0, front)}…${value.slice(-back)}` : value;
}

function number(value) {
  return value === null || value === undefined ? "—" : Number(value).toLocaleString();
}

function age(timestamp) {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function percent(used, limit) {
  if (!limit) return "—";
  return `${((used || 0) * 100 / limit).toFixed(1)}%`;
}

function formatEth(wei) {
  if (wei === null || wei === undefined) return "—";
  if (typeof wei === "number" && !Number.isSafeInteger(wei)) return "—";
  const raw = BigInt(wei);
  if (raw < 0n) return "—";
  const whole = raw / 1000000000000000000n;
  const fraction = (raw % 1000000000000000000n).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  const symbol = state.snapshot?.configuration?.nativeCurrency || "ETH";
  if (raw > 0n && whole === 0n && !fraction) return `<0.00000001 ${symbol}`;
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} ${symbol}`;
}

function duration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "—";
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
  return `${Math.floor(seconds / 3600)} h${seconds % 3600 ? ` ${Math.floor(seconds % 3600 / 60)} min` : ""}`;
}

function renderSettlementPolicy(snapshot) {
  const policy = snapshot.configuration?.settlementPolicy;
  const progress = snapshot.settlementProgress;
  const history = snapshot.settlementHistory;
  if (!policy?.enabled) {
    setStatus(byId("policy-status"), "loading", policy ? "Legacy mode" : "Not supplied");
    setHtml("policy-rules", `<p class="muted">${policy ? "The configurable settlement policy is disabled." : "The monitor has not been supplied with the node’s settlement policy."}</p>`);
    setHtml("policy-progress", `<p class="muted">Canonical posts and commitment checks remain available below.</p>`);
  } else {
    const cadence = policy.nominalGeneralIntervalMs === null ? `${number(policy.maxUnsettledL2Blocks)} blocks` : duration(policy.nominalGeneralIntervalMs);
    const pure = policy.pureL2Mode === "always" ? "Always" : duration(policy.pureL2IntervalMs);
    setHtml("policy-rules", `<div><p>General consolidation</p><strong>${h(cadence)}</strong><small>${number(policy.maxUnsettledL2Blocks)} L2 blocks · including empty history</small></div>
      <div><p>Pure L2 transactions</p><strong>${h(pure)}</strong><small>${policy.pureL2Mode === "always" ? "Next eligible L1 opportunity, including reverted transactions" : "If transactions are pending; the earlier general rule still applies"}</small></div>
      <div><p>Cross-chain transactions</p><strong>Always</strong><small>Valid cross-chain work triggers posting; empty Sync blocks do not</small></div>`);
    const usable = progress?.available && !snapshot.stale;
    setStatus(byId("policy-status"), usable && !progress.generalThresholdReached ? "" : "loading",
      !usable ? "Awaiting data" : progress.generalThresholdReached ? "Threshold reached" : "Accumulating");
    if (usable) {
      const limit = policy.maxUnsettledL2Blocks;
      const explanation = progress.generalThresholdReached
        ? "The general threshold is reached. Waiting for canonical L1 inclusion."
        : `${number(progress.remainingL2Blocks)} L2 blocks to the general threshold${progress.estimatedGeneralRemainingMs !== null ? ` · approximately ${h(duration(progress.estimatedGeneralRemainingMs))}` : ""}.`;
      setHtml("policy-progress", `<div class="progress-heading"><span>Unsettled history</span><strong>${number(progress.unsettledL2Blocks)} <span>/ ${number(limit)} L2 blocks</span></strong></div>
        <progress value="${Math.min(progress.unsettledL2Blocks, limit)}" max="${limit}" aria-label="L2 blocks toward the general settlement threshold"></progress>
        <p>${explanation} Transaction activity can settle earlier.</p>`);
    } else {
      setHtml("policy-progress", `<p class="muted">${snapshot.stale ? "Snapshot is stale. Waiting for fresh chain data." : "Waiting for the canonical L1 commitment and current L2 head."}</p>`);
    }
    const fullness = policy.blobFullnessBps === null ? "off" : `${policy.blobFullnessBps / 100}% across all permitted blobs`;
    byId("policy-progress").innerHTML += `<p class="policy-source">Configured rules · fullness trigger ${h(fullness)}. Timing is an estimate from the configured L2 cadence; inclusion depends on L1.</p>`;
  }
  const last = history?.available ? snapshot.blobSettlements?.find((item) => item.isProtocolSettlement && item.receiptStatus === 1) : null;
  const explorers = snapshot.configuration?.explorers || {};
  setHtml("latest-settlement", last ? `<div><small>Last canonical post</small><strong>${age(last.timestamp)} ago</strong><span>${transactionLink(explorers.l1, last.transactionHash)}</span></div>
    <div><small>L1 inclusion</small><strong>${blockLink(explorers.l1, last.l1BlockNumber, `#${number(last.l1BlockNumber)}`)}</strong><span>${h(new Date(last.timestamp * 1000).toLocaleString())}</span></div>
    <div><small>Posted L2 range</small>${rangeText(last.l2Ranges)}</div>
    <div><small>Data availability</small><strong>${number(last.blobCount)} ${last.blobCount === 1 ? "blob" : "blobs"}</strong><span>${last.beacon?.available ? "Full bytes available on Beacon" : "Beacon availability not confirmed"}</span></div>`
    : `<p class="muted">${history?.available ? "No canonical posts found in the configured history window." : "Settlement history is unavailable. See collector warnings or configure the registry."}</p>`);
}

function setText(id, value) { byId(id).textContent = value ?? "—"; }
function setHtml(id, value) { byId(id).innerHTML = value ?? "—"; }

function explorerHref(base, path = "") {
  if (!base) return null;
  try {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${String(path).replace(/^\//, "")}`;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function explorerLink(base, path, label, className = "", title = null) {
  const href = explorerHref(base, path);
  if (!href) return `<span class="${h(className)}">${h(label)}</span>`;
  return `<a class="${h(className)}" href="${h(href)}" title="${h(title ?? label)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>`;
}

function blockLink(base, selector, label, className = "") {
  if (selector === null || selector === undefined || selector === "") return `<span class="${h(className)}">—</span>`;
  return explorerLink(base, `block/${selector}`, label, className, String(selector));
}

function blockHashLink(base, hash, className = "mono hash explorer-value") {
  if (!hash) return `<span class="${h(className)}">—</span>`;
  return explorerLink(base, `block/${hash}`, compactHash(hash), className, hash);
}

function transactionLink(base, hash, className = "mono hash explorer-value") {
  if (!hash) return `<span class="${h(className)}">—</span>`;
  return explorerLink(base, `tx/${hash}`, compactHash(hash), className, hash);
}

function renderResourceLinks(explorers = {}) {
  const resources = [
    ["L1 Blockscout", explorers.l1],
    ["L2 Blockscout", explorers.l2],
    ["Blobscan", explorers.blobscan],
  ];
  const container = byId("resource-links");
  container.replaceChildren();
  for (const [label, url] of resources) {
    const href = explorerHref(url);
    if (!href) continue;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = label;
    container.append(anchor);
  }
}

function renderComposerRpc(endpoints = {}, chains = {}) {
  const routes = [
    { direction: "L1 → L2", source: "L1", chainId: chains.l1, url: endpoints.l1ToL2 },
    { direction: "L2 → L1", source: "L2", chainId: chains.l2, url: endpoints.l2ToL1 },
  ];
  const available = routes.filter((route) => route.url);
  const container = byId("composer-rpc");
  if (!available.length) {
    container.innerHTML = `<div><p class="eyebrow">COMPOSER RPC</p><span class="muted">Public transaction fronts are not configured.</span></div>`;
    return;
  }
  container.innerHTML = `<div class="composer-rpc-heading">
      <p class="eyebrow">COMPOSER RPC</p>
      <span>Submit signed cross-chain transactions through the source-chain front. Use the ordinary RPC endpoints for reads.</span>
    </div>
    <div class="composer-rpc-routes">${available.map((route) => `<div class="composer-rpc-route">
      <span class="composer-direction">${h(route.direction)}</span>
      <code title="${h(route.url)}">${h(route.url)}</code>
      <span class="composer-chain">${h(route.source)} chain ${h(route.chainId ?? "—")}</span>
      <button class="btn btn-sm btn-outline" type="button" data-copy-rpc="${h(route.url)}" aria-label="Copy ${h(route.direction)} Composer RPC URL">Copy</button>
    </div>`).join("")}</div>`;
}

function setStatus(element, kind, label) {
  element.className = `status-pill ${kind || ""}`.trim();
  element.innerHTML = `<i></i>${label}`;
}

function renderChain(name, chain) {
  const prefix = name.toLowerCase();
  const base = state.snapshot?.configuration?.explorers?.[prefix];
  setText(`${prefix}-chain-id`, chain?.chainId !== undefined ? `chain ${chain.chainId}` : "offline");
  setHtml(`${prefix}-latest`, blockLink(base, chain?.latest?.number, number(chain?.latest?.number), "explorer-value"));
  setHtml(`${prefix}-hash`, chain?.latest?.hash
    ? explorerLink(base, `block/${chain.latest.hash}`, chain.latest.hash, "explorer-value", chain.latest.hash)
    : "—");
  setHtml(`${prefix}-safe`, blockLink(base, chain?.safe?.number, number(chain?.safe?.number), "explorer-value"));
  setHtml(`${prefix}-finalized`, blockLink(base, chain?.finalized?.number, number(chain?.finalized?.number), "explorer-value"));
  renderHeadAge(prefix, chain);
  if (prefix === "l1") setText("l1-peers", number(chain?.peerCount));
}

function renderHeadAge(name, chain) {
  const timestamp = chain?.latest?.timestamp;
  const seconds = Number.isSafeInteger(timestamp)
    ? Math.max(0, Math.floor(Date.now() / 1000) - timestamp) : chain?.freshness?.ageSeconds;
  const warning = chain?.freshness?.warningSeconds || state.snapshot?.configuration?.headDelayWarningSeconds || 30;
  setText(`${name}-freshness`, seconds != null
    ? `Latest block ${duration(seconds * 1000)} ago${seconds > warning ? " · Head delayed" : ""}`
    : "Block age unavailable");
}

function startAgeClock() {
  clearTimeout(state.ageTimer);
  if (state.stopped) return;
  for (const name of ["l1", "l2"]) renderHeadAge(name, state.snapshot?.chains?.[name]);
  // Update only age text, preserving row elements, focus and scroll position.
  for (const cell of root.querySelectorAll?.("[data-block-timestamp]") || []) {
    cell.textContent = age(Number(cell.dataset.blockTimestamp));
  }
  state.ageTimer = setTimeout(startAgeClock, 1000);
}

function blockWindow(snapshot, name) {
  return snapshot.configuration?.recentBlockWindows?.[name]
    || snapshot.configuration?.recentBlockWindow || (name === "l2" ? 100 : 20);
}

function isSyncBlock(block) {
  const interval = state.snapshot?.configuration?.syncSlotSeconds;
  const anchor = state.snapshot?.chains?.l1?.latest?.timestamp;
  if (!Number.isInteger(interval) || interval <= 0 || !Number.isSafeInteger(anchor)
      || !Number.isSafeInteger(block.timestamp) || !(block.number > 0)) return false;
  if ((block.timestamp - anchor) % interval !== 0) return false;
  return true;
}

function blockRows(blocks, chain) {
  if (!blocks?.length) return `<tr><td colspan="5" class="empty">No block data</td></tr>`;
  const explorers = state.snapshot?.configuration?.explorers || {};
  const base = chain === "l1" ? explorers.l1 : explorers.l2;
  return blocks.map((block) => {
    if (chain === "l1") {
      return `<tr>
        <td>${blockLink(base, block.number, `#${number(block.number)}`, "primary mono explorer-value")}${blockHashLink(base, block.hash, "secondary mono hash explorer-value")}</td>
        <td data-block-timestamp="${h(block.timestamp)}">${age(block.timestamp)}</td><td>${block.transactionCount == null ? '<span class="block-pending" title="Fetching transaction count">Pending</span>' : number(block.transactionCount)}</td>
        <td>${block.blobTransactionCount ? `<span class="badge good">${block.blobTransactionCount} tx</span>` : "—"}</td>
        <td>${percent(block.gasUsed, block.gasLimit)}</td></tr>`;
    }
    return `<tr${isSyncBlock(block) ? ' class="sync-block-row" aria-label="Sync block" title="Sync slot on the configured L1-anchored schedule; may be empty or unsettled"' : ""}>
      <td>${explorerLink(base, `block/${block.number}`, `#${number(block.number)}`, "primary mono explorer-value")}</td><td data-block-timestamp="${h(block.timestamp)}">${age(block.timestamp)}</td>
      <td>${block.transactionCount == null ? '<span class="block-pending" title="Fetching transaction count">Pending</span>' : number(block.transactionCount)}</td><td>${percent(block.gasUsed, block.gasLimit)}</td>
      <td>${blockHashLink(base, block.hash)}</td></tr>`;
  }).join("");
}

function rangeText(ranges) {
  if (!ranges?.length) return `<span class="muted">Not indexed</span>`;
  const l2Explorer = state.snapshot?.configuration?.explorers?.l2;
  return ranges.map((item) => {
    const range = item.l2Range || {};
    const first = parseInt(range.firstBlockNumber || "0", 16);
    const last = parseInt(range.lastBlockNumber || "0", 16);
    const finality = item.l2Finalized ? "finalized" : item.canonicalL2 ? "canonical" : "non-canonical";
    const firstLink = blockLink(l2Explorer, first, `#${number(first)}`, "explorer-value");
    const lastLink = blockLink(l2Explorer, last, `#${number(last)}`, "explorer-value");
    return `<span class="primary mono">${firstLink} → ${lastLink}</span><span class="secondary">${number(parseInt(range.blockCount || "0", 16))} blocks · ${finality}</span>`;
  }).join("");
}

function searchQuantity(value) {
  const text = String(value ?? "").trim().replace(/^#/, "");
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) return null;
  try {
    return BigInt(text);
  } catch (_) {
    return null;
  }
}

function settlementMatches(item, rawQuery) {
  const query = String(rawQuery ?? "").trim().toLowerCase();
  if (!query) return true;
  const scoped = query.match(/^(l1|l2)\s*:\s*(.+)$/i);
  const scope = scoped?.[1]?.toLowerCase() || null;
  const plainQuery = (scoped?.[2] || query).trim().replace(/^#/, "");
  const ranges = Array.isArray(item.l2Ranges) ? item.l2Ranges : [];
  const blockSyntax = scope !== null || query.startsWith("#") || /^[0-9]+$/.test(plainQuery);
  const requestedBlock = blockSyntax ? searchQuantity(plainQuery) : null;

  if (requestedBlock !== null) {
    const l1Block = searchQuantity(item.l1BlockNumber);
    if (scope !== "l2" && l1Block === requestedBlock) return true;
    if (scope === "l1") return false;
    return ranges.some((itemRange) => {
      const range = itemRange?.l2Range || {};
      const first = searchQuantity(range.firstBlockNumber);
      const last = searchQuantity(range.lastBlockNumber);
      return first !== null && last !== null && requestedBlock >= first && requestedBlock <= last;
    });
  }

  const values = [
    item.transactionHash,
    item.l1BlockHash,
    item.status,
    item.isProtocolSettlement ? "eez batch protocol" : "other blob",
    ...(item.blobVersionedHashes || []),
  ];
  return scope === null && values.some((value) => String(value ?? "").toLowerCase().includes(plainQuery));
}

function blobRows(settlements, query = "", historical = false) {
  if (!settlements?.length) {
    const message = String(query).trim()
      ? historical
        ? `No canonical settlement was found for “${h(String(query).trim())}”`
        : `No blob settlements match “${h(String(query).trim())}” in this L1 window`
      : "No blob transactions in this block window";
    return `<tr><td colspan="8" class="empty">${message}</td></tr>`;
  }
  const explorers = state.snapshot?.configuration?.explorers || {};
  return settlements.map((item) => {
    const beacon = item.beacon || {};
    const resultClass = item.status === "confirmed" ? "good" : item.status === "failed" ? "bad" : "warn";
    const protocol = item.isProtocolSettlement ? `<span class="badge good">EEZ batch</span>` : `<span class="badge warn">other blob</span>`;
    const beaconText = beacon.configured === false
      ? `<span class="muted">not configured</span>`
      : beacon.available
        ? `<span class="primary">slot ${number(beacon.slot)}</span><span class="secondary">${number(beacon.blobCount ?? beacon.sidecarCount)} ${beacon.source === "full-blobs" ? "full blobs" : "sidecars"}</span>`
        : `<span class="badge bad" title="${h(beacon.error || "Unavailable")}">unavailable</span>`;
    const blobLinks = item.blobVersionedHashes?.length
      ? item.blobVersionedHashes.map((hash, index) =>
          explorerLink(explorers.blobscan, `blob/${hash}`, `${index + 1}: ${compactHash(hash)}`, "secondary mono hash explorer-value", hash)
        ).join("")
      : `<span class="secondary">no versioned hash</span>`;
    return `<tr>
      <td>${blockLink(explorers.l1, item.l1BlockNumber, `#${number(item.l1BlockNumber)}`, "primary mono explorer-value")}${blockHashLink(explorers.l1, item.l1BlockHash, "secondary mono hash explorer-value")}<span class="secondary">${age(item.timestamp)} ago</span></td>
      <td>${transactionLink(explorers.l1, item.transactionHash, "primary mono hash explorer-value")}<span class="secondary">${protocol}</span></td>
      <td><span class="primary">${number(item.blobCount)}</span>${blobLinks}</td>
      <td>${beaconText}</td><td>${rangeText(item.l2Ranges)}</td>
      <td class="post-cost"><span class="primary" title="${h(item.totalCostWei === null || item.totalCostWei === undefined ? "Receipt cost unavailable" : `${item.totalCostWei} wei`)}">${h(formatEth(item.totalCostWei))}</span><span class="secondary">Execution ${h(formatEth(item.executionCostWei))}</span><span class="secondary">Blobs ${h(formatEth(item.blobCostWei))}</span></td>
      <td><span class="badge ${resultClass}">${h(item.status || "unknown")}</span>${item.errors?.length ? `<span class="secondary" title="${h(item.errors.join("\n"))}">${item.errors.length} warning(s)</span>` : ""}</td>
      <td>${item.isProtocolSettlement ? `<button class="btn btn-sm btn-outline small-action decode-trigger" type="button" data-transaction="${h(item.transactionHash)}">Decode</button>` : "—"}</td>
    </tr>`;
  }).join("");
}

function renderBlobSettlements() {
  if (state.settlementSearchLoading && state.settlementLookup === null) {
    byId("blob-rows").innerHTML = `<tr><td colspan="8" class="empty">Searching indexed settlement history…</td></tr>`;
    setText("window-label", "Searching full history");
    return;
  }
  const historical = state.settlementLookup !== null;
  const settlements = historical
    ? state.settlementLookup.matches || []
    : state.snapshot?.blobSettlements || [];
  const matching = settlements.filter((item) => settlementMatches(item, state.blobQuery));
  byId("blob-rows").innerHTML = blobRows(matching, state.blobQuery, historical);
  const window = state.snapshot?.configuration?.recentBlockWindow || "—";
  const history = state.snapshot?.settlementHistory;
  if (historical) {
    setText("window-label", `${matching.length} exact historical match(es)`);
  } else {
    const matchLabel = state.blobQuery.trim() ? `${matching.length} of ${settlements.length} matches · ` : "";
    setText("window-label", history?.available
      ? `${matchLabel}${settlements.length} recent posts · L1 #${number(history.fromL1Block)}–#${number(history.toL1Block)}`
      : `${matchLabel}Last ${window} L1 blocks${history?.configured ? " · history unavailable" : ""}`);
  }
}

function decodedBlocks(blocks) {
  if (!blocks?.length) return `<p class="muted">This payload does not carry self-contained blocks.</p>`;
  return `<div class="table-scroll compact-table decoder-blocks"><table>
    <thead><tr><th>L2 block</th><th>Parent block hash</th><th>Transactions</th><th>Gas</th><th>Timestamp</th><th>State root</th><th>RLP</th></tr></thead>
    <tbody>${blocks.map((block) => `<tr>
      <td>${blockLink(state.snapshot?.configuration?.explorers?.l2, block.number, `#${number(block.number)}`, "primary mono explorer-value")}</td>
      <td>${blockHashLink(state.snapshot?.configuration?.explorers?.l2, block.parentHash)}</td>
      <td>${block.transactionCount == null ? '<span class="block-pending" title="Fetching transaction count">Pending</span>' : number(block.transactionCount)}</td><td>${number(block.gasUsed)} / ${number(block.gasLimit)}</td>
      <td>${new Date(block.timestamp * 1000).toLocaleString()}</td>
      <td><span class="mono hash" title="${h(block.stateRoot)}">${h(compactHash(block.stateRoot))}</span></td>
      <td>${number(block.rlpBytes)} B</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function decodedByteLayout(payload, operation) {
  const bodyShapes = {
    0: "RLP([blockTxCounts, transactions, l2Entries])",
    1: "RLP([blockTxCounts, transactions, l2Entries, outboundGroupSizes])",
    2: "RLP([blocks, l2Entries, outboundGroupSizes])",
    3: "RLP([profileId, ordinaryBlockCount, environment, records, terminalBlock, l2Entries, outboundGroupSizes])",
  };
  const tag = Number.isInteger(operation.tag) ? operation.tag : 0;
  return `<details class="decode-explanation">
    <summary>How this result maps to the blob bytes</summary>
    <div class="decode-explanation-body">
      <p>The ${number(payload.physicalBytes)} physical bytes are unpacked into ${number(payload.logicalCapacityBytes)} logical bytes. Each 32-byte EIP-4844 field element contributes 31 stream bytes: its most-significant byte must be zero and the remaining bytes are read in reverse order.</p>
      <div class="byte-layout" role="img" aria-label="Decoded EEZ byte layout">
        <span><b>00</b><small>version</small></span>
        <span><b>02</b><small>ChainOperation</small></span>
        <span><b>${number(payload.chainOperation?.chainId)}</b><small>u64 little-endian rollup</small></span>
        <span><b>${number(operation.bytes)} B</b><small>varint-sized operations</small></span>
        <span><b>${number(payload.semanticTransactions?.length || 0)} tx</b><small>native semantic brackets</small></span>
        <span><b>01</b><small>CloseBlobStream</small></span>
        <span><b>${number(payload.paddingBytes)} B</b><small>zero padding</small></span>
      </div>
      <p>The operation begins with tag <code>0x${tag.toString(16).padStart(2, "0")}</code>, followed by <code>${h(bodyShapes[tag] || "unknown payload")}</code>. This batch covers ${number(operation.blockCount)} blocks, ${number(operation.transactionCount)} transactions, and ${number(operation.l2EntryCount)} reconstructed L2 entries.</p>
      <p><code>ChainOperation.operations</code> ends after that RLP body. Cross-chain information is not hidden inside this RLP: each originating transaction is encoded afterward as its own <code>InitiateCrossChainTransaction … FinishCrossChainTransaction</code> message bracket before the final close marker.</p>
      <p class="muted">This UI checks canonical RLP lengths, bounds, the expected rollup ID, message order, RLP shape, and block positions. Tag-3 transaction bytes are displayed without validating their signatures or transaction schemas. The protocol verifier separately checks KZG commitments, beacon inclusion, block/hash linkage, and state-transition soundness.</p>
    </div>
  </details>`;
}

function semanticChain(chainId) {
  return String(chainId) === "0" ? "L1 (rollup 0)" : `rollup ${number(chainId)}`;
}

function semanticBytes(size, preview, emptyLabel = "empty") {
  if (!size) return `<span class="muted">0 B · ${h(emptyLabel)}</span>`;
  return `<span class="semantic-bytes"><b>${number(size)} B</b><code title="${h(preview)}">${h(preview)}</code></span>`;
}

function groupedSemanticMessages(transaction) {
  if (Array.isArray(transaction.messages) && transaction.messages.length) {
    return transaction.messages;
  }

  // Compatibility for a monitor frontend briefly served alongside an older
  // decoder. The current decoder always supplies the exact wire order.
  const messages = [{
    type: "InitiateCrossChainTransaction",
    chainId: transaction.originChain,
    txDataBytes: transaction.txDataBytes,
    txDataPreview: transaction.txDataPreview,
  }];
  for (const call of transaction.calls || []) {
    messages.push(Object.fromEntries(Object.entries(call).filter(([key]) => key !== "result")));
    if (call.result) messages.push({ ...call.result, callIndex: call.index });
  }
  messages.push({ type: "FinishCrossChainTransaction" });
  return messages;
}

function semanticMessageImportant(message) {
  switch (message.type) {
    case "InitiateCrossChainTransaction":
      return `<span class="primary">origin ${h(semanticChain(message.chainId))}</span>${semanticBytes(message.txDataBytes, message.txDataPreview, "empty tx_data")}`;
    case "Call":
    case "StaticCall":
      return `<span class="primary">${h(semanticChain(message.fromChain))} → ${h(semanticChain(message.toChain))}</span><span class="secondary">call #${number(message.index)} · depth ${number(message.depth)} · ${message.type === "Call" ? `value ${h(message.value)}` : "read-only"}</span><span class="secondary mono" title="${h(message.fromAddress)} → ${h(message.toAddress)}">${h(compactHash(message.fromAddress))} → ${h(compactHash(message.toAddress))}</span>`;
    case "ReturnSuccess":
    case "ReturnFail":
      return `<span class="badge ${message.type === "ReturnSuccess" ? "good" : "bad"}">${h(message.type)}</span><span class="secondary">result for call #${number(message.callIndex)}</span>${semanticBytes(message.returnDataBytes, message.returnDataPreview, "empty return data")}`;
    case "Snapshot":
      return `<span class="primary">open rollback region</span><span class="secondary">before call #${number(message.firstCallIndex)} · call depth ${number(message.callDepth)}</span>`;
    case "Revert":
      return `<span class="badge warn">forced rollback</span><span class="secondary">calls #${number(message.firstCallIndex)}–#${number(message.lastCallIndex)} (${number(message.callCount)} total)</span>`;
    case "FinishCrossChainTransaction":
      return `<span class="primary">transaction bracket complete</span><span class="secondary">all calls and rollback regions are closed</span>`;
    default:
      return `<span class="muted">No summary available</span>`;
  }
}

function semanticMessageFields(message) {
  const labels = {
    type: "Message type",
    chainId: "Origin chain",
    txDataBytes: "tx_data bytes",
    txDataPreview: "tx_data preview",
    index: "Call index",
    parentIndex: "Parent call",
    depth: "Call depth",
    fromChain: "From chain",
    toChain: "To chain",
    fromAddress: "From address",
    toAddress: "To address",
    value: "Value",
    gas: "Gas field",
    dataBytes: "Calldata bytes",
    dataPreview: "Calldata preview",
    callIndex: "Result call index",
    returnDataBytes: "Return-data bytes",
    returnDataPreview: "Return-data preview",
    contextDepth: "Context depth",
    callDepth: "Open-call depth",
    firstCallIndex: "First call index",
    lastCallIndex: "Last call index",
    callCount: "Call count",
    rollbackSpan: "Rollback span",
    rollbackRegion: "Rollback region",
    forcedRollback: "Forced rollback",
  };
  return Object.entries(message).map(([key, value]) => [
    labels[key] || key,
    value === null ? "root" : String(value),
  ]);
}

function semanticMessageDetails(message) {
  return `<details class="semantic-message-details"><summary>Expand info</summary><dl>${semanticMessageFields(message).map(([label, value]) => `<div><dt>${h(label)}</dt><dd class="mono">${h(value)}</dd></div>`).join("")}</dl></details>`;
}

function decodedSemantics(payload) {
  const transactions = payload.semanticTransactions || [];
  const sequence = payload.messages || [];
  const groupedSequence = transactions.length
    ? ["ChainOperation", ...transactions.map((_, index) => `Cross-chain tx ${index + 1}`), "CloseBlobStream"]
    : sequence.filter((message) => message === "ChainOperation" || message === "CloseBlobStream");
  const timeline = groupedSequence.length
    ? `<div class="semantic-timeline" aria-label="Grouped blob message sequence">${groupedSequence.map((message, index) => `<span class="${message === "ChainOperation" || message === "CloseBlobStream" ? "carrier" : "transaction"}"><i>${index}</i>${h(message)}</span>`).join("")}</div>`
    : "";
  const intro = `<div class="semantic-heading"><div><p class="eyebrow">CROSS-CHAIN MESSAGE STREAM</p><h3>${number(transactions.length)} semantic transaction(s)</h3></div><p>These brackets follow <code>ChainOperation</code> in the same logical blob stream. They describe cross-chain authorization and effects; the operation RLP separately carries the blocks and entries needed to synchronize this rollup.</p></div>${timeline}`;

  if (!transactions.length) {
    return `<section class="semantic-section">${intro}<p class="semantic-empty">No <code>InitiateCrossChainTransaction</code> bracket is present. This is a chain-local synchronization batch, so there is no cross-chain call forest to display.</p></section>`;
  }

  const details = transactions.map((transaction, index) => {
    const transactionMessages = groupedSemanticMessages(transaction);
    const regions = transaction.rollbackRegions || [];
    return `<details class="semantic-transaction" open>
      <summary><span>Cross-chain tx ${index + 1}</span><b>${h(semanticChain(transaction.originChain))}</b><em>${number(transactionMessages.length)} messages</em><em>${number(transaction.callCount)} call(s)</em><em>${number(transaction.successReturnCount)} success / ${number(transaction.failedReturnCount)} fail</em>${transaction.forcedRollbackCallCount ? `<em class="rollback">${number(transaction.forcedRollbackCallCount)} rolled back</em>` : ""}</summary>
      <div class="semantic-origin">
        <div><small>Origin context</small><strong>${h(semanticChain(transaction.originChain))}</strong></div>
        <div><small>Opaque origin <code>tx_data</code></small>${semanticBytes(transaction.txDataBytes, transaction.txDataPreview)}</div>
        <div><small>Maximum nested call depth</small><strong>${number(transaction.maxCallDepth)}</strong></div>
        <div><small>Forced rollback regions</small><strong>${number(transaction.rollbackRegionCount || 0)}</strong></div>
      </div>
      <div class="table-scroll compact-table"><table class="semantic-messages">
        <thead><tr><th>#</th><th>Message type</th><th>Important parameters</th><th>Debug details</th></tr></thead>
        <tbody>${transactionMessages.map((message, messageIndex) => `<tr>
          <td class="mono">${number(messageIndex)}</td>
          <td><span class="semantic-message-type">${h(message.type)}</span></td>
          <td class="semantic-message-summary">${semanticMessageImportant(message)}</td>
          <td>${semanticMessageDetails(message)}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      ${regions.length ? `<div class="rollback-regions"><strong>Snapshot / Revert regions</strong>${regions.map((region) => `<span>region ${number(region.index)}: calls #${number(region.firstCallIndex)}–#${number(region.lastCallIndex)} (${number(region.callCount)} total)</span>`).join("")}</div>` : ""}
      <p class="semantic-note"><code>ReturnFail</code> is the observed result of one call. A <code>Snapshot … Revert</code> region is different: it marks an otherwise resolved contiguous call span whose state effects are forcibly rolled back.</p>
    </details>`;
  }).join("");
  return `<section class="semantic-section">${intro}<div class="semantic-transactions">${details}</div></section>`;
}

function renderDecoded(payload) {
  const operation = payload.chainOperation?.operations || {};
  const l1Explorer = state.snapshot?.configuration?.explorers?.l1;
  const transaction = transactionLink(l1Explorer, payload.transactionHash, "mono explorer-value");
  const blobLinks = (payload.blobVersionedHashes || []).map((hash) =>
    explorerLink(state.snapshot?.configuration?.explorers?.blobscan, `blob/${hash}`, compactHash(hash), "mono explorer-value", hash),
  ).join(" · ");
  byId("decoder-result").innerHTML = `<div class="decoder-summary">
    <dl>
      <div><dt>Transaction</dt><dd>${transaction}</dd></div>
      <div><dt>L1 block</dt><dd>${blockLink(l1Explorer, payload.l1BlockNumber, `#${number(payload.l1BlockNumber)}`, "explorer-value")} · ${blockHashLink(l1Explorer, payload.l1BlockHash)}</dd></div>
      <div><dt>Blobs</dt><dd>${number(payload.blobCount)} · ${blobLinks}</dd></div>
      <div><dt>Envelope</dt><dd>v${number(payload.protocolVersion)} ${h(payload.profile)}</dd></div>
      <div><dt>Rollup</dt><dd>${number(payload.chainOperation?.chainId)}${payload.registryAddress ? ` · ${explorerLink(l1Explorer, `address/${payload.registryAddress}`, compactHash(payload.registryAddress), "mono explorer-value", payload.registryAddress)}` : ""}</dd></div>
      <div><dt>Payload</dt><dd>tag ${number(operation.tag)} · ${h(operation.format)}</dd></div>
      <div><dt>Blocks / txs</dt><dd>${number(operation.blockCount)} / ${number(operation.transactionCount)}</dd></div>
      <div><dt>L2 entries</dt><dd>${number(operation.l2EntryCount)}</dd></div>
      <div><dt>Semantic txs / calls</dt><dd>${number(payload.semanticTransactions?.length || 0)} / ${number((payload.semanticTransactions || []).reduce((total, transaction) => total + (transaction.callCount || 0), 0))}</dd></div>
      <div><dt>Stream use</dt><dd>${number(payload.usedStreamBytes)} / ${number(payload.logicalCapacityBytes)} bytes</dd></div>
    </dl>
    ${operation.tag === 3 ? `<p>Profile ${number(operation.profileId)} covers L2 #${number(operation.firstBlockNumber)}–#${number(operation.terminalBlockNumber)}: ${number(operation.derivedBlockCount)} derived ordinary blocks, including ${number(operation.implicitEmptyBlockCount)} implicit empty blocks. The table shows only full blocks carried in the payload. Derived state roots and block hashes require execution replay.</p>` : ""}
    ${decodedBlocks(operation.blocks)}
    ${decodedSemantics(payload)}
    ${decodedByteLayout(payload, operation)}
    <details><summary>Full structural decode</summary><pre>${h(JSON.stringify(payload, null, 2))}</pre></details>
  </div>`;
}

async function decodeTransaction(transactionHash) {
  const result = byId("decoder-result");
  const submit = byId("decoder-form").querySelector("button[type=submit]");
  result.innerHTML = `<p class="muted">Fetching canonical blob bytes and decoding the EEZ stream…</p>`;
  submit.disabled = true;
  try {
    const url = apiUrl("api/blob-decode");
    url.searchParams.set("tx", transactionHash);
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    renderDecoded(payload);
  } catch (error) {
    result.innerHTML = `<p class="decoder-error">${h(error.message)}</p>`;
  } finally {
    submit.disabled = false;
  }
}

function isExactSettlementQuery(rawQuery) {
  let query = String(rawQuery || "").trim();
  const scoped = query.match(/^(l1|l2)\s*:\s*(.+)$/i);
  if (scoped) query = scoped[2].trim();
  else if (query.includes(":")) return false;
  query = query.replace(/^#/, "");
  return /^(?:[0-9]+|0x[0-9a-f]+)$/i.test(query);
}

async function searchSettlements(rawQuery) {
  const query = String(rawQuery || "").trim();
  const status = byId("blob-search-status");
  const submit = byId("blob-search-submit");
  const requestId = ++state.settlementSearchRequest;
  if (!query) {
    state.settlementLookup = null;
    status.textContent = "Type to filter the recent window; exact block numbers and full hashes search history automatically.";
    renderBlobSettlements();
    return;
  }
  if (!isExactSettlementQuery(query)) {
    status.textContent = "Text and hash prefixes filter the recent window only. Historical lookup needs a block number or a full 32-byte hash.";
    return;
  }

  state.settlementSearchLoading = true;
  submit.disabled = true;
  status.textContent = "Resolving this selector as an L1 block, L2 block, transaction, or blob…";
  try {
    const url = apiUrl("api/settlement-search");
    url.searchParams.set("q", query);
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (requestId !== state.settlementSearchRequest || byId("blob-search").value.trim() !== query) return;
    state.settlementLookup = payload;
    renderBlobSettlements();
    const warnings = payload.lookupErrors?.length
      ? ` ${payload.lookupErrors.length} optional resolver(s) were unavailable.`
      : "";
    status.textContent = payload.matches?.length
      ? `Loaded ${payload.matches.length} canonical historical settlement(s).${warnings}`
      : `No canonical settlement uses this exact selector.${warnings}`;
  } catch (error) {
    if (requestId === state.settlementSearchRequest) status.textContent = error.message;
  } finally {
    if (requestId === state.settlementSearchRequest) {
      state.settlementSearchLoading = false;
      submit.disabled = false;
      if (state.settlementLookup === null) renderBlobSettlements();
    }
  }
}

function cancelSettlementSearch() {
  if (state.settlementSearchTimer !== null) {
    clearTimeout(state.settlementSearchTimer);
    state.settlementSearchTimer = null;
  }
  state.settlementSearchRequest += 1;
  state.settlementSearchLoading = false;
  byId("blob-search-submit").disabled = false;
}

function scheduleSettlementSearch(rawQuery) {
  const query = String(rawQuery || "").trim();
  cancelSettlementSearch();
  if (!isExactSettlementQuery(query)) return false;

  byId("blob-search-status").textContent = "Exact selector detected; searching indexed history automatically…";
  state.settlementSearchLoading = true;
  byId("blob-search-submit").disabled = true;
  state.settlementSearchTimer = setTimeout(() => {
    state.settlementSearchTimer = null;
    searchSettlements(query);
  }, 400);
  return true;
}

function decimalQuantity(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return BigInt(value).toString(10);
  } catch (_) {
    return null;
  }
}

function correlationRecord(record, index) {
  const explorers = state.snapshot?.configuration?.explorers || {};
  const l1Number = decimalQuantity(record.l1BlockNumber);
  const l2Blocks = Array.isArray(record.l2Blocks) ? record.l2Blocks : [];
  const range = record.l2Range || {};
  const firstNumber = decimalQuantity(range.firstBlockNumber);
  const lastNumber = decimalQuantity(range.lastBlockNumber);
  const blockLinks = l2Blocks.map((block) => {
    const blockNumber = decimalQuantity(block.number);
    return `<li>${blockLink(explorers.l2, blockNumber, `#${number(blockNumber)}`, "explorer-value")}<span>${blockHashLink(explorers.l2, block.hash)}</span></li>`;
  }).join("");
  return `<article class="correlation-record">
    <div class="correlation-record-heading"><strong>Settlement ${index + 1}</strong><span class="badge ${record.canonicalL2 ? "good" : "bad"}">${record.canonicalL2 ? "canonical" : "non-canonical"}</span><span class="badge ${record.l2Finalized ? "good" : "warn"}">${record.l2Finalized ? "finalized" : "not finalized"}</span></div>
    <dl>
      <div><dt>L1 block</dt><dd>${blockLink(explorers.l1, l1Number, `#${number(l1Number)}`, "explorer-value")} · ${blockHashLink(explorers.l1, record.l1BlockHash)}</dd></div>
      <div><dt>L1 transaction</dt><dd>${transactionLink(explorers.l1, record.l1TransactionHash)}</dd></div>
      <div><dt>L2 range</dt><dd>${blockLink(explorers.l2, firstNumber, `#${number(firstNumber)}`, "explorer-value")} → ${blockLink(explorers.l2, lastNumber, `#${number(lastNumber)}`, "explorer-value")} · ${number(decimalQuantity(range.blockCount))} blocks</dd></div>
    </dl>
    <details><summary>All ${number(l2Blocks.length)} L2 blocks and hashes</summary><ol class="correlation-block-list">${blockLinks}</ol></details>
  </article>`;
}

function renderCorrelationResult(payload) {
  const records = Array.isArray(payload.result) ? payload.result : [payload.result];
  return `<div class="correlation-records">${records.map(correlationRecord).join("")}</div>
    <details class="correlation-raw"><summary>Full correlation response</summary><pre>${h(JSON.stringify(payload.result, null, 2))}</pre></details>`;
}

function hydrateBlockRows(snapshot) {
  const result = { ...snapshot, chains: { ...snapshot.chains } };
  for (const name of ["l1", "l2"]) {
    const chain = result.chains[name];
    if (!chain?.latest?.hash) continue;
    const known = new Map();
    for (const block of [...(state.headHistory[name] || []), ...(chain.blocks || []), chain.latest]) {
      const fields = Object.fromEntries(Object.entries(block).filter(([, value]) => value != null));
      known.set(block.hash, { ...block, ...known.get(block.hash), ...fields });
    }
    const rows = [];
    let block = known.get(chain.latest.hash);
    const limit = blockWindow(result, name);
    while (block && rows.length < limit) {
      rows.push(block);
      const parent = known.get(block.parentHash);
      block = parent?.number === block.number - 1 ? parent : null;
    }
    // Never join an unverified gap to an older branch as if it were contiguous.
    // New hash-addressed details fill the gap independently of settlements.
    result.chains[name] = { ...chain, latest: rows[0], blocks: rows };
  }
  return result;
}

function rememberBlockDetails(chains) {
  if (!chains) return;
  for (const [name, blocks] of Object.entries(chains)) {
    if (!["l1", "l2"].includes(name) || !Array.isArray(blocks) || blocks.length > 128) {
      throw new Error("Invalid block details");
    }
    const known = new Map((state.headHistory[name] || []).map(block => [block.hash, block]));
    for (const block of blocks) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(block.hash) || !Number.isSafeInteger(block.number)
          || !Number.isSafeInteger(block.transactionCount) || block.transactionCount < 0) {
        throw new Error("Invalid block details");
      }
      known.set(block.hash, { ...known.get(block.hash), ...block });
    }
    state.headHistory[name] = [...known.values()].sort((a, b) => b.number - a.number).slice(0, 128);
  }
}

function render(snapshot) {
  snapshot = hydrateBlockRows(snapshot);
  state.snapshot = snapshot;
  renderSettlementPolicy(snapshot);
  const l1 = snapshot.chains?.l1;
  const l2 = snapshot.chains?.l2;
  renderChain("L1", l1);
  renderChain("L2", l2);
  renderResourceLinks(snapshot.configuration?.explorers);
  renderComposerRpc(snapshot.configuration?.composerRpc, {
    l1: l1?.chainId,
    l2: l2?.chainId,
  });
  setText("l2-lag", number(snapshot.metrics?.l2UnsafeLag));
  const historyAvailable = snapshot.settlementHistory?.available;
  const posts = snapshot.blobSettlements || [];
  const latestPost = historyAvailable ? posts.find((item) => item.isProtocolSettlement && item.receiptStatus === 1) : null;
  setText("protocol-batches", number(historyAvailable ? posts.filter((item) => item.isProtocolSettlement).length : snapshot.metrics?.protocolSettlementsInWindow));
  setText("history-scope", historyAvailable ? `up to ${snapshot.settlementHistory.limit} latest posts` : "recent L1 block window");
  setText("settlement-interval", duration(snapshot.settlementHistory?.intervalsSeconds?.[0] === undefined ? null : snapshot.settlementHistory.intervalsSeconds[0] * 1000));
  setText("blob-count", number(historyAvailable ? posts.reduce((sum, item) => sum + (item.blobCount || 0), 0) : snapshot.metrics?.blobsInWindow));
  setText("latest-post-cost", formatEth(latestPost?.totalCostWei));
  setText("finality-lag", number(snapshot.metrics?.l2FinalityLag));
  const l2Explorer = snapshot.configuration?.explorers?.l2;
  setHtml("registry-root", snapshot.rollup?.commitment ? blockHashLink(l2Explorer, snapshot.rollup.commitment) : "—");
  setHtml("committed-block", snapshot.rollup?.committedBlock?.number !== undefined
    ? `${blockLink(l2Explorer, snapshot.rollup.committedBlock.number, `#${number(snapshot.rollup.committedBlock.number)}`, "explorer-value")} · ${blockHashLink(l2Explorer, snapshot.rollup.committedBlock.hash)}`
    : "—");
  setHtml("safe-root", snapshot.rollup?.safeBlock?.number !== undefined
    ? `${blockLink(l2Explorer, snapshot.rollup.safeBlock.number, `#${number(snapshot.rollup.safeBlock.number)}`, "explorer-value")} · ${blockHashLink(l2Explorer, snapshot.rollup.safeBlock.hash)}`
    : "—");
  setText("escrow", formatEth(snapshot.rollup?.escrowWei));
  setText("duration", snapshot.collectionDurationMs == null ? "" : `Details checked in ${number(snapshot.collectionDurationMs)} ms`);

  const reconciling = Object.keys(snapshot.reconciliation || {}).length > 0;
  if (reconciling) setStatus(byId("commit-status"), "loading", "Verifying chain history");
  else if (snapshot.rollup?.status === "safe") setStatus(byId("commit-status"), "", "Canonical + safe");
  else if (snapshot.rollup?.status === "pending-safe") setStatus(byId("commit-status"), "loading", "Canonical · pending safe");
  else if (["missing", "non-canonical"].includes(snapshot.rollup?.status)) setStatus(byId("commit-status"), "bad", snapshot.rollup.status);
  else setStatus(byId("commit-status"), "loading", snapshot.rollup?.status || "Unknown");

  renderBlobSettlements();
  byId("l1-blocks").innerHTML = blockRows(l1?.blocks, "l1");
  byId("l2-blocks").innerHTML = blockRows(l2?.blocks, "l2");

  const delayedChains = Object.entries(snapshot.chains || {}).filter(([, chain]) => chain.freshness?.status === "delayed");
  const warnings = delayedChains.map(([name, chain]) => ({ component: name.toUpperCase(),
    message: `Latest block was ${duration(chain.freshness.ageSeconds * 1000)} old when checked (warning after ${duration(chain.freshness.warningSeconds * 1000)}). ${snapshot.stale ? "Cached snapshot; current chain progress is unconfirmed." : "The snapshot is updating, but this chain head is delayed."}` }));
  const reconciliationWarnings = Object.entries(snapshot.reconciliation || {}).map(([name, kind]) => ({
    component: name.toUpperCase(), message: kind === "reorg"
      ? "Chain reorganization detected. Settlement and finality are being verified against the new branch."
      : "Checking continuity after missed blocks. Retained history and finality are last verified values." }));
  const errors = [...(snapshot.errors || []), ...warnings, ...reconciliationWarnings];
  byId("error-panel").classList.toggle("hidden", errors.length === 0);
  byId("errors").innerHTML = errors.map((error) => `<li><b>${h(error.component)}:</b> ${h(error.message)}</li>`).join("");
  const brokenCommitment = ["missing", "non-canonical"].includes(snapshot.rollup?.status);
  setStatus(byId("network-status"), snapshot.stale || errors.length ? "loading" : snapshot.healthy && !brokenCommitment ? "" : "bad",
    snapshot.stale ? "Stale" : reconciling ? "Verifying chain history" : brokenCommitment || !l1?.healthy || !l2?.healthy ? "Degraded"
      : delayedChains.length ? `${delayedChains.map(([name]) => name.toUpperCase()).join(" + ")} head delayed`
      : !snapshot.healthy ? "Degraded" : errors.length ? "Partial data" : "Healthy");
  setText("last-update", `Last updated ${new Date(snapshot.headUpdatedAt || snapshot.generatedAt).toLocaleTimeString()}`);
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  const revision = state.revision;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(apiUrl("api/snapshot"), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    // A delayed HTTP response must not replace a newer pushed snapshot.
    if (state.revision === revision && !state.stopped) applySnapshot(snapshot);
  } catch (error) {
    if (state.revision === revision && !state.stopped) {
      setStatus(byId("network-status"), "bad", "Offline");
      setText("last-update", error.message);
    }
  } finally {
    clearTimeout(timeout);
    state.loading = false;
  }
}

function rememberHeads(heads = {}) {
  const changed = {};
  for (const [name, update] of Object.entries(heads)) {
    const block = update?.block;
    if (!["l1", "l2"].includes(name) || !block || !Number.isSafeInteger(block.number) || block.number < 0
        || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) || !Number.isSafeInteger(block.timestamp)
        || !Number.isSafeInteger(update.sequence) || !Number.isFinite(Date.parse(update.receivedAt))) {
      throw new Error("Invalid head update");
    }
    if (!state.heads[name] || update.sequence > state.heads[name].sequence) {
      const previous = state.snapshot?.chains?.[name]?.latest;
      if (previous?.hash && previous.hash !== block.hash) {
        const continuous = block.number === previous.number + 1 && block.parentHash === previous.hash;
        if (!continuous) {
          const reorg = block.number <= previous.number || block.number === previous.number + 1;
          const pending = state.pendingChains[name];
          state.pendingChains[name] = { sequence: update.sequence,
            kind: reorg || pending?.kind === "reorg" ? "reorg" : "gap" };
        }
      }
      const history = state.headHistory[name] || [];
      state.headHistory[name] = [block, ...history.filter(item => item.hash !== block.hash)].slice(0, 128);
      state.heads[name] = update;
      changed[name] = update;
    }
  }
  return changed;
}

function mergeHeads(snapshot, startedSequence = -1, heads = state.heads) {
  const result = { ...snapshot, chains: { ...snapshot.chains }, metrics: { ...snapshot.metrics } };
  for (const [name, update] of Object.entries(heads)) {
    const chain = result.chains[name] || { name: name.toUpperCase() };
    const head = update.block;
    // A successful collection started after this event is authoritative, even
    // for a same-height replacement or a lower canonical head.
    const reconciled = !snapshot.stale && chain.healthy && chain.latest?.hash
      && update.sequence <= startedSequence;
    if (reconciled) continue;
    const pending = state.pendingChains[name];
    const known = new Map([...(state.headHistory[name] || []), ...(chain.blocks || [])]
      .map(block => [block.hash, block]));
    const path = [];
    let cursor = known.get(head.hash) || head;
    while (cursor && cursor.hash !== chain.latest?.hash && path.length < 128) {
      path.push(cursor);
      const parent = known.get(cursor.parentHash);
      cursor = parent?.number === cursor.number - 1 ? parent : null;
    }
    const connected = cursor?.hash === chain.latest?.hash;
    const changed = chain.latest?.hash !== head.hash;
    const warningSeconds = result.configuration?.headDelayWarningSeconds || 30;
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - head.timestamp));
    result.chains[name] = { ...chain, latest: changed ? (known.get(head.hash) || head) : chain.latest,
      blocks: changed ? [...path, ...(connected ? chain.blocks || [] : [])]
        .slice(0, blockWindow(result, name)) : chain.blocks,
      freshness: { ageSeconds, warningSeconds, status: ageSeconds > warningSeconds ? "delayed" : "current" } };
    result.headUpdatedAt = update.receivedAt;
    if (pending || (changed && chain.latest?.hash && !connected)) {
      const kind = pending?.kind || "gap";
      result.reconciliation = { ...result.reconciliation, [name]: kind };
      if (kind === "gap") {
        // Missing notifications aren't proof of a reorg. Keep last checked
        // history visible, explicitly marked as awaiting verification.
        const rows = [...path, ...(chain.blocks || [])];
        result.chains[name].blocks = rows.filter((block, index) =>
          rows.findIndex(item => item.number === block.number) === index)
          .slice(0, blockWindow(result, name));
      } else {
        result.chains[name].safe = null;
        result.chains[name].finalized = null;
        // L1 reorgs also invalidate L2 safety derived from L1 settlement.
        if (name === "l1" && result.chains.l2) {
          result.chains.l2 = { ...result.chains.l2, safe: null, finalized: null };
        }
        result.rollup = { ...result.rollup, status: "unavailable", safeBlock: null };
        result.settlementHistory = { ...result.settlementHistory, available: false, intervalsSeconds: [] };
        result.blobSettlements = [];
        result.metrics.protocolSettlementsInWindow = null;
        result.metrics.blobsInWindow = null;
      }
    }
  }
  const l2 = result.chains.l2;
  result.metrics.l2UnsafeLag = l2?.latest?.number != null && l2.safe?.number != null
    ? Math.max(0, l2.latest.number - l2.safe.number) : null;
  result.metrics.l2FinalityLag = l2?.latest?.number != null && l2.finalized?.number != null
    ? Math.max(0, l2.latest.number - l2.finalized.number) : null;
  const policy = result.configuration?.settlementPolicy;
  const anchor = result.rollup?.committedBlock?.number;
  if (policy?.enabled && ["safe", "pending-safe"].includes(result.rollup?.status) && l2?.latest?.number >= anchor) {
    const unsettled = l2.latest.number - anchor;
    const remaining = Math.max(0, policy.maxUnsettledL2Blocks - unsettled);
    result.settlementProgress = { available: true, anchorL2Block: anchor, anchorL2Hash: result.rollup.commitment,
      unsettledL2Blocks: unsettled, remainingL2Blocks: remaining, generalThresholdReached: remaining === 0,
      estimatedGeneralRemainingMs: policy.l2BlockTimeMs == null ? null : remaining * policy.l2BlockTimeMs };
  }
  if (Object.keys(result.reconciliation || {}).length) {
    result.settlementProgress = { available: false };
    result.metrics.l2UnsafeLag = null;
    result.metrics.l2FinalityLag = null;
  }
  return result;
}

function applyHeads(heads) {
  if (!heads || typeof heads !== "object" || Array.isArray(heads)) throw new Error("Invalid head updates");
  const changed = rememberHeads(heads);
  if (!Object.keys(changed).length) return;
  state.revision += 1; // In-flight HTTP details must not overwrite a live head.
  render(mergeHeads(state.snapshot || { generatedAt: new Date().toISOString(), chains: {} }, -1, changed));
}

function applySnapshot(snapshot, heads = {}, startedSequence = Number.MAX_SAFE_INTEGER) {
  rememberHeads(heads);
  if (!snapshot.stale) {
    for (const [name, pending] of Object.entries(state.pendingChains)) {
      if (pending.sequence <= startedSequence && snapshot.chains?.[name]?.healthy
          && snapshot.chains[name].latest?.hash) delete state.pendingChains[name];
    }
  }
  state.revision += 1;
  const seconds = snapshot.configuration?.refreshSeconds;
  if (Number.isFinite(seconds) && seconds >= 2 && seconds <= 60) {
    const interval = seconds * 1000;
    if (interval !== state.pollMilliseconds && state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
      state.pollMilliseconds = interval;
      startPolling();
    } else state.pollMilliseconds = interval;
  }
  // Keep successfully hydrated rows across slower detail responses. Only merge
  // by hash: data from an orphaned block must never hydrate its replacement.
  for (const name of ["l1", "l2"]) {
    const rows = [...(state.snapshot?.chains?.[name]?.blocks || []),
      ...(snapshot.chains?.[name]?.blocks || [])];
    const known = new Map((state.headHistory[name] || []).map(block => [block.hash, block]));
    for (const block of rows) {
      if (!block.hash) continue;
      const fields = Object.fromEntries(Object.entries(block).filter(([, value]) => value != null));
      known.set(block.hash, { ...block, ...known.get(block.hash), ...fields });
    }
    state.headHistory[name] = [...known.values()].sort((a, b) => b.number - a.number).slice(0, 128);
  }
  // A failed component is not an empty chain/history. Retain last checked data
  // while exposing the failure; actual reorg invalidation still runs below.
  const previous = state.snapshot;
  if (previous) {
    snapshot = { ...snapshot, chains: { ...snapshot.chains }, reconciliation: {} };
    const failed = new Set((snapshot.errors || []).map(error => error.component));
    for (const name of ["l1", "l2"]) {
      if (failed.has(name) && !snapshot.chains[name]?.latest && previous.chains?.[name]?.latest) {
        snapshot.chains[name] = { ...previous.chains[name], ...snapshot.chains[name] };
        snapshot.reconciliation[name] = "gap";
      }
    }
    if (failed.has("rollup") && previous.rollup) {
      snapshot.rollup = { ...previous.rollup, status: "unavailable" };
    }
    if (failed.has("settlement-history") && previous.settlementHistory?.available) {
      snapshot.settlementHistory = previous.settlementHistory;
      snapshot.blobSettlements = previous.blobSettlements;
      snapshot.reconciliation.l1 = "gap";
    }
  }
  render(mergeHeads(snapshot, startedSequence));
}

function startPolling() {
  if (state.stopped || state.timer !== null) return;
  state.timer = setInterval(refresh, state.pollMilliseconds);
}

function armLiveTimeout(socket) {
  clearTimeout(state.liveTimer);
  state.liveTimer = setTimeout(() => {
    if (state.socket !== socket) return;
    setStatus(byId("network-status"), "loading", "Updates delayed");
    socket.close();
  }, Math.max(15000, state.pollMilliseconds * 3));
}

function reconnectLive() {
  if (state.stopped) return;
  startPolling();
  refresh();
  state.reconnectTimer = setTimeout(connectLive, state.reconnectDelay);
  state.reconnectDelay = Math.min(15000, state.reconnectDelay * 2);
}

function connectLive() {
  if (state.stopped || state.socket) return;
  if (typeof WebSocket === "undefined") {
    startPolling();
    refresh();
    return;
  }
  clearTimeout(state.reconnectTimer);
  const url = apiUrl("api/live");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (_) {
    reconnectLive();
    return;
  }
  state.socket = socket;
  state.heads = {}; // Sequence numbers belong to this server connection.
  state.headHistory = {};
  state.pendingChains = {};
  armLiveTimeout(socket);
  socket.onmessage = (event) => {
    if (state.socket !== socket || state.stopped) return;
    try {
      const message = JSON.parse(event.data);
      rememberBlockDetails(message.blocks);
      if (message.type === "heads") {
        applyHeads(message.heads);
        if (message.blocks && state.snapshot) render(state.snapshot);
        armLiveTimeout(socket);
        return;
      }
      if (message.type === "unavailable") {
        if (message.heads) applyHeads(message.heads);
        startPolling();
        refresh();
        return;
      }
      const snapshot = message.snapshot;
      if (message.type !== "snapshot" || !snapshot?.generatedAt || !snapshot.chains) {
        throw new Error("Invalid live snapshot");
      }
      if (state.timer !== null) clearInterval(state.timer);
      state.timer = null;
      state.reconnectDelay = 1000;
      applySnapshot(snapshot, message.heads, message.collectionStartedSequence);
      armLiveTimeout(socket);
    } catch (_) {
      socket.close(1002, "Invalid snapshot");
    }
  };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    if (state.socket !== socket) return;
    state.socket = null;
    clearTimeout(state.liveTimer);
    reconnectLive();
  };
}

listen(byId("blob-search"), "input", (event) => {
  state.blobQuery = event.target.value;
  state.settlementLookup = null;
  if (!scheduleSettlementSearch(state.blobQuery)) {
    byId("blob-search-status").textContent = state.blobQuery.trim()
      ? "Filtering the recent window. Enter an exact block number or full hash to search indexed history automatically."
      : "Type to filter the recent window; exact block numbers and full hashes search history automatically.";
  }
  renderBlobSettlements();
});
listen(byId("blob-search-form"), "submit", (event) => {
  event.preventDefault();
  cancelSettlementSearch();
  searchSettlements(byId("blob-search").value);
});
listen(byId("blob-search-clear"), "click", () => {
  cancelSettlementSearch();
  byId("blob-search").value = "";
  state.blobQuery = "";
  state.settlementLookup = null;
  byId("blob-search-status").textContent = "Type to filter the recent window; exact block numbers and full hashes search history automatically.";
  renderBlobSettlements();
});
listen(byId("composer-rpc"), "click", async (event) => {
  const button = event.target.closest("[data-copy-rpc]");
  if (!button) return;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(button.dataset.copyRpc);
    button.textContent = "Copied";
  } catch (_) {
    button.textContent = "Copy failed";
  }
  setTimeout(() => { button.textContent = original; }, 1600);
});
listen(byId("blob-rows"), "click", (event) => {
  const button = event.target.closest(".decode-trigger");
  if (!button) return;
  const transactionHash = button.dataset.transaction;
  byId("decoder-transaction").value = transactionHash;
  decodeTransaction(transactionHash);
  byId("decoder-form").scrollIntoView({ behavior: "smooth", block: "center" });
});
listen(byId("decoder-form"), "submit", (event) => {
  event.preventDefault();
  decodeTransaction(byId("decoder-transaction").value.trim());
});
listen(byId("correlation-form"), "submit", async (event) => {
  event.preventDefault();
  const result = byId("correlation-result");
  const direction = byId("correlation-direction").value;
  const block = byId("correlation-block").value.trim();
  result.innerHTML = `<p class="muted">Resolving canonical index…</p>`;
  try {
    const url = apiUrl("api/correlation");
    url.searchParams.set("direction", direction);
    url.searchParams.set("block", block);
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    result.innerHTML = payload.result === null || (Array.isArray(payload.result) && payload.result.length === 0)
      ? `<p class="muted">No canonical settlement was found for this block.</p>`
      : renderCorrelationResult(payload);
  } catch (error) {
    result.innerHTML = `<p class="muted">${h(error.message)}</p>`;
  }
});

function stop() {
  state.stopped = true;
  clearTimeout(state.ageTimer);
  state.ageTimer = null;
  state.settlementSearchRequest += 1;
  clearTimeout(state.liveTimer);
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.settlementSearchTimer);
  if (state.timer !== null) clearInterval(state.timer);
  state.timer = null;
  const socket = state.socket;
  state.socket = null;
  socket?.close();
}
listen(window, "keydown", (event) => {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented
      || event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
  event.preventDefault();
  byId("blob-search")?.focus();
});
listen(window, "pagehide", stop);
listen(window, "pageshow", () => {
  state.stopped = false;
  startAgeClock();
  connectLive();
});
startAgeClock();
connectLive();
return () => {
  stop();
  for (const [element, type, handler] of listeners) element.removeEventListener?.(type, handler);
};

}
