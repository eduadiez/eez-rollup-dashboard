"""Settlement telemetry reflects canonical evidence without scheduling work."""
import json
import os
import unittest
from unittest import mock

from test_server import EXTERNAL_RPC_ENV, server


REGISTRY = "0x" + "77" * 20
POLICY = {
    "EEZ_SETTLEMENT_POLICY_ENABLED": "true",
    "EEZ_SETTLEMENT_PURE_L2_MODE": "always",
    "EEZ_SETTLEMENT_MAX_UNSETTLED_L2_BLOCKS": "150",
    "EEZ_SETTLEMENT_BLOB_FULLNESS_BPS": "off",
    "EEZ_L2_BLOCK_TIME_MS": "2000",
}


def settings(**values):
    with mock.patch.dict(os.environ, {**EXTERNAL_RPC_ENV, **values}, clear=True):
        return server.Settings.from_env()


def block_hash(number):
    return "0x" + f"{number:064x}"


class SettlementPolicyTests(unittest.TestCase):
    def test_unsupplied_policy_does_not_assume_node_defaults(self):
        value = settings()
        self.assertIsNone(value.settlement_policy)
        self.assertEqual(value.settlement_lookback_blocks, 512)
        self.assertEqual(value.recent_settlements, 12)
        self.assertEqual(settings(EEZ_SETTLEMENT_POLICY_ENABLED="false").settlement_policy, {"enabled": False})

    def test_always_and_interval_configuration_are_explicit(self):
        value = settings(**POLICY).settlement_policy
        self.assertEqual(value["nominalGeneralIntervalMs"], 300000)
        self.assertEqual(value["pureL2Mode"], "always")
        self.assertIsNone(value["blobFullnessBps"])
        self.assertIsNone(settings(**{**POLICY, "EEZ_SETTLEMENT_PURE_L2_INTERVAL_MS": "900000"}).settlement_policy["pureL2IntervalMs"])
        interval = settings(**{**POLICY, "EEZ_SETTLEMENT_PURE_L2_MODE": "interval",
                              "EEZ_SETTLEMENT_PURE_L2_INTERVAL_MS": "900000",
                              "EEZ_SETTLEMENT_BLOB_FULLNESS_BPS": "1000"}).settlement_policy
        self.assertEqual(interval["pureL2IntervalMs"], 900000)
        self.assertEqual(interval["blobFullnessBps"], 1000)
        self.assertEqual(interval["nominalGeneralIntervalMs"], 300000)

    def test_invalid_and_contradictory_configuration_fails_at_startup(self):
        for changes in (
            {"EEZ_SETTLEMENT_POLICY_ENABLED": "maybe"},
            {"EEZ_SETTLEMENT_POLICY_ENABLED": "false"},
            {"EEZ_SETTLEMENT_PURE_L2_MODE": "sometimes"},
            {"EEZ_SETTLEMENT_PURE_L2_MODE": "interval"},
            {"EEZ_SETTLEMENT_MAX_UNSETTLED_L2_BLOCKS": "0"},
            {"EEZ_SETTLEMENT_PURE_L2_INTERVAL_MS": "0"},
            {"EEZ_SETTLEMENT_BLOB_FULLNESS_BPS": "10001"},
            {"EEZ_L2_BLOCK_TIME_MS": "-1"},
            {"EEZ_RECENT_SETTLEMENTS": "1"},
            {"EEZ_SETTLEMENT_LOOKBACK_BLOCKS": "10000000"},
            {"EEZ_L1_NATIVE_CURRENCY": "<script>"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                settings(**{**POLICY, **changes})

    def test_general_progress_uses_applied_commitment_and_survives_restart(self):
        config = settings(**POLICY)
        rollup = {"status": "safe", "commitment": block_hash(100), "committedBlock": {"number": 100}}
        for latest, remaining, reached in ((196, 54, False), (249, 1, False), (250, 0, True), (256, 0, True)):
            with self.subTest(latest=latest):
                chains = {"l2": {"latest": {"number": latest}}}
                result = server.Collector(config)._settlement_progress(chains, rollup)
                self.assertEqual(result["remainingL2Blocks"], remaining)
                self.assertEqual(result["generalThresholdReached"], reached)
                self.assertEqual(result["estimatedGeneralRemainingMs"], remaining * 2000)
                self.assertEqual(result, server.Collector(config)._settlement_progress(chains, rollup))
        for status, latest in (("non-canonical", 196), ("missing", 196), ("safe", 99)):
            result = server.Collector(config)._settlement_progress(
                {"l2": {"latest": {"number": latest}}}, {**rollup, "status": status})
            self.assertFalse(result["available"])


class CanonicalHistoryTests(unittest.TestCase):
    def setUp(self):
        self.collector = server.Collector(settings(EEZ_REGISTRY_ADDRESS=REGISTRY, EEZ_RECENT_SETTLEMENTS="3", **POLICY))
        self.events, self.transactions, self.receipts = [], {}, {}
        for number, index, identity in ((40, 0, 1001), (65, 0, 1002), (65, 1, 1003), (90, 0, 1004)):
            tx_hash = block_hash(identity)
            self.transactions[tx_hash] = {"hash": tx_hash, "blockNumber": hex(number),
                "blockHash": block_hash(number), "transactionIndex": hex(index),
                "type": "0x3", "to": REGISTRY, "blobVersionedHashes": [block_hash(2001)]}
            self.events.append({"address": REGISTRY, "topics": [server.BATCH_POSTED_TOPIC],
                "transactionHash": tx_hash, "blockNumber": hex(number), "blockHash": block_hash(number),
                "transactionIndex": hex(index), "logIndex": "0x0"})
            self.receipts[tx_hash] = {**self.transactions[tx_hash], "transactionHash": tx_hash,
                "status": "0x1", "gasUsed": "0x1b782", "effectiveGasPrice": hex(2**60 + 3),
                "blobGasUsed": hex(server.BLOB_BYTES), "blobGasPrice": "0x7"}
        self.head = {"number": 110, "numberHex": hex(110), "hash": block_hash(110)}
        self.collector.l1.rpc = mock.Mock(side_effect=self.rpc)
        self.collector.l2.rpc = mock.Mock(return_value=[])

    def rpc(self, method, params):
        if method == "eth_getLogs":
            return self.events + [dict(self.events[-1])]  # Duplicate RPC log must not duplicate a post.
        if method == "eth_getTransactionByHash":
            return self.transactions[params[0]]
        if method == "eth_getTransactionReceipt":
            return self.receipts[params[0]]
        if method == "eth_getBlockByNumber":
            number = int(params[0], 16)
            transactions = sorted((tx for tx in self.transactions.values() if int(tx["blockNumber"], 16) == number),
                                  key=lambda tx: int(tx["transactionIndex"], 16))
            return {"number": hex(number), "hash": block_hash(number), "timestamp": hex(1000 + number * 12),
                    "transactions": [tx["hash"] for tx in transactions]}
        raise AssertionError((method, params))

    def test_idle_history_retains_old_posts_and_same_block_posts_are_distinct(self):
        result = self.collector._settlement_history(self.head, [])
        self.assertTrue(result["available"])
        self.assertEqual(result["postsInLookback"], 4)
        self.assertEqual(result["postsShown"], 3)
        self.assertTrue(result["hasMore"])
        self.assertEqual([p["transactionHash"] for p in result["settlements"]],
                         [block_hash(1004), block_hash(1003), block_hash(1002)])
        self.assertEqual(result["intervalsSeconds"], [300, 0])
        self.assertLess(result["settlements"][0]["l1BlockNumber"], self.head["number"] - 12)

    def test_receipt_costs_are_exact_decimal_strings_and_missing_cost_is_unknown(self):
        post = self.collector._settlement_history(self.head, [])["settlements"][0]
        execution = int("1b782", 16) * (2**60 + 3)
        self.assertEqual(post["executionCostWei"], str(execution))
        self.assertEqual(post["blobCostWei"], str(server.BLOB_BYTES * 7))
        self.assertEqual(post["totalCostWei"], str(execution + server.BLOB_BYTES * 7))
        self.receipts[block_hash(1004)].pop("blobGasPrice")
        post = self.collector._settlement_history(self.head, [])["settlements"][0]
        self.assertIsNone(post["totalCostWei"])
        self.assertEqual(post["executionCostWei"], str(execution))

    def test_reorg_and_receipt_mismatch_do_not_produce_confirmed_history(self):
        with self.assertRaisesRegex(server.RemoteCallError, "reorganized"):
            self.collector._settlement_history({**self.head, "hash": block_hash(999)}, [])
        self.receipts[block_hash(1004)]["blockHash"] = block_hash(999)
        with self.assertRaisesRegex(server.RemoteCallError, "receipt"):
            self.collector._settlement_history(self.head, [])

    def test_missing_receipt_is_unavailable_not_failed_or_zero_cost(self):
        self.receipts[block_hash(1004)] = None
        result = self.collector._settlement_history(self.head, [])["settlements"][0]
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["totalCostWei"])

    def test_decoder_rejects_pending_and_orphaned_transactions_before_blob_lookup(self):
        self.collector.blobscan = mock.Mock()
        transaction = self.transactions[block_hash(1004)]
        for changes in ({"blockNumber": None}, {"blockHash": block_hash(999)}, {"transactionIndex": "0x5"}):
            with self.subTest(changes=changes):
                self.transactions[block_hash(1004)] = {**transaction, **changes}
                with self.assertRaisesRegex(ValueError, "canonical L1"):
                    self.collector.decode_blob_transaction(block_hash(1004))
        self.collector.blobscan.get_json.assert_not_called()

    def test_snapshot_keeps_policy_and_history_when_recent_blocks_have_no_posts(self):
        chain = {"healthy": True, "latest": self.head, "safe": {"number": 100}}
        rollup = {"status": "safe", "commitment": block_hash(100), "committedBlock": {"number": 100}}
        with mock.patch.object(self.collector, "_chain", return_value=(chain, [])), \
                mock.patch.object(self.collector, "_rollup", return_value=rollup):
            snapshot = self.collector.collect()
        self.assertEqual(snapshot["metrics"]["protocolSettlementsInWindow"], 0)
        self.assertEqual(len(snapshot["blobSettlements"]), 3)
        self.assertEqual(snapshot["settlementProgress"]["unsettledL2Blocks"], 10)
        self.assertEqual(snapshot["configuration"]["settlementPolicy"]["pureL2Mode"], "always")
        self.assertEqual(snapshot["errors"], [])
        self.assertNotIn(EXTERNAL_RPC_ENV["EEZ_L1_RPC_URL"], json.dumps(snapshot))


class BeaconAvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.collector = server.Collector(settings(EEZ_BEACON_URL="http://beacon.example"))
        self.collector._beacon_meta = (1000, 12)
        self.block = {"hash": block_hash(90), "timestamp": hex(1000 + 90 * 12),
                      "blobGasUsed": hex(server.BLOB_BYTES * 2)}
        self.blob = "0x" + "00" * server.BLOB_BYTES

    def test_fulu_full_blob_bytes_are_available_and_cached_by_block_hash(self):
        self.collector.beacon.get_json = mock.Mock(return_value={"data": [self.blob, {"blob": self.blob}]})
        result = self.collector._beacon_for_block(self.block)
        self.assertTrue(result["available"])
        self.assertEqual(result["source"], "full-blobs")
        self.assertEqual(result["blobCount"], 2)
        self.assertEqual(result, self.collector._beacon_for_block(self.block))
        self.collector.beacon.get_json.assert_called_once_with("eth/v1/beacon/blobs/90")
        metrics = self.collector._metrics({}, [{"l1BlockHash": self.block["hash"], "beacon": result}] * 2)
        self.assertEqual(metrics["availableBlobSidecarsInWindow"], 2)

    def test_legacy_sidecar_fallback_only_for_unsupported_api(self):
        self.collector.beacon.get_json = mock.Mock(side_effect=[
            server.RemoteCallError("unsupported", http_status=404),
            {"data": [{"blob": self.blob, "index": str(i), "kzg_commitment": "0x123"} for i in range(2)]},
        ])
        result = self.collector._beacon_for_block(self.block)
        self.assertTrue(result["available"])
        self.assertEqual(result["source"], "blob-sidecars")
        self.assertEqual(result["indices"], [0, 1])

    def test_incomplete_malformed_or_unavailable_blobs_are_not_reported_available(self):
        for response in ({"data": []}, {"data": [self.blob]}, {"data": ["0xdead"]},
                         {"data": [self.blob, "0x" + "xx" * server.BLOB_BYTES]}):
            with self.subTest(response_size=len(str(response))):
                self.collector.beacon.get_json = mock.Mock(return_value=response)
                self.assertFalse(self.collector._beacon_for_block(self.block)["available"])
                self.assertEqual(self.collector.beacon.get_json.call_count, 1)
        self.collector.beacon.get_json = mock.Mock(side_effect=server.RemoteCallError("timeout"))
        self.assertFalse(self.collector._beacon_for_block(self.block)["available"])
        self.assertEqual(self.collector.beacon.get_json.call_count, 1)


if __name__ == "__main__":
    unittest.main()
