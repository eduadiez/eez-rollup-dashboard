import unittest
from copy import deepcopy

from test_server import rlp, compatibility_blobs
from blob_decoder import decode_native_blobs, BlobDecodeError


def block(number):
    header = [b"a" * 32, b"b" * 32, b"c" * 20, b"d" * 32,
              b"e" * 32, b"f" * 32, b"", 0, number, 30000000, 0, 100]
    return rlp([header, [], []])


def payload(count=3):
    return [1, count, [1, b"a" * 20, b"b" * 32, 30000000, b"", b"c" * 32],
            [], list(block(count + 1)), [], []]


def decode(body):
    return decode_native_blobs(compatibility_blobs(1, b"\x03" + rlp(body)), 1)["chainOperation"]["operations"]


class DerivableTests(unittest.TestCase):
    def test_implicit_empty_span_and_terminal_only(self):
        for count in (0, 154, 65535):
            with self.subTest(count=count):
                result = decode(payload(count))
                self.assertEqual(result["blockCount"], count + 1)
                self.assertEqual(result["implicitEmptyBlockCount"], count)
                self.assertEqual(result["derivedBlockCount"], count)
                self.assertEqual([b["number"] for b in result["blocks"]], [count + 1])
                self.assertIsNone(result["blockTxCounts"])

    def test_sparse_records_and_environment(self):
        body = payload(6)
        changed = deepcopy(body[2]); changed[0] = 2
        body[3] = [[1, 0, [b"opaque-signed-tx"]], [0, 1, block(3)], [1, 2, [changed, []]]]
        result = decode(body)
        self.assertEqual([r["number"] for r in result["records"]], [2, 3, 5])
        self.assertEqual([b["number"] for b in result["blocks"]], [3, 7])
        self.assertEqual(result["implicitEmptyBlockCount"], 3)
        self.assertEqual(result["derivedBlockCount"], 5)
        self.assertEqual(result["transactionCount"], 1)
        self.assertEqual(result["records"][2]["environment"]["timestampStepSeconds"], 2)

    def test_reject_malformed_and_boundary_inputs(self):
        cases = []
        def case(field, value, message):
            body = payload(); body[field] = value; cases.append((body, message))
        case(0, 2, "unsupported tag-3 profile")
        case(1, 65536, "ordinaryBlockCount exceeds")
        case(3, [[3, 0, [b"x"]]], "record position exceeds")
        case(3, [[0, 0, []]], "must contain transactions")
        case(3, [[0, 9, []]], "unsupported record kind")
        case(3, [[0, 2, [payload()[2], []]]], "must change")
        case(3, [[0, 1, block(2)]], "disagrees with record position")
        case(3, [[0, 0, [[1]]]], "RLP byte string")
        case(4, block(4), "must be an RLP list")
        case(4, list(block(3)), "must exceed")
        case(5, [b"wrong-encoding"], "must be an RLP list")
        case(6, [65536], "exceeds 65535")
        for index, value in ((0, 0), (1, b"short"), (2, b"short"), (3, 0), (4, b"x" * 33), (5, b"short")):
            body = payload(); body[2][index] = value; cases.append((body, "environment|bytes"))
        for body, message in cases:
            with self.subTest(message=message, field=body[:2]):
                with self.assertRaisesRegex(BlobDecodeError, message): decode(body)

    def test_reject_noop_after_active_environment_change(self):
        body = payload()
        changed = deepcopy(body[2]); changed[0] = 2
        body[3] = [[0, 2, [changed, []]], [0, 2, [changed, []]]]
        with self.assertRaisesRegex(BlobDecodeError, "must change"):
            decode(body)
