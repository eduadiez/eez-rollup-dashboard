#!/usr/bin/env python3
"""Read-only EEZ network observability dashboard.

The service deliberately exposes a small, fixed API instead of proxying JSON-RPC.
It keeps RPC credentials server-side, bounds the block window, and caches snapshots.
"""

from __future__ import annotations

import itertools
import json
import logging
import mimetypes
import os
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from blob_decoder import BlobDecodeError, decode_native_blobs
from live import SnapshotFeed, serve_websocket


LOG = logging.getLogger("eez-dashboard")
STATIC_DIR = Path(__file__).resolve().parent / "static"
ROLLUPS_SELECTOR = "ef678d27"  # rollups(uint64)
SELECTOR_RE = re.compile(r"^(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,20})$")
HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
BATCH_POSTED_TOPIC = "0xd6f8d71ce42a799b91f399271f4b0e91f85eb87fac7bb2cedd4b3a52fad36182"
BLOB_BYTES = 131072


class RemoteCallError(RuntimeError):
    """An upstream RPC or HTTP request failed."""

    def __init__(self, message: str, *, http_status: int | None = None):
        super().__init__(message)
        self.http_status = http_status


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def env_http_url(
    name: str, *, required: bool = False, allow_query: bool = False
) -> str | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        if required:
            raise ValueError(f"{name} is required; set an absolute HTTP(S) URL")
        return None
    try:
        parsed = urlparse(raw)
        valid = parsed.scheme in {"http", "https"} and bool(parsed.hostname)
        # Accessing port also validates malformed and out-of-range ports.
        valid = valid and (parsed.port is None or parsed.port > 0)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(f"{name} must be an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise ValueError(f"{name} must not contain user information or a fragment")
    if parsed.query and not allow_query:
        raise ValueError(f"{name} must not contain a query")
    return raw


def env_ws_url(name: str) -> str | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
        valid = (parsed.scheme in {"ws", "wss"} and bool(parsed.hostname)
                 and (parsed.port is None or parsed.port > 0)
                 and parsed.username is None and parsed.password is None
                 and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(f"{name} must be an absolute WS(S) URL without user information or a fragment")
    return raw


def settlement_policy_from_env() -> dict[str, Any] | None:
    """Public operator configuration, not a runtime policy decision source."""
    names = {
        "mode": "EEZ_SETTLEMENT_PURE_L2_MODE",
        "interval": "EEZ_SETTLEMENT_PURE_L2_INTERVAL_MS",
        "general": "EEZ_SETTLEMENT_MAX_UNSETTLED_L2_BLOCKS",
        "fullness": "EEZ_SETTLEMENT_BLOB_FULLNESS_BPS",
    }
    raw = os.getenv("EEZ_SETTLEMENT_POLICY_ENABLED", "").strip()
    if raw not in {"", "0", "false", "no", "off", "1", "true", "yes", "on"}:
        raise ValueError("EEZ_SETTLEMENT_POLICY_ENABLED must be a boolean")
    enabled = raw in {"1", "true", "yes", "on"}
    supplied = {key: os.getenv(name, "").strip() for key, name in names.items()}
    if not enabled:
        if any(supplied.values()):
            raise ValueError("settlement policy settings require EEZ_SETTLEMENT_POLICY_ENABLED=true")
        return {"enabled": False} if raw else None
    mode = supplied["mode"]
    if mode not in {"always", "interval"}:
        raise ValueError("EEZ_SETTLEMENT_PURE_L2_MODE must be always or interval")
    if not supplied["general"]:
        raise ValueError("EEZ_SETTLEMENT_MAX_UNSETTLED_L2_BLOCKS is required")
    general = env_int(names["general"], 0, 1, 2**53 - 1)
    interval = env_int(names["interval"], 0, 1, 2**53 - 1) if supplied["interval"] else None
    if mode == "interval" and interval is None:
        raise ValueError("EEZ_SETTLEMENT_PURE_L2_INTERVAL_MS is required for interval mode")
    fullness = supplied["fullness"]
    fullness_bps = None if fullness in {"", "off"} else env_int(names["fullness"], 0, 1, 10000)
    block_ms = env_int("EEZ_L2_BLOCK_TIME_MS", 0, 1, 2**53 - 1) if os.getenv("EEZ_L2_BLOCK_TIME_MS") else None
    return {
        "enabled": True, "source": "operator-configuration", "pureL2Mode": mode,
        "pureL2IntervalMs": interval if mode == "interval" else None,
        "maxUnsettledL2Blocks": general, "blobFullnessBps": fullness_bps,
        "l2BlockTimeMs": block_ms,
        "nominalGeneralIntervalMs": general * block_ms if block_ms is not None else None,
    }


@dataclass(frozen=True)
class Settings:
    l1_rpc_url: str
    l2_rpc_url: str
    beacon_url: str | None
    registry_address: str | None
    rollup_id: int
    recent_blocks: int
    refresh_seconds: int
    request_timeout_seconds: int
    bind_host: str
    bind_port: int
    l1_explorer_url: str | None
    l2_explorer_url: str | None
    blobscan_url: str | None
    blobscan_api_url: str | None
    l1_composer_rpc_url: str | None
    l2_composer_rpc_url: str | None
    settlement_policy: dict[str, Any] | None = None
    settlement_lookback_blocks: int = 512
    recent_settlements: int = 12
    l1_native_currency: str = "ETH"
    l1_ws_url: str | None = None
    l2_ws_url: str | None = None
    live_update_seconds: int = 1
    head_delay_warning_seconds: int = 30

    @classmethod
    def from_env(cls) -> "Settings":
        registry = os.getenv("EEZ_REGISTRY_ADDRESS")
        if registry and not ADDRESS_RE.fullmatch(registry):
            raise ValueError("EEZ_REGISTRY_ADDRESS must be a 20-byte hex address")
        currency = os.getenv("EEZ_L1_NATIVE_CURRENCY", "ETH").strip()
        if not re.fullmatch(r"[A-Z][A-Z0-9]{0,9}", currency):
            raise ValueError("EEZ_L1_NATIVE_CURRENCY must be a short uppercase currency symbol")
        refresh_seconds = env_int("EEZ_REFRESH_SECONDS", 4, 2, 60)
        live_update_seconds = env_int("EEZ_LIVE_UPDATE_SECONDS", 1, 1, 60)
        if live_update_seconds > refresh_seconds:
            raise ValueError("EEZ_LIVE_UPDATE_SECONDS must not exceed EEZ_REFRESH_SECONDS")
        return cls(
            l1_rpc_url=env_http_url(
                "EEZ_L1_RPC_URL", required=True, allow_query=True
            ),
            l2_rpc_url=env_http_url(
                "EEZ_L2_RPC_URL", required=True, allow_query=True
            ),
            beacon_url=env_http_url("EEZ_BEACON_URL", allow_query=True),
            registry_address=registry.lower() if registry else None,
            rollup_id=env_int("EEZ_ROLLUP_ID", 1, 0, 2**64 - 1),
            recent_blocks=env_int("EEZ_RECENT_BLOCKS", 12, 4, 32),
            refresh_seconds=refresh_seconds,
            request_timeout_seconds=env_int(
                "EEZ_REQUEST_TIMEOUT_SECONDS", 4, 1, 30
            ),
            bind_host=os.getenv("EEZ_DASHBOARD_HOST", "0.0.0.0"),
            bind_port=env_int("EEZ_DASHBOARD_PORT", 8080, 1, 65535),
            l1_explorer_url=env_http_url("EEZ_L1_EXPLORER_URL"),
            l2_explorer_url=env_http_url("EEZ_L2_EXPLORER_URL"),
            blobscan_url=env_http_url("EEZ_BLOBSCAN_URL"),
            blobscan_api_url=env_http_url(
                "EEZ_BLOBSCAN_API_URL", allow_query=True
            ),
            l1_composer_rpc_url=env_http_url("EEZ_L1_COMPOSER_RPC_URL"),
            l2_composer_rpc_url=env_http_url("EEZ_L2_COMPOSER_RPC_URL"),
            settlement_policy=settlement_policy_from_env(),
            settlement_lookback_blocks=env_int("EEZ_SETTLEMENT_LOOKBACK_BLOCKS", 512, 32, 4096),
            recent_settlements=env_int("EEZ_RECENT_SETTLEMENTS", 12, 2, 64),
            l1_native_currency=currency,
            l1_ws_url=env_ws_url("EEZ_L1_WS_URL"),
            l2_ws_url=env_ws_url("EEZ_L2_WS_URL"),
            live_update_seconds=live_update_seconds,
            head_delay_warning_seconds=env_int("EEZ_HEAD_DELAY_WARNING_SECONDS", 30, 1, 3600),
        )


def head_freshness(timestamp: Any, observed_at: float, warning_seconds: int) -> dict[str, Any]:
    """RPC reachability and a fresh snapshot do not prove the chain is advancing."""
    timestamp = quantity(timestamp)
    age = max(0, int(observed_at - timestamp)) if timestamp is not None else None
    return {"ageSeconds": age, "warningSeconds": warning_seconds,
            "status": "unavailable" if age is None else "delayed" if age > warning_seconds else "current"}


class JsonClient:
    def __init__(self, base_url: str, timeout: int):
        self.base_url = base_url
        self.timeout = timeout
        self._ids = itertools.count(1)
        self._id_lock = threading.Lock()

    def rpc(self, method: str, params: list[Any] | None = None) -> Any:
        with self._id_lock:
            request_id = next(self._ids)
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or [],
            }
        ).encode()
        request = Request(
            self.base_url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "eez-network-dashboard/1",
            },
            method="POST",
        )
        payload = self._open_json(request)
        if payload.get("error") is not None:
            error = payload["error"]
            raise RemoteCallError(
                f"{method}: {error.get('message', 'JSON-RPC error')} "
                f"({error.get('code', 'unknown')})"
            )
        if "result" not in payload:
            raise RemoteCallError(f"{method}: response has no result")
        return payload["result"]

    def get_json(self, path: str) -> Any:
        base = urlparse(self.base_url)
        url = base._replace(path=f"{base.path.rstrip('/')}/{path.lstrip('/')}")
        request = Request(
            url.geturl(),
            headers={"Accept": "application/json", "User-Agent": "eez-network-dashboard/1"},
        )
        return self._open_json(request)

    def _open_json(self, request: Request) -> Any:
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            detail = error.read(512).decode("utf-8", "replace")
            raise RemoteCallError(
                f"upstream HTTP {error.code}: {detail or error.reason}", http_status=error.code
            ) from error
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            raise RemoteCallError(f"upstream request failed: {error}") from error


