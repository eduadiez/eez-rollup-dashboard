import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


SERVER_PATH = Path(__file__).resolve().parents[1] / "app" / "server.py"
sys.path.insert(0, str(SERVER_PATH.parent))
SPEC = importlib.util.spec_from_file_location("eez_dashboard_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server
SPEC.loader.exec_module(server)


def rlp(value):
    if isinstance(value, int):
        value = b"" if value == 0 else value.to_bytes((value.bit_length() + 7) // 8, "big")
    if isinstance(value, bytes):
        if len(value) == 1 and value[0] < 0x80:
            return value
        if len(value) <= 55:
            return bytes([0x80 + len(value)]) + value
        size = len(value).to_bytes((len(value).bit_length() + 7) // 8, "big")
        return bytes([0xB7 + len(size)]) + size + value
    payload = b"".join(rlp(item) for item in value)
    if len(payload) <= 55:
        return bytes([0xC0 + len(payload)]) + payload
    size = len(payload).to_bytes((len(payload).bit_length() + 7) // 8, "big")
    return bytes([0xF7 + len(size)]) + size + payload


def varint(value):
    encoded = bytearray()
    while value >= 0x80:
        encoded.append((value & 0x7F) | 0x80)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def pack_stream(stream):
    capacity = 4096 * 31
    blobs = []
    for start in range(0, len(stream), capacity):
        chunk = stream[start : start + capacity]
        blob = bytearray(131_072)
        for source in range(0, len(chunk), 31):
            element = source // 31
            data = chunk[source : source + 31]
            for offset, byte in enumerate(data):
                blob[element * 32 + 31 - offset] = byte
        blobs.append(bytes(blob))
    return blobs


def compatibility_blobs(rollup_id, payload):
    stream = b"\x00\x02" + rollup_id.to_bytes(8, "little")
    stream += varint(len(payload)) + payload + b"\x01"
    return pack_stream(stream)


def native_semantic_blobs(rollup_id, payload):
    stream = b"\x00\x02" + rollup_id.to_bytes(8, "little")
    stream += varint(len(payload)) + payload
    stream += b"\x03" + rollup_id.to_bytes(8, "little") + varint(2) + b"tx"
    stream += b"\x04" + (0).to_bytes(8, "little")
    stream += bytes.fromhex("11" * 20) + bytes.fromhex("22" * 20)
    stream += (7).to_bytes(32, "little") + (0).to_bytes(8, "little")
    stream += varint(4) + b"call"
    stream += b"\x06" + varint(6) + b"result"
    stream += b"\x0a\x01"
    return pack_stream(stream)


def native_blobs_with_messages(rollup_id, payload, messages):
    stream = b"\x00\x02" + rollup_id.to_bytes(8, "little")
    stream += varint(len(payload)) + payload + messages + b"\x01"
    return pack_stream(stream)


def mutable_call(to_chain=0, value=7, data=b"call"):
    message = b"\x04" + to_chain.to_bytes(8, "little")
    message += bytes.fromhex("11" * 20) + bytes.fromhex("22" * 20)
    message += value.to_bytes(32, "little") + (0).to_bytes(8, "little")
    return message + varint(len(data)) + data


class DashboardUnitTests(unittest.TestCase):
    def test_quantities_are_decoded_without_floating_point(self):
        self.assertEqual(server.quantity("0x2a"), 42)
        self.assertEqual(server.quantity("42"), 42)
        self.assertIsNone(server.quantity("not-a-number"))

    def test_rollup_abi_result_decodes_address_commitment_and_escrow(self):
        address = "11" * 20
        commitment = "22" * 32
        raw = "0x" + ("00" * 12) + address + commitment + f"{10**18:064x}"
        decoded = server.decode_rollup_call(raw)
        self.assertEqual(decoded["rollupContract"], f"0x{address}")
        self.assertEqual(decoded["commitment"], f"0x{commitment}")
        self.assertEqual(decoded["escrowWei"], str(10**18))

    def test_rollup_abi_result_fails_closed_when_truncated(self):
        with self.assertRaises(server.RemoteCallError):
            server.decode_rollup_call("0x1234")

    def test_correlation_selectors_are_normalized_and_bounded(self):
        self.assertEqual(server.validate_selector("42"), "0x2a")
        self.assertEqual(server.validate_selector("0x2A"), "0x2a")
        block_hash = "0x" + "AB" * 32
        self.assertEqual(server.validate_selector(block_hash), block_hash.lower())
        for invalid in ("latest", "-1", "0x", "0xzz", str(2**64)):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    server.validate_selector(invalid)

    def test_settlement_search_accepts_explicit_chain_scope(self):
        self.assertEqual(server.validate_settlement_search("L1: #42"), ("l1", "0x2a"))
        block_hash = "0x" + "AB" * 32
        self.assertEqual(
            server.validate_settlement_search(f"l2:{block_hash}"),
            ("l2", block_hash.lower()),
        )
        for invalid in ("", "beacon:42", "l1:latest"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    server.validate_settlement_search(invalid)

    def test_settlement_search_resolves_ambiguous_number_in_both_directions(self):
        collector = object.__new__(server.Collector)
        collector.blobscan = None
        collector.l1 = mock.Mock()
        collector.l2 = mock.Mock()
        transaction_hash = "0x" + "11" * 32
        row = {
            "transactionHash": transaction_hash,
            "l1BlockNumber": 42,
            "transactionIndex": 0,
        }
        collector.l1.rpc.return_value = {
            "number": "0x2a",
            "transactions": [{"hash": transaction_hash, "type": "0x3"}],
        }
        collector.l2.rpc.return_value = {"l1TransactionHash": transaction_hash}
        collector._settlements = mock.Mock(return_value=[row])
        collector._settlement_by_transaction_hash = mock.Mock(return_value=row)

        result = collector.settlement_search("42")

        self.assertEqual(result["selector"], "0x2a")
        self.assertEqual(result["matches"], [row])
        collector.l1.rpc.assert_called_once_with(
            "eth_getBlockByNumber", ["0x2a", True]
        )
        collector.l2.rpc.assert_called_once_with(
            "eez_getSettlementByL2Block", ["0x2a"]
        )

    def test_block_summary_counts_type_three_transactions(self):
        summary = server.summarize_block(
            {
                "number": "0x10",
                "timestamp": "0x64",
                "gasUsed": "0x5",
                "gasLimit": "0xa",
                "transactions": [
                    {"type": "0x2", "hash": "0x01"},
                    {"type": "0x3", "hash": "0x02"},
                    {"type": "0x2", "hash": "0x03", "blobVersionedHashes": ["0xaa"]},
                ],
            }
        )
        self.assertEqual(summary["number"], 16)
        self.assertEqual(summary["transactionCount"], 3)
        self.assertEqual(summary["blobTransactionCount"], 2)

    def test_blob_decoder_decodes_compatibility_payload(self):
        payload = b"\x00" + rlp([[1], [b"\x02\xaa"], []])
        decoded = server.decode_native_blobs(
            compatibility_blobs(1, payload), 1
        )
        operation = decoded["chainOperation"]["operations"]
        self.assertEqual(decoded["messages"], ["ChainOperation", "CloseBlobStream"])
        self.assertEqual(operation["format"], "legacy-calldata")
        self.assertEqual(operation["blockTxCounts"], [1])
        self.assertEqual(operation["transactionCount"], 1)

    def test_blob_decoder_summarizes_self_contained_blocks(self):
        header = [
            b"\x11" * 32,
            b"\x22" * 32,
            b"\x33" * 20,
            b"\x44" * 32,
            b"\x55" * 32,
            b"\x66" * 32,
            b"\x00" * 256,
            0,
            7,
            30_000_000,
            21_000,
            1_700_000_000,
        ]
        encoded_block = rlp([header, [b"\x02\xaa"], []])
        payload = b"\x02" + rlp([[encoded_block], [], []])
        decoded = server.decode_native_blobs(
            compatibility_blobs(1, payload), 1
        )
        operation = decoded["chainOperation"]["operations"]
        self.assertEqual(operation["format"], "self-contained-blocks")
        self.assertEqual(operation["blockCount"], 1)
        self.assertEqual(operation["blocks"][0]["number"], 7)
        self.assertEqual(operation["blocks"][0]["transactionCount"], 1)

    def test_blob_decoder_decodes_native_cross_chain_semantics(self):
        payload = b"\x00" + rlp([[], [], []])
        decoded = server.decode_native_blobs(
            native_semantic_blobs(1, payload), 1
        )
        self.assertEqual(decoded["profile"], "native-semantics")
        self.assertEqual(
            decoded["messages"],
            [
                "ChainOperation",
                "InitiateCrossChainTransaction",
                "Call",
                "ReturnSuccess",
                "FinishCrossChainTransaction",
                "CloseBlobStream",
            ],
        )
        transaction = decoded["semanticTransactions"][0]
        self.assertEqual(transaction["originChain"], 1)
        self.assertEqual(transaction["callCount"], 1)
        self.assertEqual(transaction["calls"][0]["fromChain"], 1)
        self.assertEqual(transaction["calls"][0]["toChain"], 0)
        self.assertEqual(transaction["calls"][0]["value"], "7")
        self.assertEqual(transaction["calls"][0]["result"]["type"], "ReturnSuccess")
        self.assertEqual(transaction["maxCallDepth"], 1)
        self.assertEqual(
            [message["type"] for message in transaction["messages"]],
            [
                "InitiateCrossChainTransaction",
                "Call",
                "ReturnSuccess",
                "FinishCrossChainTransaction",
            ],
        )
        self.assertEqual(transaction["messages"][1]["toChain"], 0)
        self.assertEqual(transaction["messages"][2]["callIndex"], 0)

    def test_blob_decoder_exposes_forced_rollback_regions(self):
        payload = b"\x00" + rlp([[], [], []])
        messages = b"\x03" + (1).to_bytes(8, "little") + varint(2) + b"tx"
        messages += b"\x08" + mutable_call()
        messages += b"\x06" + varint(6) + b"result" + b"\x09\x0a"

        decoded = server.decode_native_blobs(
            native_blobs_with_messages(1, payload, messages), 1
        )

        transaction = decoded["semanticTransactions"][0]
        self.assertEqual(transaction["rollbackRegionCount"], 1)
        self.assertEqual(transaction["forcedRollbackCallCount"], 1)
        self.assertEqual(transaction["rollbackRegions"][0]["callCount"], 1)
        self.assertTrue(transaction["calls"][0]["forcedRollback"])
        self.assertEqual(transaction["calls"][0]["rollbackSpan"], 1)
        self.assertEqual(
            [message["type"] for message in transaction["messages"]],
            [
                "InitiateCrossChainTransaction",
                "Snapshot",
                "Call",
                "ReturnSuccess",
                "Revert",
                "FinishCrossChainTransaction",
            ],
        )

    def test_blob_decoder_rejects_empty_snapshot_region(self):
        payload = b"\x00" + rlp([[], [], []])
        messages = b"\x03" + (1).to_bytes(8, "little") + varint(2) + b"tx"
        messages += b"\x08\x09\x0a"
        with self.assertRaisesRegex(server.BlobDecodeError, "contains no calls"):
            server.decode_native_blobs(
                native_blobs_with_messages(1, payload, messages), 1
            )

    def test_blob_decoder_rejects_wrong_rollup_and_invalid_field_element(self):
        payload = b"\x00" + rlp([[], [], []])
        blobs = compatibility_blobs(2, payload)
        with self.assertRaises(server.BlobDecodeError):
            server.decode_native_blobs(blobs, 1)
        malformed = bytearray(blobs[0])
        malformed[0] = 1
        with self.assertRaises(server.BlobDecodeError):
            server.decode_native_blobs([bytes(malformed)], 2)

    def test_settings_reject_non_http_explorer_url(self):
        with mock.patch.dict(
            os.environ, {"EEZ_L1_EXPLORER_URL": "javascript:alert(1)"}, clear=True
        ):
            with self.assertRaises(ValueError):
                server.Settings.from_env()

    def test_settings_expose_only_validated_composer_rpc_urls(self):
        with mock.patch.dict(
            os.environ,
            {
                "EEZ_L1_COMPOSER_RPC_URL": "https://dev.example/composer/l1",
                "EEZ_L2_COMPOSER_RPC_URL": "https://dev.example/composer/l2",
            },
            clear=True,
        ):
            settings = server.Settings.from_env()
            self.assertEqual(
                settings.l1_composer_rpc_url,
                "https://dev.example/composer/l1",
            )
            self.assertEqual(
                settings.l2_composer_rpc_url,
                "https://dev.example/composer/l2",
            )

        with mock.patch.dict(
            os.environ,
            {"EEZ_L1_COMPOSER_RPC_URL": "data:text/plain,not-an-rpc"},
            clear=True,
        ):
            with self.assertRaises(ValueError):
                server.Settings.from_env()


if __name__ == "__main__":
    unittest.main()
