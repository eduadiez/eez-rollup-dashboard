"""Composer owns settlement queries; ordinary collection stays on read RPCs."""
import os
import unittest
from unittest import mock

from test_server import EXTERNAL_RPC_ENV, server


class ComposerRoutingTests(unittest.TestCase):
    def collector(self, composer=True):
        env = dict(EXTERNAL_RPC_ENV)
        if composer:
            env["EEZ_L2_COMPOSER_RPC_URL"] = "https://front.example/composer/l2"
        with mock.patch.dict(os.environ, env, clear=True):
            return server.Collector(server.Settings.from_env())

    def test_configured_endpoint_handles_both_correlations_and_search(self):
        collector = self.collector()
        self.assertEqual(collector.settlement_l2.base_url, "https://front.example/composer/l2")
        self.assertEqual(collector.l2.base_url, EXTERNAL_RPC_ENV["EEZ_L2_RPC_URL"])
        collector.l2.rpc = mock.Mock(side_effect=AssertionError("read RPC used for index"))
        collector.settlement_l2.rpc = mock.Mock(return_value=None)
        self.assertIsNone(collector.correlation("l2-to-l1", "42"))
        self.assertIsNone(collector.correlation("l1-to-l2", "42"))
        result = collector.settlement_search("l2:42")
        self.assertEqual(result["matches"], [])
        collector.settlement_l2.rpc.assert_has_calls([
            mock.call("eez_getSettlementByL2Block", ["0x2a"]),
            mock.call("eez_getSettledL2RangesByL1Block", ["0x2a"]),
            mock.call("eez_getSettlementByL2Block", ["0x2a"]),
        ])
        collector.l2.rpc.assert_not_called()

    def test_blob_rows_use_composer_but_receipts_and_live_blocks_use_read_rpc(self):
        collector = self.collector()
        block_hash, tx_hash = "0x" + "11" * 32, "0x" + "22" * 32
        block = {"number": "0x2a", "hash": block_hash, "timestamp": "0x64", "transactions": []}
        receipt = {"blockHash": block_hash, "transactionHash": tx_hash,
                   "transactionIndex": "0x0", "status": "0x1"}
        ranges = [{"l1TransactionHash": tx_hash, "l2Blocks": []}]
        collector.l1.rpc = mock.Mock(return_value=receipt)
        collector.l2.rpc = mock.Mock(return_value=block)
        collector.settlement_l2.rpc = mock.Mock(return_value=ranges)
        row = collector._settlement(block, {"hash": tx_hash, "transactionIndex": "0x0"})
        self.assertEqual(row["l2Ranges"], ranges)
        collector.l1.rpc.assert_called_once_with("eth_getTransactionReceipt", [tx_hash])
        collector.settlement_l2.rpc.assert_called_once_with("eez_getSettledL2RangesByL1Block", [block_hash])
        collector.live_block("l2", block_hash)
        collector.l2.rpc.assert_called_once_with("eth_getBlockByHash", [block_hash, False])

    def test_unconfigured_legacy_endpoint_uses_read_client(self):
        collector = self.collector(composer=False)
        self.assertIs(collector.settlement_l2, collector.l2)
        collector.l2.rpc = mock.Mock(return_value=[])
        self.assertEqual(collector.correlation("l1-to-l2", "42"), [])
        collector.l2.rpc.assert_called_once_with("eez_getSettledL2RangesByL1Block", ["0x2a"])

    def test_composer_errors_never_fall_back_to_regular_rpc(self):
        collector = self.collector()
        collector.l2.rpc = mock.Mock()
        collector.settlement_l2.rpc = mock.Mock(side_effect=server.RemoteCallError("Composer unavailable"))
        with self.assertRaisesRegex(server.RemoteCallError, "Composer unavailable"):
            collector.correlation("l1-to-l2", "42")
        result = collector.settlement_search("l2:42")
        self.assertIn("Composer unavailable", str(result))
        collector.l2.rpc.assert_not_called()
