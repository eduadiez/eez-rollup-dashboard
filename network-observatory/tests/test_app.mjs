import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const elements = new Map();

function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      disabled: false,
      className: "",
      dataset: {},
      classList: { toggle() {} },
      addEventListener() {},
      append() {},
      replaceChildren() {},
      querySelector() { return element(`${id}-submit`); },
      scrollIntoView() {},
    });
  }
  return elements.get(id);
}

globalThis.document = {
  getElementById: element,
  createElement: () => element(`created-${elements.size}`),
};
globalThis.window = { location: { href: "https://eez.asuscomm.com/monitor/" } };
globalThis.fetch = () => new Promise(() => {});
globalThis.setInterval = () => 0;

const app = readFileSync(new URL("../app/static/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/static/styles.css", import.meta.url), "utf8");
assert.match(
  styles,
  /\.decoder-summary \.semantic-message-details dl \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
);
assert.match(
  styles,
  /\.decoder-summary \.semantic-message-details dd \{[^}]*overflow: visible/,
);
const assertions = String.raw`
state.snapshot = { configuration: { explorers: {
  l1: "https://eez.asuscomm.com:4444",
  l2: "https://eez.asuscomm.com:4445",
  blobscan: "https://eez.asuscomm.com:4443",
} } };

const txHash = "0x" + "11".repeat(32);
const l1Hash = "0x" + "22".repeat(32);
const blobHash = "0x" + "33".repeat(32);
const parentHash = "0x" + "44".repeat(32);
const stateRoot = "0x" + "55".repeat(32);
renderDecoded({
  transactionHash: txHash,
  l1BlockNumber: 114,
  l1BlockHash: l1Hash,
  registryAddress: "0x" + "66".repeat(20),
  blobVersionedHashes: [blobHash],
  protocolVersion: 0,
  profile: "native-semantics",
  blobCount: 1,
  physicalBytes: 131072,
  logicalCapacityBytes: 126976,
  usedStreamBytes: 4096,
  paddingBytes: 122880,
  messages: ["ChainOperation", "InitiateCrossChainTransaction", "Call", "ReturnSuccess", "FinishCrossChainTransaction", "CloseBlobStream"],
  chainOperation: { chainId: 1, operations: {
    tag: 2,
    format: "self-contained-blocks",
    bytes: 4082,
    blockCount: 1,
    transactionCount: 2,
    l2EntryCount: 0,
    blocks: [{ number: 673, parentHash, stateRoot, transactionCount: 2,
      gasUsed: 42000, gasLimit: 30000000, timestamp: 1700000000, rlpBytes: 900 }],
  } },
  semanticTransactions: [{ originChain: 1, txDataBytes: 128, txDataPreview: "0x7478", callCount: 1,
    snapshotCount: 0, rollbackRegionCount: 0, forcedRollbackCallCount: 0,
    maxCallDepth: 1, successReturnCount: 1, failedReturnCount: 0,
    messages: [
      { type: "InitiateCrossChainTransaction", chainId: 1, txDataBytes: 128, txDataPreview: "0x7478" },
      { type: "Call", index: 0, parentIndex: null, depth: 0, fromChain: 1, toChain: 0,
        fromAddress: "0x" + "77".repeat(20), toAddress: "0x" + "88".repeat(20),
        value: "7", gas: 0, dataBytes: 4, dataPreview: "0xdeadbeef" },
      { type: "ReturnSuccess", callIndex: 0, returnDataBytes: 2, returnDataPreview: "0xbeef" },
      { type: "FinishCrossChainTransaction" },
    ],
    calls: [{ index: 0, parentIndex: null, depth: 0,
      type: "Call", fromChain: 1, toChain: 0,
      fromAddress: "0x" + "77".repeat(20), toAddress: "0x" + "88".repeat(20),
      value: "7", dataBytes: 4, dataPreview: "0xdeadbeef",
      result: { type: "ReturnSuccess", returnDataBytes: 2, returnDataPreview: "0xbeef" } }],
    rollbackRegions: [] }],
});
const decoded = element("decoder-result").innerHTML;
assert.match(decoded, /:4444\/tx\/0x11/);
assert.match(decoded, /:4444\/block\/114/);
assert.match(decoded, /:4444\/block\/0x22/);
assert.match(decoded, /:4443\/blob\/0x33/);
assert.match(decoded, /:4445\/block\/673/);
assert.match(decoded, /:4445\/block\/0x44/);
assert.match(decoded, /How this result maps to the blob bytes/);
assert.match(decoded, /RLP\(\[blocks, l2Entries, outboundGroupSizes\]\)/);
assert.match(decoded, /Cross-chain tx 1/);
assert.match(decoded, /ReturnSuccess/);
assert.match(decoded, /CROSS-CHAIN MESSAGE STREAM/);
assert.match(decoded, /InitiateCrossChainTransaction/);
assert.match(decoded, /0xdeadbeef/);
assert.match(decoded, /0xbeef/);
assert.match(decoded, /4 messages/);
assert.match(decoded, /Message type/);
assert.match(decoded, /Important parameters/);
assert.match(decoded, /Expand info/);
assert.doesNotMatch(decoded, /<i>2<\/i>Call/);
assert.match(decoded, /Cross-chain information is not hidden inside this RLP/);

const noSemantics = decodedSemantics({
  messages: ["ChainOperation", "CloseBlobStream"],
  semanticTransactions: [],
});
assert.match(noSemantics, /chain-local synchronization batch/);

const correlation = renderCorrelationResult({ result: {
  canonicalL2: true,
  l2Finalized: true,
  l1BlockNumber: "0x72",
  l1BlockHash: l1Hash,
  l1TransactionHash: txHash,
  l2Range: { firstBlockNumber: "0x2a1", lastBlockNumber: "0x2a6", blockCount: "0x6" },
  l2Blocks: [{ number: "0x2a1", hash: parentHash }],
} });
assert.match(correlation, /:4444\/block\/114/);
assert.match(correlation, /:4444\/tx\/0x11/);
assert.match(correlation, /:4445\/block\/673/);
assert.match(correlation, /:4445\/block\/0x44/);

renderChain("L1", { chainId: 7331, latest: { number: 128, hash: l1Hash },
  safe: { number: 96 }, finalized: { number: 64 }, peerCount: 2 });
assert.match(element("l1-latest").innerHTML, /:4444\/block\/128/);
assert.match(element("l1-hash").innerHTML, /:4444\/block\/0x22/);
assert.match(element("l1-safe").innerHTML, /:4444\/block\/96/);
assert.match(element("l1-finalized").innerHTML, /:4444\/block\/64/);

renderComposerRpc({
  l1ToL2: "https://eez.asuscomm.com/composer/l1",
  l2ToL1: "https://eez.asuscomm.com/composer/l2",
}, { l1: 7331, l2: 6290 });
const composer = element("composer-rpc").innerHTML;
assert.match(composer, /L1 → L2/);
assert.match(composer, /L2 → L1/);
assert.match(composer, /composer\/l1/);
assert.match(composer, /composer\/l2/);
assert.match(composer, /chain 7331/);
assert.match(composer, /chain 6290/);

const searchableSettlement = {
  transactionHash: txHash,
  l1BlockNumber: 114,
  l1BlockHash: l1Hash,
  status: "confirmed",
  isProtocolSettlement: true,
  blobVersionedHashes: [blobHash],
  beacon: { slot: 771 },
  l2Ranges: [{ l2Range: {
    firstBlockNumber: "0x2a1",
    lastBlockNumber: "0x2a6",
    blockCount: "0x6",
  } }],
};
assert.equal(settlementMatches(searchableSettlement, "0x111111"), true);
assert.equal(settlementMatches(searchableSettlement, "0x333333"), true);
assert.equal(settlementMatches(searchableSettlement, "#114"), true);
assert.equal(settlementMatches(searchableSettlement, "L1:0x72"), true);
assert.equal(settlementMatches(searchableSettlement, "L1:114"), true);
assert.equal(settlementMatches(searchableSettlement, "L2:674"), true);
assert.equal(settlementMatches(searchableSettlement, "L2:114"), false);
assert.equal(settlementMatches(searchableSettlement, "674"), true);
assert.equal(settlementMatches(searchableSettlement, "EEZ batch"), true);
assert.equal(settlementMatches(searchableSettlement, "999999"), false);
assert.equal(isExactSettlementQuery("L1:#114"), true);
assert.equal(isExactSettlementQuery("0x" + "11".repeat(32)), true);
assert.equal(isExactSettlementQuery("0x1111zz"), false);
assert.match(blobRows([], "missing"), /No blob settlements match/);
`;

eval(`${app}\n${assertions}`);
console.log("dashboard contextual explorer-link tests passed");
