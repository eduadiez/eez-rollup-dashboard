const byId = (id) => document.getElementById(id);
const state = { loading: false, timer: null, snapshot: null, blobQuery: "" };

function h(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function apiUrl(path) {
  return new URL(path, new URL(".", window.location.href));
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
  const raw = BigInt(wei);
  const whole = raw / 1000000000000000000n;
  const fraction = (raw % 1000000000000000000n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} ETH`;
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
      <button type="button" data-copy-rpc="${h(route.url)}" aria-label="Copy ${h(route.direction)} Composer RPC URL">Copy</button>
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
  if (prefix === "l1") setText("l1-peers", number(chain?.peerCount));
}

function blockRows(blocks, chain) {
  if (!blocks?.length) return `<tr><td colspan="5" class="empty">No block data</td></tr>`;
  const explorers = state.snapshot?.configuration?.explorers || {};
  const base = chain === "l1" ? explorers.l1 : explorers.l2;
  return blocks.map((block) => {
    if (chain === "l1") {
      return `<tr>
        <td>${blockLink(base, block.number, `#${number(block.number)}`, "primary mono explorer-value")}${blockHashLink(base, block.hash, "secondary mono hash explorer-value")}</td>
        <td>${age(block.timestamp)}</td><td>${number(block.transactionCount)}</td>
        <td>${block.blobTransactionCount ? `<span class="badge good">${block.blobTransactionCount} tx</span>` : "—"}</td>
        <td>${percent(block.gasUsed, block.gasLimit)}</td></tr>`;
    }
    return `<tr>
      <td>${explorerLink(base, `block/${block.number}`, `#${number(block.number)}`, "primary mono explorer-value")}</td><td>${age(block.timestamp)}</td>
      <td>${number(block.transactionCount)}</td><td>${percent(block.gasUsed, block.gasLimit)}</td>
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
  const plainQuery = query.replace(/^#/, "");
  const ranges = Array.isArray(item.l2Ranges) ? item.l2Ranges : [];
  const values = [
    item.transactionHash,
    item.l1BlockNumber,
    item.l1BlockHash,
    item.status,
    item.beacon?.slot,
    item.isProtocolSettlement ? "eez batch protocol" : "other blob",
    ...(item.blobVersionedHashes || []),
  ];
  for (const itemRange of ranges) {
    const range = itemRange?.l2Range || {};
    values.push(range.firstBlockNumber, range.lastBlockNumber, range.blockCount);
    for (const value of [range.firstBlockNumber, range.lastBlockNumber]) {
      const quantity = searchQuantity(value);
      if (quantity !== null) values.push(quantity.toString(10));
    }
  }
  if (values.some((value) => String(value ?? "").toLowerCase().includes(plainQuery))) return true;

  const requestedBlock = searchQuantity(plainQuery);
  if (requestedBlock === null) return false;
  return ranges.some((itemRange) => {
    const range = itemRange?.l2Range || {};
    const first = searchQuantity(range.firstBlockNumber);
    const last = searchQuantity(range.lastBlockNumber);
    return first !== null && last !== null && requestedBlock >= first && requestedBlock <= last;
  });
}

function blobRows(settlements, query = "") {
  if (!settlements?.length) {
    const message = String(query).trim()
      ? `No blob settlements match “${h(String(query).trim())}” in this L1 window`
      : "No blob transactions in this block window";
    return `<tr><td colspan="7" class="empty">${message}</td></tr>`;
  }
  const explorers = state.snapshot?.configuration?.explorers || {};
  return settlements.map((item) => {
    const beacon = item.beacon || {};
    const resultClass = item.status === "confirmed" ? "good" : "bad";
    const protocol = item.isProtocolSettlement ? `<span class="badge good">EEZ batch</span>` : `<span class="badge warn">other blob</span>`;
    const beaconText = beacon.available
      ? `<span class="primary">slot ${number(beacon.slot)}</span><span class="secondary">${number(beacon.sidecarCount)} sidecars</span>`
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
      <td><span class="badge ${resultClass}">${h(item.status || "unknown")}</span>${item.errors?.length ? `<span class="secondary" title="${h(item.errors.join("\n"))}">${item.errors.length} warning(s)</span>` : ""}</td>
      <td>${item.isProtocolSettlement ? `<button class="small-action decode-trigger" type="button" data-transaction="${h(item.transactionHash)}">Decode</button>` : "—"}</td>
    </tr>`;
  }).join("");
}

function renderBlobSettlements() {
  const settlements = state.snapshot?.blobSettlements || [];
  const matching = settlements.filter((item) => settlementMatches(item, state.blobQuery));
  byId("blob-rows").innerHTML = blobRows(matching, state.blobQuery);
  const window = state.snapshot?.configuration?.recentBlockWindow || "—";
  const matchLabel = state.blobQuery.trim() ? `${matching.length} of ${settlements.length} matches · ` : "";
  setText("window-label", `${matchLabel}Last ${window} L1 blocks`);
}

function decodedBlocks(blocks) {
  if (!blocks?.length) return `<p class="muted">This payload does not carry self-contained blocks.</p>`;
  return `<div class="table-scroll compact-table decoder-blocks"><table>
    <thead><tr><th>L2 block</th><th>Parent block hash</th><th>Transactions</th><th>Gas</th><th>Timestamp</th><th>State root</th><th>RLP</th></tr></thead>
    <tbody>${blocks.map((block) => `<tr>
      <td>${blockLink(state.snapshot?.configuration?.explorers?.l2, block.number, `#${number(block.number)}`, "primary mono explorer-value")}</td>
      <td>${blockHashLink(state.snapshot?.configuration?.explorers?.l2, block.parentHash)}</td>
      <td>${number(block.transactionCount)}</td><td>${number(block.gasUsed)} / ${number(block.gasLimit)}</td>
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
        <span><b>01</b><small>CloseBlobStream</small></span>
        <span><b>${number(payload.paddingBytes)} B</b><small>zero padding</small></span>
      </div>
      <p>The operation begins with tag <code>0x${tag.toString(16).padStart(2, "0")}</code>, followed by <code>${h(bodyShapes[tag] || "unknown payload")}</code>. This batch covers ${number(operation.blockCount)} blocks, ${number(operation.transactionCount)} transactions, and ${number(operation.l2EntryCount)} reconstructed L2 entries.</p>
      <p class="muted">This UI checks canonical RLP lengths, bounds, the expected rollup ID, message order, RLP shape, and contiguous block numbers. The protocol verifier separately checks KZG commitments, beacon inclusion, block/hash linkage, and state-transition soundness.</p>
    </div>
  </details>`;
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
      <div><dt>Stream use</dt><dd>${number(payload.usedStreamBytes)} / ${number(payload.logicalCapacityBytes)} bytes</dd></div>
    </dl>
    ${decodedBlocks(operation.blocks)}
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

function render(snapshot) {
  state.snapshot = snapshot;
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
  setText("protocol-batches", number(snapshot.metrics?.protocolSettlementsInWindow));
  setText("blob-transactions", number(snapshot.metrics?.blobTransactionsInWindow));
  setText("blob-count", number(snapshot.metrics?.blobsInWindow));
  setText("sidecar-count", number(snapshot.metrics?.availableBlobSidecarsInWindow));
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
  setText("duration", `collected in ${number(snapshot.collectionDurationMs)} ms`);

  if (snapshot.rollup?.status === "safe") setStatus(byId("commit-status"), "", "Canonical + safe");
  else if (snapshot.rollup?.status === "pending-safe") setStatus(byId("commit-status"), "loading", "Canonical · pending safe");
  else if (["missing", "non-canonical"].includes(snapshot.rollup?.status)) setStatus(byId("commit-status"), "bad", snapshot.rollup.status);
  else setStatus(byId("commit-status"), "loading", snapshot.rollup?.status || "Unknown");

  renderBlobSettlements();
  byId("l1-blocks").innerHTML = blockRows(l1?.blocks, "l1");
  byId("l2-blocks").innerHTML = blockRows(l2?.blocks, "l2");

  const errors = snapshot.errors || [];
  byId("error-panel").classList.toggle("hidden", errors.length === 0);
  byId("errors").innerHTML = errors.map((error) => `<li><b>${h(error.component)}:</b> ${h(error.message)}</li>`).join("");
  setStatus(byId("network-status"), snapshot.healthy ? "" : "bad", snapshot.healthy ? "Live" : "Degraded");
  setText("last-update", `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`);
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  byId("refresh").disabled = true;
  try {
    const response = await fetch(apiUrl("api/snapshot"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    setStatus(byId("network-status"), "bad", "Offline");
    setText("last-update", error.message);
  } finally {
    state.loading = false;
    byId("refresh").disabled = false;
  }
}

byId("refresh").addEventListener("click", refresh);
byId("blob-search").addEventListener("input", (event) => {
  state.blobQuery = event.target.value;
  renderBlobSettlements();
});
byId("composer-rpc").addEventListener("click", async (event) => {
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
byId("blob-rows").addEventListener("click", (event) => {
  const button = event.target.closest(".decode-trigger");
  if (!button) return;
  const transactionHash = button.dataset.transaction;
  byId("decoder-transaction").value = transactionHash;
  decodeTransaction(transactionHash);
  byId("decoder-form").scrollIntoView({ behavior: "smooth", block: "center" });
});
byId("decoder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  decodeTransaction(byId("decoder-transaction").value.trim());
});
byId("correlation-form").addEventListener("submit", async (event) => {
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

refresh();
state.timer = setInterval(refresh, 5000);
