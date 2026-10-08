"""Current RollupX wire fixtures and bounded malformed-input regressions."""
import json
import unittest
from pathlib import Path

from test_server import rlp, varint, compatibility_blobs
from blob_decoder import decode_operations, decode_native_blobs, BlobDecodeError

BENEFICIARY = bytes.fromhex('11' * 20)
TX = rlp([0, 1, 21000, bytes.fromhex('22' * 20), 1, b'', 27, 1, 1])


def wire(blocks=1, counts=b'\x00', beneficiaries=None, extra=None, transactions=()):
    beneficiaries = beneficiaries if beneficiaries is not None else varint(blocks) + BENEFICIARY
    extra = extra if extra is not None else varint(blocks) + b'\x00'
    return b'\x00' + varint(blocks) + counts + beneficiaries + extra + b''.join(varint(len(tx)) for tx in transactions) + b''.join(transactions)


class DirectOperationsTests(unittest.TestCase):
    def test_protocol_empty_vectors_including_u32_max_remain_sparse(self):
        fixtures = json.loads((Path(__file__).parent / 'fixtures/direct-v0-empty.json').read_text())
        for vector in fixtures['vectors']:
            with self.subTest(blocks=vector['blocks']):
                encoded = bytes.fromhex(vector['operations'][2:])
                self.assertEqual(len(encoded), vector['encodedBytes'])
                result = decode_native_blobs(compatibility_blobs(1, encoded), 1)['chainOperation']['operations']
                self.assertEqual(result['format'], 'direct-v0')
                self.assertEqual(result['blockCount'], vector['blocks'])
                self.assertEqual(result['transactionCount'], 0)
                self.assertEqual(len(result['countRuns']), 1)
                self.assertEqual(result['beneficiaryRuns'][0]['value'], vector['beneficiary'])
                self.assertIsNone(result['blockTxCounts'])
                self.assertEqual(result['blocks'], [])
                self.assertIsNone(result['l2EntryCount'])

    def test_live_chiado_batch_23422474(self):
        # Public ChainOperation bytes captured from the canonical batch that
        # previously returned "truncated RLP string". No private/wallet data.
        encoded = bytes.fromhex('00a501ffa501a5012ea2a5a1fe1ba4f4134c993e0c9a700706031e52a50100')
        result = decode_operations(encoded)
        self.assertEqual(result['blockCount'], 165)
        self.assertEqual(result['implicitEmptyBlockCount'], 165)
        self.assertEqual(result['bytes'], 31)

    def test_pure_transactions_and_independent_metadata_runs(self):
        result = decode_operations(wire(4, b'\x00\x02\xc0',
            beneficiaries=varint(1) + BENEFICIARY + varint(3) + b'b' * 20,
            extra=varint(4) + b'\x03abc', transactions=[TX, TX]))
        self.assertEqual(result['transactionCount'], 2)
        self.assertEqual([r['blocks'] for r in result['countRuns']], [1, 1, 2])
        self.assertEqual(result['implicitEmptyBlockCount'], 3)
        self.assertEqual([r['position'] for r in result['beneficiaryRuns']], [0, 1])
        self.assertEqual(result['extraDataRuns'][0]['value'], '0x616263')
        self.assertEqual(result['transactionBytes'], [len(TX), len(TX)])

    def test_positive_count_boundaries(self):
        for count in (1, 127, 128, 1428, 16383):
            token = bytes([count]) if count < 128 else bytes([0x80 | (count >> 8), count & 255])
            result = decode_operations(wire(counts=token, transactions=[TX] * count))
            self.assertEqual(result['transactionCount'], count)
            self.assertEqual(len(result['countRuns']), 1)

    def test_reject_truncation_and_noncanonical_columns(self):
        valid = wire()
        invalid = [valid[:end] for end in range(len(valid))]
        invalid += [valid + b'\x00', b'\x00\x00', b'\x00\x81\x00' + valid[2:],
            b'\x00\xff\xff\xff\xff\x10', wire(2, b'\x00\x00'), wire(1, b'\xc0'),
            wire(65, b'\xff\x40'), wire(65, b'\xff\xc1\x00'), wire(counts=b'\x80\x7f'),
            wire(2, b'\xc0', beneficiaries=varint(1) + BENEFICIARY + varint(1) + BENEFICIARY),
            wire(2, b'\xc0', extra=varint(1) + b'\x00' + varint(1) + b'\x00'),
            wire(1, beneficiaries=b'\x00' + BENEFICIARY),
            wire(1, extra=b'\x01\x21' + b'x' * 33),
            wire(counts=b'\x01'), wire(counts=b'\x01', transactions=[b'']),
            wire(counts=b'\x01', transactions=[b'\x03\xc0']),
            wire(counts=b'\x01', transactions=[b'\x76\xc0']),
            wire(counts=b'\x01', transactions=[b'\x02\xc1']),
            wire(counts=b'\x01', transactions=[b'\x02\xc0\x00'])]
        for encoded in invalid:
            with self.subTest(wire=encoded.hex()):
                with self.assertRaises(BlobDecodeError):
                    decode_operations(encoded)


if __name__ == '__main__':
    unittest.main()