def quantity(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value, 16) if value.startswith("0x") else int(value)
        except ValueError:
            return None
    return None


def utc_timestamp(value: Any) -> str | None:
    seconds = quantity(value)
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def summarize_block(block: dict[str, Any]) -> dict[str, Any]:
    transactions = block.get("transactions") or []
    blob_transactions = [
        transaction
        for transaction in transactions
        if isinstance(transaction, dict)
        and (
            str(transaction.get("type", "")).lower() == "0x3"
            or bool(transaction.get("blobVersionedHashes"))
        )
    ]
    return {
        "number": quantity(block.get("number")),
        "numberHex": block.get("number"),
        "hash": block.get("hash"),
        "parentHash": block.get("parentHash"),
        "timestamp": quantity(block.get("timestamp")),
        "timestampIso": utc_timestamp(block.get("timestamp")),
        "transactionCount": len(transactions),
        "gasUsed": quantity(block.get("gasUsed")),
        "gasLimit": quantity(block.get("gasLimit")),
        "baseFeePerGas": quantity(block.get("baseFeePerGas")),
        "blobGasUsed": quantity(block.get("blobGasUsed")),
        "excessBlobGas": quantity(block.get("excessBlobGas")),
        "blobTransactionCount": len(blob_transactions),
    }


def decode_rollup_call(raw: str) -> dict[str, Any]:
    if not isinstance(raw, str) or not raw.startswith("0x"):
        raise RemoteCallError("rollups call returned malformed hex")
    data = raw[2:]
    if len(data) < 192 or any(character not in "0123456789abcdefABCDEF" for character in data):
        raise RemoteCallError("rollups call returned fewer than three ABI words")
    words = [data[offset : offset + 64] for offset in range(0, 192, 64)]
    return {
        "rollupContract": f"0x{words[0][-40:]}",
        "commitment": f"0x{words[1]}",
        "escrowWei": str(int(words[2], 16)),
        "escrowWeiHex": f"0x{words[2].lstrip('0') or '0'}",
    }


