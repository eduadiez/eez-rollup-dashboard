"""Strict, bounded decoder for EEZ's current blob-DA compatibility profile."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


BLOB_BYTES = 131_072
FIELD_ELEMENT_BYTES = 32
MAX_BLOBS = 15
MAX_RLP_DEPTH = 64
MAX_RLP_ITEMS = 2_000_000


class BlobDecodeError(ValueError):
    """The supplied blobs are not one canonical EEZ compatibility stream."""


@dataclass
class _RlpBudget:
    items: int = 0

    def consume(self) -> None:
        self.items += 1
        if self.items > MAX_RLP_ITEMS:
            raise BlobDecodeError("RLP item limit exceeded")


@dataclass
class _RlpList:
    data: bytes
    start: int
    end: int
    depth: int
    budget: _RlpBudget


def _length(data: bytes, start: int, size: int) -> int:
    end = start + size
    if size == 0 or end > len(data):
        raise BlobDecodeError("truncated RLP length")
    raw = data[start:end]
    if raw[0] == 0:
        raise BlobDecodeError("non-canonical RLP length")
    return int.from_bytes(raw, "big")


def _rlp_item(
    data: bytes, position: int, budget: _RlpBudget, depth: int = 0
) -> tuple[bytes | _RlpList, int]:
    if depth > MAX_RLP_DEPTH:
        raise BlobDecodeError("RLP nesting limit exceeded")
    if position >= len(data):
        raise BlobDecodeError("truncated RLP item")
    budget.consume()
    prefix = data[position]
    if prefix <= 0x7F:
        return bytes([prefix]), position + 1
    if prefix <= 0xB7:
        size = prefix - 0x80
        start = position + 1
        end = start + size
        if end > len(data):
            raise BlobDecodeError("truncated RLP string")
        value = data[start:end]
        if size == 1 and value[0] <= 0x7F:
            raise BlobDecodeError("non-canonical RLP string")
        return value, end
    if prefix <= 0xBF:
        size_of_size = prefix - 0xB7
        size = _length(data, position + 1, size_of_size)
        if size <= 55:
            raise BlobDecodeError("non-canonical long RLP string")
        start = position + 1 + size_of_size
        end = start + size
        if end > len(data):
            raise BlobDecodeError("truncated long RLP string")
        return data[start:end], end

    if prefix <= 0xF7:
        payload_size = prefix - 0xC0
        start = position + 1
    else:
        size_of_size = prefix - 0xF7
        payload_size = _length(data, position + 1, size_of_size)
        if payload_size <= 55:
            raise BlobDecodeError("non-canonical long RLP list")
        start = position + 1 + size_of_size
    end = start + payload_size
    if end > len(data):
        raise BlobDecodeError("truncated RLP list")
    return _RlpList(data, start, end, depth, budget), end


def _decode_rlp_exact(data: bytes) -> bytes | _RlpList:
    value, end = _rlp_item(data, 0, _RlpBudget())
    if end != len(data):
        raise BlobDecodeError(f"RLP payload has {len(data) - end} trailing bytes")
    return value


def _iter_list(value: Any, field: str):
    if not isinstance(value, _RlpList):
        raise BlobDecodeError(f"{field} must be an RLP list")
    cursor = value.start
    while cursor < value.end:
        child, next_cursor = _rlp_item(
            value.data, cursor, value.budget, value.depth + 1
        )
        if next_cursor > value.end:
            raise BlobDecodeError(f"{field} child crosses its RLP list boundary")
        yield child
        cursor = next_cursor
    if cursor != value.end:
        raise BlobDecodeError(f"{field} has a malformed RLP boundary")


def _as_list(value: Any, field: str) -> list[Any]:
    return list(_iter_list(value, field))


def _as_bytes(value: Any, field: str) -> bytes:
    if not isinstance(value, bytes):
        raise BlobDecodeError(f"{field} must be an RLP byte string")
    return value


def _as_byte_vector(value: Any, field: str) -> bytes:
    if isinstance(value, bytes):
        return value
    output = bytearray()
    for index, item in enumerate(_iter_list(value, field)):
        output.append(_integer(item, f"{field}[{index}]", 255))
    return bytes(output)


def _integer(value: Any, field: str, maximum: int | None = None) -> int:
    raw = _as_bytes(value, field)
    if raw and raw[0] == 0:
        raise BlobDecodeError(f"{field} is a non-canonical integer")
    number = int.from_bytes(raw, "big")
    if maximum is not None and number > maximum:
        raise BlobDecodeError(f"{field} exceeds {maximum}")
    return number


def _byte_list(value: Any, field: str) -> list[bytes]:
    return [
        _as_byte_vector(item, f"{field}[{index}]")
        for index, item in enumerate(_as_list(value, field))
    ]


def _integer_list(value: Any, field: str, maximum: int) -> list[int]:
    return [
        _integer(item, f"{field}[{index}]", maximum)
        for index, item in enumerate(_as_list(value, field))
    ]


def _hex_field(header: list[Any], index: int, field: str, expected: int) -> str:
    raw = _as_bytes(header[index], field)
    if len(raw) != expected:
        raise BlobDecodeError(f"{field} must contain {expected} bytes")
    return f"0x{raw.hex()}"


def _block_summary(encoded: bytes, index: int) -> dict[str, Any]:
    block = _as_list(_decode_rlp_exact(encoded), f"blocks[{index}]")
    if len(block) < 3:
        raise BlobDecodeError(f"blocks[{index}] has fewer than three body fields")
    header = _as_list(block[0], f"blocks[{index}].header")
    if len(header) < 12:
        raise BlobDecodeError(f"blocks[{index}].header is truncated")
    transactions = _as_list(block[1], f"blocks[{index}].transactions")
    ommers = _as_list(block[2], f"blocks[{index}].ommers")
    withdrawals = (
        _as_list(block[3], f"blocks[{index}].withdrawals") if len(block) > 3 else None
    )
    requests = (
        _as_list(block[4], f"blocks[{index}].requests") if len(block) > 4 else None
    )
    return {
        "index": index,
        "number": _integer(header[8], f"blocks[{index}].number", 2**64 - 1),
        "parentHash": _hex_field(header, 0, f"blocks[{index}].parentHash", 32),
        "stateRoot": _hex_field(header, 3, f"blocks[{index}].stateRoot", 32),
        "gasLimit": _integer(header[9], f"blocks[{index}].gasLimit", 2**64 - 1),
        "gasUsed": _integer(header[10], f"blocks[{index}].gasUsed", 2**64 - 1),
        "timestamp": _integer(header[11], f"blocks[{index}].timestamp", 2**64 - 1),
        "transactionCount": len(transactions),
        "ommerCount": len(ommers),
        "withdrawalCount": len(withdrawals) if withdrawals is not None else None,
        "requestCount": len(requests) if requests is not None else None,
        "rlpBytes": len(encoded),
    }


def decode_operations(payload: bytes) -> dict[str, Any]:
    if not payload:
        raise BlobDecodeError("ChainOperation payload is empty")
    tag = payload[0]
    body = _as_list(_decode_rlp_exact(payload[1:]), "payload")
    if tag == 0:
        if len(body) != 3:
            raise BlobDecodeError("tag-0 payload must contain three fields")
        counts = _integer_list(body[0], "blockTxCounts", 2**16 - 1)
        transactions = _byte_list(body[1], "transactions")
        entries = _byte_list(body[2], "l2Entries")
        groups: list[int] = []
        blocks: list[dict[str, Any]] = []
        name = "legacy-calldata"
    elif tag == 1:
        if len(body) != 4:
            raise BlobDecodeError("tag-1 payload must contain four fields")
        counts = _integer_list(body[0], "blockTxCounts", 2**16 - 1)
        transactions = _byte_list(body[1], "transactions")
        entries = _byte_list(body[2], "l2Entries")
        groups = _integer_list(body[3], "outboundGroupSizes", 2**16 - 1)
        blocks = []
        name = "grouped-calldata"
    elif tag == 2:
        if len(body) != 3:
            raise BlobDecodeError("tag-2 payload must contain three fields")
        encoded_blocks = _byte_list(body[0], "blocks")
        blocks = [_block_summary(encoded, index) for index, encoded in enumerate(encoded_blocks)]
        counts = [block["transactionCount"] for block in blocks]
        transactions = []
        entries = _byte_list(body[1], "l2Entries")
        groups = _integer_list(body[2], "outboundGroupSizes", 2**16 - 1)
        name = "self-contained-blocks"
        numbers = [block["number"] for block in blocks]
        if any(current != previous + 1 for previous, current in zip(numbers, numbers[1:])):
            raise BlobDecodeError("self-contained block numbers are not contiguous")
    else:
        raise BlobDecodeError(f"unsupported ChainOperation payload tag 0x{tag:02x}")

    transaction_count = sum(counts)
    if tag in (0, 1) and transaction_count != len(transactions):
        raise BlobDecodeError(
            "transaction count does not match the sum of blockTxCounts"
        )
    return {
        "tag": tag,
        "format": name,
        "bytes": len(payload),
        "blockCount": len(counts),
        "blockTxCounts": counts,
        "transactionCount": transaction_count,
        "transactionBytes": [len(transaction) for transaction in transactions],
        "l2EntryCount": len(entries),
        "l2EntryBytes": [len(entry) for entry in entries],
        "outboundGroupSizes": groups,
        "blocks": blocks,
    }


def _varint(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    for byte_index in range(5):
        if position >= len(data):
            raise BlobDecodeError("blob message stream is truncated")
        byte = data[position]
        position += 1
        if byte_index == 4 and byte & 0xF0:
            raise BlobDecodeError("message length exceeds u32")
        value |= (byte & 0x7F) << (7 * byte_index)
        if byte < 0x80:
            return value, position
    raise BlobDecodeError("message length varint uses more than five bytes")


def unpack_blobs(blobs: list[bytes]) -> bytes:
    if not blobs:
        raise BlobDecodeError("blob list is empty")
    if len(blobs) > MAX_BLOBS:
        raise BlobDecodeError(f"blob count exceeds {MAX_BLOBS}")
    logical = bytearray()
    for blob_index, blob in enumerate(blobs):
        if len(blob) != BLOB_BYTES:
            raise BlobDecodeError(
                f"blob {blob_index} has {len(blob)} bytes; expected {BLOB_BYTES}"
            )
        for element_index, offset in enumerate(range(0, BLOB_BYTES, FIELD_ELEMENT_BYTES)):
            element = blob[offset : offset + FIELD_ELEMENT_BYTES]
            if element[0] != 0:
                raise BlobDecodeError(
                    f"blob {blob_index} field element {element_index} has a non-zero high byte"
                )
            logical.extend(reversed(element[1:]))
    return bytes(logical)


def decode_compatibility_blobs(
    blobs: list[bytes], expected_chain_id: int
) -> dict[str, Any]:
    stream = unpack_blobs(blobs)
    if not stream or stream[0] != 0:
        version = stream[0] if stream else None
        raise BlobDecodeError(f"unsupported blob protocol version {version!r}")
    position = 1
    if position >= len(stream) or stream[position] != 2:
        raise BlobDecodeError("compatibility stream must start with ChainOperation")
    position += 1
    if position + 8 > len(stream):
        raise BlobDecodeError("ChainOperation chain id is truncated")
    chain_id = int.from_bytes(stream[position : position + 8], "little")
    position += 8
    if chain_id != expected_chain_id:
        raise BlobDecodeError(
            f"ChainOperation chain id {chain_id} does not match rollup {expected_chain_id}"
        )
    operation_length, position = _varint(stream, position)
    end = position + operation_length
    if end > len(stream):
        raise BlobDecodeError("ChainOperation payload is truncated")
    operations = stream[position:end]
    position = end
    if position >= len(stream) or stream[position] != 1:
        raise BlobDecodeError("ChainOperation must be followed by CloseBlobStream")
    position += 1
    if any(stream[position:]):
        raise BlobDecodeError("blob stream contains non-zero bytes after CloseBlobStream")
    return {
        "protocolVersion": 0,
        "profile": "compatibility",
        "blobCount": len(blobs),
        "physicalBytes": len(blobs) * BLOB_BYTES,
        "logicalCapacityBytes": len(stream),
        "usedStreamBytes": position,
        "paddingBytes": len(stream) - position,
        "messages": ["ChainOperation", "CloseBlobStream"],
        "chainOperation": {
            "chainId": chain_id,
            "operations": decode_operations(operations),
        },
    }
