"""Strict, bounded decoder for EEZ's native version-00 semantic blob profile."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


BLOB_BYTES = 131_072
FIELD_ELEMENT_BYTES = 32
MAX_BLOBS = 15
MAX_RLP_DEPTH = 64
MAX_RLP_ITEMS = 2_000_000


class BlobDecodeError(ValueError):
    """The supplied blobs are not one canonical native EEZ stream."""


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


def _fixed(stream: bytes, position: int, size: int, field: str) -> tuple[bytes, int]:
    end = position + size
    if end > len(stream):
        raise BlobDecodeError(f"{field} is truncated")
    return stream[position:end], end


def _message_bytes(stream: bytes, position: int, field: str) -> tuple[bytes, int]:
    size, position = _varint(stream, position)
    end = position + size
    if end > len(stream):
        raise BlobDecodeError(f"{field} is truncated")
    return stream[position:end], end


def _preview(value: bytes, maximum: int = 64) -> str:
    suffix = "…" if len(value) > maximum else ""
    return f"0x{value[:maximum].hex()}{suffix}"


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


def decode_native_blobs(
    blobs: list[bytes], expected_chain_id: int
) -> dict[str, Any]:
    stream = unpack_blobs(blobs)
    if not stream or stream[0] != 0:
        version = stream[0] if stream else None
        raise BlobDecodeError(f"unsupported blob protocol version {version!r}")
    position = 1
    if position >= len(stream) or stream[position] != 2:
        raise BlobDecodeError("native stream must start with ChainOperation")
    position += 1
    raw_chain_id, position = _fixed(
        stream, position, 8, "ChainOperation chain id"
    )
    chain_id = int.from_bytes(raw_chain_id, "little")
    if chain_id != expected_chain_id:
        raise BlobDecodeError(
            f"ChainOperation chain id {chain_id} does not match rollup {expected_chain_id}"
        )
    operations, position = _message_bytes(
        stream, position, "ChainOperation payload"
    )
    messages = ["ChainOperation"]
    semantic_messages: list[dict[str, Any]] = []
    semantic_transactions: list[dict[str, Any]] = []
    contexts: list[int] = []
    open_calls: list[int] = []
    snapshots: list[int] = []
    current: dict[str, Any] | None = None

    while position < len(stream):
        message_type = stream[position]
        position += 1
        if message_type == 1:
            if current is not None or contexts or open_calls or snapshots:
                raise BlobDecodeError("CloseBlobStream appears inside a semantic transaction")
            messages.append("CloseBlobStream")
            break
        if message_type == 0:
            raise BlobDecodeError("CloseBlobStream is missing before zero padding")
        if message_type == 2:
            raise BlobDecodeError("native profile contains an extra ChainOperation")
        if message_type == 3:
            if current is not None or contexts:
                raise BlobDecodeError("cross-chain transactions cannot nest")
            raw_origin, position = _fixed(stream, position, 8, "transaction chain id")
            origin = int.from_bytes(raw_origin, "little")
            tx_data, position = _message_bytes(stream, position, "transaction tx_data")
            current = {
                "originChain": origin,
                "txDataBytes": len(tx_data),
                "txDataPreview": _preview(tx_data),
                "calls": [],
                "snapshotCount": 0,
                "maxCallDepth": 0,
            }
            contexts.append(origin)
            messages.append("InitiateCrossChainTransaction")
            semantic_messages.append({
                "type": "InitiateCrossChainTransaction",
                "chainId": origin,
                "txDataBytes": len(tx_data),
                "txDataPreview": _preview(tx_data),
            })
            continue
        if message_type in (4, 5):
            if current is None or not contexts:
                raise BlobDecodeError("Call appears outside a cross-chain transaction")
            if len(contexts) >= 64:
                raise BlobDecodeError("maximum call depth 64 exceeded")
            raw_target, position = _fixed(stream, position, 8, "Call to_chain")
            raw_from, position = _fixed(stream, position, 20, "Call from_address")
            raw_to, position = _fixed(stream, position, 20, "Call to_address")
            value = 0
            if message_type == 4:
                raw_value, position = _fixed(stream, position, 32, "Call value")
                value = int.from_bytes(raw_value, "little")
            raw_gas, position = _fixed(stream, position, 8, "Call gas")
            gas = int.from_bytes(raw_gas, "little")
            if gas != 0:
                raise BlobDecodeError(
                    f"semantic call gas {gas} is unsupported; expected zero"
                )
            data, position = _message_bytes(stream, position, "Call data")
            target = int.from_bytes(raw_target, "little")
            mode = "Call" if message_type == 4 else "StaticCall"
            call = {
                "index": len(current["calls"]),
                "depth": len(contexts) - 1,
                "type": mode,
                "fromChain": contexts[-1],
                "toChain": target,
                "fromAddress": f"0x{raw_from.hex()}",
                "toAddress": f"0x{raw_to.hex()}",
                "value": str(value),
                "gas": gas,
                "dataBytes": len(data),
                "dataPreview": _preview(data),
                "result": None,
            }
            current["calls"].append(call)
            current["maxCallDepth"] = max(current["maxCallDepth"], len(contexts))
            open_calls.append(call["index"])
            contexts.append(target)
            messages.append(mode)
            semantic_messages.append({key: value for key, value in call.items() if key != "result"})
            continue
        if message_type in (6, 7):
            if current is None or not open_calls or len(contexts) < 2:
                raise BlobDecodeError("semantic return has no open Call")
            if snapshots and snapshots[-1] == len(contexts):
                raise BlobDecodeError("semantic return crosses an open Snapshot")
            return_data, position = _message_bytes(stream, position, "return_data")
            call_index = open_calls.pop()
            contexts.pop()
            outcome = "ReturnSuccess" if message_type == 6 else "ReturnFail"
            result = {
                "type": outcome,
                "returnDataBytes": len(return_data),
                "returnDataPreview": _preview(return_data),
            }
            current["calls"][call_index]["result"] = result
            messages.append(outcome)
            semantic_messages.append(result | {"callIndex": call_index})
            continue
        if message_type == 8:
            if current is None:
                raise BlobDecodeError("Snapshot appears outside a cross-chain transaction")
            if len(snapshots) >= 64:
                raise BlobDecodeError("maximum snapshot depth 64 exceeded")
            snapshots.append(len(contexts))
            current["snapshotCount"] += 1
            messages.append("Snapshot")
            semantic_messages.append({"type": "Snapshot", "contextDepth": len(contexts)})
            continue
        if message_type == 9:
            if current is None or not snapshots:
                raise BlobDecodeError("Revert has no open Snapshot")
            if snapshots[-1] != len(contexts):
                raise BlobDecodeError("Revert crosses an open Call")
            snapshots.pop()
            messages.append("Revert")
            semantic_messages.append({"type": "Revert", "contextDepth": len(contexts)})
            continue
        if message_type == 10:
            if current is None:
                raise BlobDecodeError("FinishCrossChainTransaction has no open transaction")
            if len(contexts) != 1 or open_calls:
                raise BlobDecodeError("FinishCrossChainTransaction has an open Call")
            if snapshots:
                raise BlobDecodeError("FinishCrossChainTransaction has an open Snapshot")
            contexts.pop()
            current["callCount"] = len(current["calls"])
            current["mutableCallCount"] = sum(
                call["type"] == "Call" for call in current["calls"]
            )
            current["staticCallCount"] = sum(
                call["type"] == "StaticCall" for call in current["calls"]
            )
            current["successReturnCount"] = sum(
                call["result"] and call["result"]["type"] == "ReturnSuccess"
                for call in current["calls"]
            )
            current["failedReturnCount"] = sum(
                call["result"] and call["result"]["type"] == "ReturnFail"
                for call in current["calls"]
            )
            semantic_transactions.append(current)
            current = None
            messages.append("FinishCrossChainTransaction")
            semantic_messages.append({"type": "FinishCrossChainTransaction"})
            continue
        raise BlobDecodeError(f"unknown blob message type {message_type}")
    else:
        raise BlobDecodeError("CloseBlobStream is missing")

    if any(stream[position:]):
        raise BlobDecodeError("blob stream contains non-zero bytes after CloseBlobStream")
    return {
        "protocolVersion": 0,
        "profile": "native-semantics",
        "blobCount": len(blobs),
        "physicalBytes": len(blobs) * BLOB_BYTES,
        "logicalCapacityBytes": len(stream),
        "usedStreamBytes": position,
        "paddingBytes": len(stream) - position,
        "messages": messages,
        "semanticMessages": semantic_messages,
        "semanticTransactions": semantic_transactions,
        "chainOperation": {
            "chainId": chain_id,
            "operations": decode_operations(operations),
        },
    }


# Backward-compatible import for older deployments and focused callers. New
# code should use the name that reflects the native semantic profile.
decode_compatibility_blobs = decode_native_blobs