def validate_selector(raw: str) -> str:
    selector = raw.strip()
    if not SELECTOR_RE.fullmatch(selector):
        raise ValueError("block must be a decimal number, hex quantity, or 32-byte hash")
    if selector.startswith("0x") and len(selector) == 66:
        return selector.lower()
    value = int(selector, 16) if selector.startswith("0x") else int(selector)
    if value > 2**64 - 1:
        raise ValueError("block number exceeds uint64")
    return hex(value)


def validate_settlement_search(raw: str) -> tuple[str | None, str]:
    query = raw.strip()
    if not query:
        raise ValueError("search query is required")
    scope: str | None = None
    scoped = re.fullmatch(r"(l1|l2)\s*:\s*(.+)", query, re.IGNORECASE)
    if scoped:
        scope = scoped.group(1).lower()
        query = scoped.group(2).strip()
    elif ":" in query:
        raise ValueError("block scope must be l1: or l2:")
    return scope, validate_selector(query.removeprefix("#"))


class Collector:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.l1 = JsonClient(settings.l1_rpc_url, settings.request_timeout_seconds)
        self.l2 = JsonClient(settings.l2_rpc_url, settings.request_timeout_seconds)
        self.beacon = (
            JsonClient(settings.beacon_url, settings.request_timeout_seconds)
            if settings.beacon_url
            else None
        )
        self.blobscan = (
            JsonClient(settings.blobscan_api_url, settings.request_timeout_seconds)
            if settings.blobscan_api_url
            else None
        )
        self._beacon_meta: tuple[int, int] | None = None
        self._beacon_meta_lock = threading.Lock()
        self._beacon_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._beacon_cache_lock = threading.Lock()

    def collect(self) -> dict[str, Any]:
        started = time.monotonic()
        errors: list[dict[str, str]] = []
        chains: dict[str, Any] = {}
        raw_l1_blocks: list[dict[str, Any]] = []

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="chain") as executor:
            futures = {
                executor.submit(self._chain, self.l1, "l1", True): "l1",
                executor.submit(self._chain, self.l2, "l2", False): "l2",
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    result, raw_blocks = future.result()
                    chains[name] = result
                    if name == "l1":
                        raw_l1_blocks = raw_blocks
                except Exception as error:  # A partial dashboard is more useful than HTTP 500.
                    LOG.warning("%s collection failed: %s", name, error)
                    errors.append({"component": name, "message": str(error)})
                    chains[name] = {"name": name.upper(), "healthy": False, "error": str(error)}

        rollup = self._capture(errors, "rollup", self._rollup, chains) or {
            "configured": bool(self.settings.registry_address),
            "status": "unavailable",
        }
        settlements = (
            self._capture(errors, "blob-settlements", self._settlements, raw_l1_blocks)
            or []
        )
        metrics = self._metrics(chains, settlements)
        history = self._capture(
            errors, "settlement-history", self._settlement_history,
            chains.get("l1", {}).get("latest"), settlements,
        ) or {"configured": bool(self.settings.registry_address), "available": False}
        if history.get("available"):
            settlements = history.pop("settlements")
        progress = self._settlement_progress(chains, rollup)
        generated_at = datetime.now(timezone.utc)
        for chain in chains.values():
            chain["freshness"] = head_freshness(
                (chain.get("latest") or {}).get("timestamp"), generated_at.timestamp(),
                self.settings.head_delay_warning_seconds,
            )

        return {
            "generatedAt": generated_at.isoformat().replace("+00:00", "Z"),
            "collectionDurationMs": round((time.monotonic() - started) * 1000),
            "healthy": all(chains.get(name, {}).get("healthy")
                           and chains[name]["freshness"]["status"] == "current"
                           for name in ("l1", "l2")),
            "errors": errors,
            "configuration": {
                "rollupId": self.settings.rollup_id,
                "registryAddress": self.settings.registry_address,
                "recentBlockWindow": self.settings.recent_blocks,
                "refreshSeconds": self.settings.refresh_seconds,
                "liveUpdateSeconds": self.settings.live_update_seconds,
                "headDelayWarningSeconds": self.settings.head_delay_warning_seconds,
                "settlementPolicy": self.settings.settlement_policy,
                "nativeCurrency": self.settings.l1_native_currency,
                "explorers": {
                    "l1": self.settings.l1_explorer_url,
                    "l2": self.settings.l2_explorer_url,
                    "blobscan": self.settings.blobscan_url,
                },
                "composerRpc": {
                    "l1ToL2": self.settings.l1_composer_rpc_url,
                    "l2ToL1": self.settings.l2_composer_rpc_url,
                },
            },
            "chains": chains,
            "rollup": rollup,
            "blobSettlements": settlements,
            "settlementHistory": history,
            "settlementProgress": progress,
            "metrics": metrics,
        }

    def correlation(self, direction: str, selector: str) -> Any:
        normalized = validate_selector(selector)
        if direction == "l2-to-l1":
            return self.l2.rpc("eez_getSettlementByL2Block", [normalized])
        if direction == "l1-to-l2":
            return self.l2.rpc("eez_getSettledL2RangesByL1Block", [normalized])
        raise ValueError("direction must be l2-to-l1 or l1-to-l2")

    def settlement_search(self, query: str) -> dict[str, Any]:
        scope, normalized = validate_settlement_search(query)
        is_hash = bool(HASH_RE.fullmatch(normalized))
        lookup_errors: list[str] = []
        l1_blocks: list[dict[str, Any]] = []
        transaction_hashes: set[str] = set()

        tasks: dict[str, tuple[Callable[..., Any], tuple[Any, ...]]] = {}
        if scope in (None, "l1"):
            method = "eth_getBlockByHash" if is_hash else "eth_getBlockByNumber"
            tasks["L1 block"] = (self.l1.rpc, (method, [normalized, True]))
        if scope in (None, "l2"):
            tasks["L2 block"] = (
                self.l2.rpc,
                ("eez_getSettlementByL2Block", [normalized]),
            )
        if scope is None and is_hash:
            tasks["L1 transaction"] = (
                self.l1.rpc,
                ("eth_getTransactionByHash", [normalized]),
            )
            if self.blobscan:
                tasks["blob versioned hash"] = (
                    self.blobscan.get_json,
                    (f"blobs/{normalized}",),
                )

        resolved: dict[str, Any] = {}
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="settlement-search") as executor:
            futures = {
                executor.submit(operation, *arguments): label
                for label, (operation, arguments) in tasks.items()
            }
            for future in as_completed(futures):
                label = futures[future]
                try:
                    resolved[label] = future.result()
                except Exception as error:
                    # A full hash is intentionally tried as several object kinds.
                    # Blobscan uses HTTP 404 for a valid hash of another kind.
                    if "upstream HTTP 404" not in str(error):
                        lookup_errors.append(f"{label}: {error}")

        l1_block = resolved.get("L1 block")
        if isinstance(l1_block, dict):
            l1_blocks.append(l1_block)

        transaction = resolved.get("L1 transaction")
        if isinstance(transaction, dict) and transaction.get("hash"):
            transaction_hashes.add(str(transaction["hash"]).lower())

        blob = resolved.get("blob versioned hash")
        if isinstance(blob, dict):
            for occurrence in blob.get("transactions") or []:
                if isinstance(occurrence, dict) and occurrence.get("txHash"):
                    transaction_hashes.add(str(occurrence["txHash"]).lower())

        correlation = resolved.get("L2 block")
        correlation_records = correlation if isinstance(correlation, list) else [correlation]
        for record in correlation_records:
            if isinstance(record, dict) and record.get("l1TransactionHash"):
                transaction_hashes.add(str(record["l1TransactionHash"]).lower())

        matches: dict[str, dict[str, Any]] = {}
        for settlement in self._settlements(l1_blocks):
            transaction_hash = str(settlement.get("transactionHash") or "").lower()
            if transaction_hash:
                matches[transaction_hash] = settlement

        for transaction_hash in sorted(transaction_hashes):
            if transaction_hash in matches:
                continue
            try:
                settlement = self._settlement_by_transaction_hash(transaction_hash)
                if settlement is not None:
                    matches[transaction_hash] = settlement
            except Exception as error:
                lookup_errors.append(f"settlement {transaction_hash}: {error}")

        ordered = sorted(
            matches.values(),
            key=lambda item: (
                item.get("l1BlockNumber", 0),
                item.get("transactionIndex", 0),
            ),
            reverse=True,
        )
        return {
            "query": query.strip(),
            "scope": scope,
            "selector": normalized,
            "matches": ordered,
            "lookupErrors": lookup_errors,
        }

    def _settlement_by_transaction_hash(
        self, transaction_hash: str
    ) -> dict[str, Any] | None:
        transaction = self.l1.rpc("eth_getTransactionByHash", [transaction_hash])
        if not isinstance(transaction, dict):
            return None
        if (
            str(transaction.get("type", "")).lower() != "0x3"
            and not transaction.get("blobVersionedHashes")
        ):
            return None
        block_hash = transaction.get("blockHash")
        if not block_hash:
            return None
        block = self.l1.rpc("eth_getBlockByHash", [block_hash, False])
        if not isinstance(block, dict):
            return None
        return self._settlement(block, transaction)

    def decode_blob_transaction(self, transaction_hash: str) -> dict[str, Any]:
        normalized = transaction_hash.strip().lower()
        if not HASH_RE.fullmatch(normalized):
            raise ValueError("transaction must be a 32-byte hash")
        if not self.blobscan:
            raise ValueError("Blobscan API is not configured")

        transaction = self.l1.rpc("eth_getTransactionByHash", [normalized])
        if not isinstance(transaction, dict):
            raise ValueError("transaction does not exist on canonical L1")
        if str(transaction.get("type", "")).lower() != "0x3":
            raise ValueError("transaction is not an EIP-4844 type-3 transaction")
        block_number = transaction.get("blockNumber")
        if block_number is None or not transaction.get("blockHash"):
            raise ValueError("transaction has no canonical L1 inclusion")
        canonical = self.l1.rpc("eth_getBlockByNumber", [block_number, False])
        position = quantity(transaction.get("transactionIndex"))
        if (not isinstance(canonical, dict) or canonical.get("hash") != transaction["blockHash"]
                or position is None or not 0 <= position < len(canonical.get("transactions") or [])
                or canonical["transactions"][position].lower() != normalized):
            raise ValueError("transaction is not included in the canonical L1 block")
        if self.settings.registry_address and str(transaction.get("to") or "").lower() != self.settings.registry_address:
            raise ValueError("transaction does not target the configured EEZ registry")

        canonical_hashes = [
            str(value).lower() for value in transaction.get("blobVersionedHashes") or []
        ]
        if not canonical_hashes or len(canonical_hashes) > 15:
            raise ValueError("transaction has an invalid blob count")
        if any(not HASH_RE.fullmatch(value) for value in canonical_hashes):
            raise ValueError("transaction contains a malformed versioned hash")

        indexed = self.blobscan.get_json(f"transactions/{normalized}")
        if not isinstance(indexed, dict) or str(indexed.get("hash", "")).lower() != normalized:
            raise RemoteCallError("Blobscan returned mismatched transaction metadata")
        indexed_hashes = [
            str(value.get("versionedHash", "")).lower()
            for value in indexed.get("blobs") or []
            if isinstance(value, dict)
        ]
        if sorted(indexed_hashes) != sorted(canonical_hashes):
            raise RemoteCallError("Blobscan blob set does not match canonical L1")

        physical_blobs: list[bytes] = []
        for versioned_hash in canonical_hashes:
            encoded = self.blobscan.get_json(f"blobs/{versioned_hash}/data")
            if not isinstance(encoded, str) or not encoded.startswith("0x"):
                raise RemoteCallError(
                    f"Blobscan returned malformed data for {versioned_hash}"
                )
            try:
                physical_blobs.append(bytes.fromhex(encoded[2:]))
            except ValueError as error:
                raise RemoteCallError(
                    f"Blobscan returned non-hex data for {versioned_hash}"
                ) from error

        decoded = decode_native_blobs(
            physical_blobs, self.settings.rollup_id
        )
        checked = self.l1.rpc("eth_getBlockByNumber", [block_number, False])
        if not isinstance(checked, dict) or checked.get("hash") != canonical["hash"]:
            raise RemoteCallError("L1 inclusion changed while decoding the transaction")
        return {
            "transactionHash": normalized,
            "l1BlockNumber": quantity(transaction.get("blockNumber")),
            "l1BlockHash": transaction.get("blockHash"),
            "registryAddress": self.settings.registry_address,
            "blobVersionedHashes": canonical_hashes,
            "source": "canonical L1 transaction + Blobscan PostgreSQL data",
            "structuralDecodeOnly": True,
            **decoded,
        }

    def _chain(
        self, client: JsonClient, name: str, full_transactions: bool
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        tasks: dict[str, tuple[str, list[Any]]] = {
            "chainId": ("eth_chainId", []),
            "latest": ("eth_getBlockByNumber", ["latest", full_transactions]),
            "safe": ("eth_getBlockByNumber", ["safe", False]),
            "finalized": ("eth_getBlockByNumber", ["finalized", False]),
            "syncing": ("eth_syncing", []),
            "peerCount": ("net_peerCount", []),
            "gasPrice": ("eth_gasPrice", []),
        }
        results: dict[str, Any] = {}
        optional_errors: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=len(tasks), thread_name_prefix=name) as executor:
            futures = {
                executor.submit(client.rpc, method, params): key
                for key, (method, params) in tasks.items()
            }
            for future in as_completed(futures):
                key = futures[future]
                try:
                    results[key] = future.result()
                except Exception as error:
                    if key in {"latest", "chainId"}:
                        raise
                    optional_errors[key] = str(error)

        latest = results["latest"]
        if not isinstance(latest, dict):
            raise RemoteCallError(f"{name}: latest block is unavailable")
        latest_number = quantity(latest.get("number"))
        if latest_number is None:
            raise RemoteCallError(f"{name}: latest block has no number")

        first = max(0, latest_number - self.settings.recent_blocks + 1)
        raw_blocks: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=8, thread_name_prefix=f"{name}-blocks") as executor:
            futures = {
                executor.submit(
                    client.rpc, "eth_getBlockByNumber", [hex(number), full_transactions]
                ): number
                for number in range(first, latest_number + 1)
            }
            by_number: dict[int, dict[str, Any]] = {}
            for future in as_completed(futures):
                number = futures[future]
                block = future.result()
                if isinstance(block, dict):
                    by_number[number] = block
            raw_blocks = [by_number[number] for number in sorted(by_number, reverse=True)]

        def head(key: str) -> dict[str, Any] | None:
            block = results.get(key)
            return summarize_block(block) if isinstance(block, dict) else None

        syncing = results.get("syncing", False)
        return (
            {
                "name": name.upper(),
                "healthy": True,
                "chainId": quantity(results.get("chainId")),
                "chainIdHex": results.get("chainId"),
                "latest": summarize_block(latest),
                "safe": head("safe"),
                "finalized": head("finalized"),
                "syncing": syncing is not False,
                "syncStatus": syncing,
                "peerCount": quantity(results.get("peerCount")),
                "gasPriceWei": quantity(results.get("gasPrice")),
                "blocks": [summarize_block(block) for block in raw_blocks],
                "optionalErrors": optional_errors,
            },
            raw_blocks,
        )

    def _rollup(self, chains: dict[str, Any]) -> dict[str, Any]:
        address = self.settings.registry_address
        if not address:
            return {"configured": False, "status": "not-configured"}
        calldata = f"0x{ROLLUPS_SELECTOR}{self.settings.rollup_id:064x}"
        l1_head = chains.get("l1", {}).get("latest") or {}
        tag = l1_head.get("numberHex", "latest")
        raw = self.l1.rpc("eth_call", [{"to": address, "data": calldata}, tag])
        result = decode_rollup_call(raw)
        commitment = result["commitment"]
        safe = chains.get("l2", {}).get("safe") or {}
        safe_number = safe.get("number")
        committed_block = self.l2.rpc("eth_getBlockByHash", [commitment, False])
        canonical_block: dict[str, Any] | None = None
        if isinstance(committed_block, dict) and committed_block.get("number") is not None:
            canonical = self.l2.rpc(
                "eth_getBlockByNumber", [committed_block["number"], False]
            )
            canonical_block = canonical if isinstance(canonical, dict) else None

        if not isinstance(committed_block, dict):
            status = "missing"
        elif not canonical_block or str(canonical_block.get("hash", "")).lower() != commitment.lower():
            status = "non-canonical"
        elif safe_number is None:
            status = "unavailable"
        elif (quantity(committed_block.get("number")) or 0) <= safe_number:
            status = "safe"
        else:
            status = "pending-safe"
        return {
            "configured": True,
            "registryAddress": address,
            "rollupId": self.settings.rollup_id,
            "status": status,
            "safeBlock": safe,
            "committedBlock": (
                summarize_block(committed_block)
                if isinstance(committed_block, dict)
                else None
            ),
            **result,
        }

    def _settlement_progress(self, chains: dict[str, Any], rollup: dict[str, Any]) -> dict[str, Any]:
        """Describe general-threshold progress; never predict a runtime trigger."""
        policy = self.settings.settlement_policy
        if not policy or not policy.get("enabled"):
            return {"available": False}
        latest = (chains.get("l2", {}).get("latest") or {}).get("number")
        committed = (rollup.get("committedBlock") or {}).get("number")
        if (rollup.get("status") not in {"safe", "pending-safe"}
                or latest is None or committed is None or latest < committed):
            return {"available": False}
        unsettled = latest - committed
        remaining = max(0, policy["maxUnsettledL2Blocks"] - unsettled)
        block_ms = policy["l2BlockTimeMs"]
        return {
            "available": True, "anchorL2Block": committed,
            "anchorL2Hash": rollup["commitment"], "unsettledL2Blocks": unsettled,
            "remainingL2Blocks": remaining, "generalThresholdReached": remaining == 0,
            "estimatedGeneralRemainingMs": remaining * block_ms if block_ms is not None else None,
        }

    def _settlement_history(
        self, head: dict[str, Any] | None, recent: list[dict[str, Any]]
    ) -> dict[str, Any]:
        if not self.settings.registry_address:
            return {"configured": False, "available": False}
        if not head or head.get("number") is None or not head.get("hash"):
            raise RemoteCallError("canonical L1 head unavailable for settlement history")
        first = max(0, head["number"] - self.settings.settlement_lookback_blocks + 1)
        events = self.l1.rpc("eth_getLogs", [{
            "address": self.settings.registry_address,
            "fromBlock": hex(first), "toBlock": hex(head["number"]),
            "topics": [BATCH_POSTED_TOPIC],
        }])
        if not isinstance(events, list):
            raise RemoteCallError("settlement history returned malformed logs")
        unique: dict[str, dict[str, Any]] = {}
        for event in events:
            if event.get("removed"):
                continue
            number = quantity(event.get("blockNumber"))
            if (str(event.get("address", "")).lower() != self.settings.registry_address
                    or not event.get("topics") or event["topics"][0].lower() != BATCH_POSTED_TOPIC
                    or number is None or not first <= number <= head["number"]
                    or not HASH_RE.fullmatch(event.get("transactionHash", ""))):
                raise RemoteCallError("settlement history log does not match the requested window")
            key = event["transactionHash"].lower()
            if key in unique and unique[key]["blockHash"] != event["blockHash"]:
                raise RemoteCallError("conflicting canonical settlement events")
            unique[key] = event
        ordered = sorted(unique.values(), key=lambda event: (
            quantity(event["blockNumber"]), quantity(event.get("transactionIndex")) or 0,
        ), reverse=True)
        selected = ordered[:self.settings.recent_settlements]
        existing = {item.get("transactionHash", "").lower(): item for item in recent}

        def hydrate(event: dict[str, Any]) -> dict[str, Any]:
            tx_hash = event["transactionHash"].lower()
            cached = existing.get(tx_hash)
            if cached and cached.get("l1BlockHash") == event["blockHash"] and cached.get("receiptStatus") == 1:
                return cached
            block = self.l1.rpc("eth_getBlockByNumber", [event["blockNumber"], False])
            transaction = self.l1.rpc("eth_getTransactionByHash", [tx_hash])
            if (not isinstance(block, dict) or block.get("hash") != event.get("blockHash")
                    or not isinstance(transaction, dict)
                    or transaction.get("blockHash") != block["hash"]
                    or transaction.get("hash", "").lower() != tx_hash
                    or str(transaction.get("to", "")).lower() != self.settings.registry_address):
                raise RemoteCallError("settlement changed canonical inclusion during collection")
            index = quantity(transaction.get("transactionIndex"))
            transactions = block.get("transactions") or []
            if index is None or not 0 <= index < len(transactions) or transactions[index].lower() != tx_hash:
                raise RemoteCallError("settlement transaction position does not match canonical L1")
            return self._settlement(block, transaction)

        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="settlement-history") as executor:
            settlements = list(executor.map(hydrate, selected))
        canonical = self.l1.rpc("eth_getBlockByNumber", [hex(head["number"]), False])
        if not isinstance(canonical, dict) or canonical.get("hash") != head["hash"]:
            raise RemoteCallError("L1 snapshot reorganized while collecting settlement history")
        timestamps = [item["timestamp"] for item in settlements if item.get("receiptStatus") == 1]
        intervals = [newer - older for newer, older in zip(timestamps, timestamps[1:])]
        if any(interval < 0 for interval in intervals):
            raise RemoteCallError("non-monotonic settlement timestamps")
        return {
            "configured": True, "available": True, "fromL1Block": first,
            "toL1Block": head["number"], "lookbackBlocks": self.settings.settlement_lookback_blocks,
            "limit": self.settings.recent_settlements, "postsShown": len(settlements),
            "postsInLookback": len(ordered), "hasMore": len(ordered) > len(selected),
            "intervalsSeconds": intervals, "settlements": settlements,
        }

    def _settlements(self, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        work: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for block in blocks:
            for transaction in block.get("transactions") or []:
                if isinstance(transaction, dict) and (
                    str(transaction.get("type", "")).lower() == "0x3"
                    or transaction.get("blobVersionedHashes")
                ):
                    work.append((block, transaction))
        if not work:
            return []
        settlements: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=8, thread_name_prefix="blobs") as executor:
            futures = {
                executor.submit(self._settlement, block, transaction): (
                    quantity(block.get("number")) or 0,
                    quantity(transaction.get("transactionIndex")) or 0,
                )
                for block, transaction in work
            }
            for future in as_completed(futures):
                try:
                    settlements.append(future.result())
                except Exception as error:
                    block_number, transaction_index = futures[future]
                    settlements.append(
                        {
                            "l1BlockNumber": block_number,
                            "transactionIndex": transaction_index,
                            "status": "unavailable",
                            "error": str(error),
                        }
                    )
        return sorted(
            settlements,
            key=lambda item: (item.get("l1BlockNumber", 0), item.get("transactionIndex", 0)),
            reverse=True,
        )

    def _settlement(
        self, block: dict[str, Any], transaction: dict[str, Any]
    ) -> dict[str, Any]:
        transaction_hash = transaction.get("hash")
        block_hash = block.get("hash")
        if not transaction_hash or not block_hash:
            raise RemoteCallError("blob transaction is missing hash or block hash")

        receipt: dict[str, Any] | None = None
        ranges: list[Any] = []
        detail_errors: list[str] = []
        with ThreadPoolExecutor(max_workers=2) as executor:
            receipt_future = executor.submit(
                self.l1.rpc, "eth_getTransactionReceipt", [transaction_hash]
            )
            ranges_future = executor.submit(
                self.l2.rpc, "eez_getSettledL2RangesByL1Block", [block_hash]
            )
            try:
                value = receipt_future.result()
                receipt = value if isinstance(value, dict) else None
            except Exception as error:
                detail_errors.append(f"receipt: {error}")
            try:
                value = ranges_future.result()
                ranges = value if isinstance(value, list) else []
            except Exception as error:
                detail_errors.append(f"correlation: {error}")

        matching_ranges = [
            value
            for value in ranges
            if isinstance(value, dict)
            and str(value.get("l1TransactionHash", "")).lower()
            == str(transaction_hash).lower()
        ]
        if receipt and (receipt.get("blockHash") != block_hash
                        or str(receipt.get("transactionHash", "")).lower() != str(transaction_hash).lower()
                        or quantity(receipt.get("transactionIndex")) != quantity(transaction.get("transactionIndex"))):
            raise RemoteCallError("receipt does not match canonical settlement inclusion")
        beacon = self._beacon_for_block(block)
        if beacon.get("error"):
            detail_errors.append(f"beacon: {beacon['error']}")

        versioned_hashes = transaction.get("blobVersionedHashes") or []
        to = str(transaction.get("to") or "").lower()
        registry = self.settings.registry_address
        gas_used = quantity(receipt.get("gasUsed")) if receipt else None
        gas_price = quantity(receipt.get("effectiveGasPrice")) if receipt else None
        blob_gas = quantity(receipt.get("blobGasUsed")) if receipt else None
        blob_price = quantity(receipt.get("blobGasPrice")) if receipt else None
        execution_cost = gas_used * gas_price if gas_used is not None and gas_price is not None else None
        blob_cost = blob_gas * blob_price if blob_gas is not None and blob_price is not None else None
        return {
            "transactionHash": transaction_hash,
            "transactionIndex": quantity(transaction.get("transactionIndex")),
            "l1BlockNumber": quantity(block.get("number")),
            "l1BlockHash": block_hash,
            "timestamp": quantity(block.get("timestamp")),
            "timestampIso": utc_timestamp(block.get("timestamp")),
            "from": transaction.get("from"),
            "to": transaction.get("to"),
            "isProtocolSettlement": bool(registry and to == registry),
            "blobCount": len(versioned_hashes),
            "blobVersionedHashes": versioned_hashes,
            "maxFeePerBlobGas": quantity(transaction.get("maxFeePerBlobGas")),
            "receiptStatus": quantity(receipt.get("status")) if receipt else None,
            "blobGasUsed": quantity(receipt.get("blobGasUsed")) if receipt else None,
            "blobGasPrice": quantity(receipt.get("blobGasPrice")) if receipt else None,
            "gasUsed": gas_used,
            "effectiveGasPrice": str(gas_price) if gas_price is not None else None,
            "executionCostWei": str(execution_cost) if execution_cost is not None else None,
            "blobCostWei": str(blob_cost) if blob_cost is not None else None,
            "totalCostWei": str(execution_cost + blob_cost) if execution_cost is not None and blob_cost is not None else None,
            "l2Ranges": matching_ranges,
            "beacon": beacon,
            "status": ("confirmed" if quantity(receipt.get("status")) == 1 else "failed") if receipt else "unavailable",
            "errors": detail_errors,
        }

    def _beacon_for_block(self, block: dict[str, Any]) -> dict[str, Any]:
        if not self.beacon:
            return {"configured": False, "available": None}
        cache_key = block.get("hash")
        with self._beacon_cache_lock:
            if cache_key and cache_key in self._beacon_cache:
                return self._beacon_cache[cache_key]
        try:
            genesis_time, seconds_per_slot = self._get_beacon_meta()
            timestamp = quantity(block.get("timestamp"))
            if timestamp is None or timestamp < genesis_time:
                raise RemoteCallError("block timestamp predates beacon genesis")
            elapsed = timestamp - genesis_time
            if elapsed % seconds_per_slot:
                raise RemoteCallError("block timestamp is not aligned to a beacon slot")
            slot = elapsed // seconds_per_slot
            source = "full-blobs"
            try:
                payload = self.beacon.get_json(f"eth/v1/beacon/blobs/{slot}")
            except RemoteCallError as error:
                if error.http_status not in {404, 405, 501}:
                    raise
                source = "blob-sidecars"
                payload = self.beacon.get_json(f"eth/v1/beacon/blob_sidecars/{slot}")
            blobs = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(blobs, list) or not blobs:
                raise RemoteCallError("Beacon returned no full blob data for the settlement slot")
            for item in blobs:
                encoded = item.get("blob") if isinstance(item, dict) else item
                if not isinstance(encoded, str) or not encoded.startswith("0x") or len(encoded) != BLOB_BYTES * 2 + 2:
                    raise RemoteCallError("Beacon returned a malformed full blob")
                try:
                    bytes.fromhex(encoded[2:])
                except ValueError as error:
                    raise RemoteCallError("Beacon returned non-hex blob bytes") from error
            expected_gas = quantity(block.get("blobGasUsed"))
            if expected_gas is not None and len(blobs) * BLOB_BYTES != expected_gas:
                raise RemoteCallError("Beacon blob count does not match canonical L1 blob gas")
            result = {
                "configured": True,
                "available": True,
                "slot": slot,
                "source": source,
                "blobCount": len(blobs),
                "sidecarCount": len(blobs),  # Compatibility for existing API consumers.
                "indices": [quantity(item.get("index")) for item in blobs if isinstance(item, dict)],
                "kzgCommitments": [
                    item["kzg_commitment"] for item in blobs
                    if isinstance(item, dict) and item.get("kzg_commitment")
                ],
            }
            if cache_key:
                with self._beacon_cache_lock:
                    self._beacon_cache[cache_key] = result
                    while len(self._beacon_cache) > self.settings.recent_settlements + self.settings.recent_blocks:
                        self._beacon_cache.popitem(last=False)
            return result
        except Exception as error:
            return {"configured": True, "available": False, "error": str(error)}

    def _get_beacon_meta(self) -> tuple[int, int]:
        with self._beacon_meta_lock:
            if self._beacon_meta is not None:
                return self._beacon_meta
            assert self.beacon is not None
            genesis = self.beacon.get_json("eth/v1/beacon/genesis")
            spec = self.beacon.get_json("eth/v1/config/spec")
            genesis_time = int(genesis["data"]["genesis_time"])
            seconds_per_slot = int(spec["data"]["SECONDS_PER_SLOT"])
            if seconds_per_slot <= 0:
                raise RemoteCallError("SECONDS_PER_SLOT must be positive")
            self._beacon_meta = (genesis_time, seconds_per_slot)
            return self._beacon_meta

    @staticmethod
    def _capture(
        errors: list[dict[str, str]],
        component: str,
        operation: Callable[..., Any],
        *args: Any,
    ) -> Any:
        try:
            return operation(*args)
        except Exception as error:
            LOG.warning("%s collection failed: %s", component, error)
            errors.append({"component": component, "message": str(error)})
            return None

    @staticmethod
    def _metrics(chains: dict[str, Any], settlements: list[dict[str, Any]]) -> dict[str, Any]:
        def block_number(chain: str, tag: str) -> int | None:
            return (chains.get(chain, {}).get(tag) or {}).get("number")

        l2_latest = block_number("l2", "latest")
        l2_safe = block_number("l2", "safe")
        l2_finalized = block_number("l2", "finalized")
        beacon_blocks = {
            item.get("l1BlockHash", item.get("l1BlockNumber")): item.get("beacon", {})
            for item in settlements if item.get("beacon", {}).get("available")
        }
        return {
            "l2UnsafeLag": (
                l2_latest - l2_safe
                if l2_latest is not None and l2_safe is not None
                else None
            ),
            "l2FinalityLag": (
                l2_latest - l2_finalized
                if l2_latest is not None and l2_finalized is not None
                else None
            ),
            "blobTransactionsInWindow": len(settlements),
            "protocolSettlementsInWindow": sum(
                1 for settlement in settlements if settlement.get("isProtocolSettlement")
            ),
            "blobsInWindow": sum(
                settlement.get("blobCount", 0) or 0 for settlement in settlements
            ),
            "availableBlobSidecarsInWindow": sum(
                beacon.get("blobCount", beacon.get("sidecarCount", 0)) or 0
                for beacon in beacon_blocks.values()
            ),
        }


class SnapshotCache:
    def __init__(self, collector: Collector, ttl_seconds: int):
        self.collector = collector
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._value: dict[str, Any] | None = None
        self._updated_at = 0.0

    def get(self, *, force: bool = False) -> dict[str, Any]:
        with self._lock:
            age = time.monotonic() - self._updated_at
            if force or self._value is None or age >= self.ttl_seconds:
                previous = self._value
                try:
                    self._value = self.collector.collect()
                    self._updated_at = time.monotonic()
                except Exception:
                    if previous is None:
                        raise
                    LOG.exception("snapshot refresh failed; serving stale data")
                    self._value = {**previous, "stale": True}
            return self._value


class DashboardHandler(BaseHTTPRequestHandler):
    cache: SnapshotCache
    collector: Collector
    feed: SnapshotFeed
    # WebSocket upgrades hand the socket to the protocol library after headers.
    rbufsize = 0
    blob_decode_slots = threading.BoundedSemaphore(2)
    settlement_search_slots = threading.BoundedSemaphore(4)
    server_version = "EEZDashboard/1"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        if parsed.path == "/api/live":
            serve_websocket(self, self.feed)
            return
        if parsed.path == "/api/health":
            self._json(
                HTTPStatus.OK,
                {"status": "ok", "service": "eez-network-dashboard"},
                cache="no-store",
            )
            return
        if parsed.path == "/api/snapshot":
            try:
                self._json(HTTPStatus.OK, self.cache.get(), cache="no-store")
            except Exception as error:
                LOG.exception("snapshot request failed")
                self._json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "snapshot unavailable", "detail": str(error)},
                    cache="no-store",
                )
            return
        if parsed.path == "/api/settlement-search":
            query = parse_qs(parsed.query).get("q", [""])[0]
            if not self.settlement_search_slots.acquire(blocking=False):
                self._json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "settlement search is busy; retry shortly"},
                    cache="no-store",
                )
                return
            try:
                try:
                    self._json(
                        HTTPStatus.OK,
                        self.collector.settlement_search(query),
                        cache="no-store",
                    )
                except ValueError as error:
                    self._json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": str(error)},
                        cache="no-store",
                    )
                except Exception as error:
                    self._json(
                        HTTPStatus.BAD_GATEWAY,
                        {"error": str(error)},
                        cache="no-store",
                    )
            finally:
                self.settlement_search_slots.release()
            return
        if parsed.path == "/api/correlation":
            query = parse_qs(parsed.query)
            direction = query.get("direction", [""])[0]
            selector = query.get("block", [""])[0]
            try:
                result = self.collector.correlation(direction, selector)
                self._json(
                    HTTPStatus.OK,
                    {"direction": direction, "selector": validate_selector(selector), "result": result},
                    cache="no-store",
                )
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)}, cache="no-store")
            except Exception as error:
                self._json(HTTPStatus.BAD_GATEWAY, {"error": str(error)}, cache="no-store")
            return
        if parsed.path == "/api/blob-decode":
            transaction_hash = parse_qs(parsed.query).get("tx", [""])[0]
            if not self.blob_decode_slots.acquire(blocking=False):
                self._json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "blob decoder is busy; retry shortly"},
                    cache="no-store",
                )
                return
            try:
                try:
                    self._json(
                        HTTPStatus.OK,
                        self.collector.decode_blob_transaction(transaction_hash),
                        cache="no-store",
                    )
                except (ValueError, BlobDecodeError) as error:
                    self._json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": str(error)},
                        cache="no-store",
                    )
                except Exception as error:
                    LOG.exception("blob decode request failed")
                    self._json(
                        HTTPStatus.BAD_GATEWAY,
                        {"error": str(error)},
                        cache="no-store",
                    )
            finally:
                self.blob_decode_slots.release()
            return
        self._static(parsed.path)

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(
                HTTPStatus.OK,
                {"status": "ok", "service": "eez-network-dashboard"},
                cache="no-store",
                write_body=False,
            )
            return
        self._static(parsed.path, write_body=False)

    def _static(self, path: str, write_body: bool = True) -> None:
        files = {
            "/": "index.html",
            "/index.html": "index.html",
            "/styles.css": "styles.css",
            "/app.js": "app.js",
            "/brand/eez.css": "brand/eez.css",
            "/brand/eez-logo.svg": "brand/eez-logo.svg",
            "/brand/eez-icon.svg": "brand/eez-icon.svg",
            "/brand/geist-latin.woff2": "brand/geist-latin.woff2",
            "/brand/geist-mono-latin.woff2": "brand/geist-mono-latin.woff2",
        }
        filename = files.get(path)
        if filename is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = (STATIC_DIR / filename).read_bytes()
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self._security_headers()
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        if write_body:
            self.wfile.write(data)

    def _json(
        self, status: HTTPStatus, value: Any, cache: str, write_body: bool = True
    ) -> None:
        data = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if write_body:
            self.wfile.write(data)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        host = self.headers.get("Host", "")
        sockets = f" ws://{host} wss://{host}" if re.fullmatch(r"[A-Za-z0-9.\-:\[\]]+", host) else ""
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            f"img-src 'self' data:; connect-src 'self'{sockets}; object-src 'none'; "
            "base-uri 'self'; frame-ancestors 'none'",
        )

    def log_message(self, message: str, *args: Any) -> None:
        LOG.info("%s - %s", self.address_string(), message % args)


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = Settings.from_env()
    collector = Collector(settings)
    DashboardHandler.collector = collector
    DashboardHandler.cache = SnapshotCache(collector, settings.refresh_seconds)
    DashboardHandler.feed = SnapshotFeed(DashboardHandler.cache, settings)
    server = ThreadingHTTPServer((settings.bind_host, settings.bind_port), DashboardHandler)
    LOG.info(
        "listening on %s:%s",
        settings.bind_host,
        settings.bind_port,
    )
    try:
        DashboardHandler.feed.start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        DashboardHandler.feed.stop()
        server.server_close()


if __name__ == "__main__":
    main()
