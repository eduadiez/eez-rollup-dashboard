"""Immediate node-head delivery with independent reconciliation of network details."""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

LOG = logging.getLogger("eez-dashboard.live")


class HeadWatcher:
    """Publish heads immediately; reconcile canonical history independently."""

    def __init__(self, name, client, ws_url, feed, interval, timeout):
        self.name, self.client, self.ws_url, self.feed = name, client, ws_url, feed
        self.interval, self.timeout = interval, timeout
        self.last_hash = None
        self.last_number = None
        self.thread = threading.Thread(target=self.run, daemon=True, name=f"{name}-heads")

    def observe(self, head: Any) -> None:
        if not isinstance(head, dict):
            raise ValueError("head must be an object")
        block_hash = head.get("hash")
        if not isinstance(block_hash, str) or len(block_hash) != 66:
            raise ValueError("head must have a block hash")
        int(block_hash[2:], 16)
        if not block_hash.startswith("0x"):
            raise ValueError("head must have a hex block hash")
        if block_hash != self.last_hash:
            try:
                number = int(head.get("number", ""), 16)
            except (ValueError, TypeError):
                number = None
            reconcile = (self.name == "l1" or self.last_hash is None or number is None
                         or self.last_number is None or number <= self.last_number
                         or head.get("parentHash") != self.last_hash)
            self.last_hash, self.last_number = block_hash, number
            # This path never acquires the collector/cache lock or waits for
            # receipts, Beacon sidecars, finality, or settlement history.
            self.feed.publish_head(self.name, head)
            if reconcile:
                self.feed.wake.set()

    def poll(self) -> None:
        try:
            self.observe(self.client.rpc("eth_getBlockByNumber", ["latest", False]))
            self.feed.source(self.name, "polling")
        except Exception:
            self.feed.source(self.name, "unavailable")

    def subscribe(self) -> None:
        from websockets.sync.client import connect

        with connect(self.ws_url, open_timeout=self.timeout, close_timeout=1,
                     ping_interval=15, ping_timeout=15, max_size=65536,
                     max_queue=4, compression=None) as connection:
            # A mistaken WS URL must not supply another chain's notifications.
            expected = self.client.rpc("eth_chainId", [])
            connection.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}))
            response = json.loads(connection.recv(timeout=self.timeout))
            if response.get("id") != 1 or int(response.get("result", ""), 16) != int(expected, 16):
                raise ValueError("WebSocket chain does not match the read RPC")
            connection.send(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "eth_subscribe", "params": ["newHeads"]}))
            response = json.loads(connection.recv(timeout=self.timeout))
            subscription = response.get("result")
            if response.get("id") != 2 or not isinstance(subscription, str) or not subscription:
                raise ValueError("newHeads subscription rejected")
            self.feed.source(self.name, "websocket")
            self.feed.wake.set()  # Reconcile everything missed while disconnected.
            while not self.feed.stopped.is_set() and self.feed.active.is_set():
                try:
                    message = json.loads(connection.recv(timeout=1))
                except TimeoutError:
                    continue
                params = message.get("params") or {}
                if message.get("method") == "eth_subscription" and params.get("subscription") == subscription:
                    self.observe(params.get("result"))

    def run(self) -> None:
        retry_at, backoff = 0.0, 1.0
        while not self.feed.stopped.is_set():
            if not self.feed.active.wait(timeout=1):
                continue
            if self.feed.stopped.is_set():
                break
            if self.ws_url and time.monotonic() >= retry_at:
                try:
                    self.subscribe()
                    backoff = 1.0
                except Exception as error:
                    # Do not log an upstream URL or credentials from exceptions.
                    LOG.warning("%s head subscription unavailable (%s); using HTTP heads",
                                self.name, type(error).__name__)
                    retry_at = time.monotonic() + backoff
                    backoff = min(30.0, backoff * 2)
            if self.feed.active.is_set() and not self.feed.stopped.is_set():
                self.poll()
            self.feed.stopped.wait(self.interval)


class SnapshotFeed:
    """One details worker plus a latest-head slot per chain; no event backlog."""

    MAX_CLIENTS = 16

    def __init__(self, cache, settings):
        self.cache, self.settings = cache, settings
        self.active, self.wake, self.stopped = threading.Event(), threading.Event(), threading.Event()
        self.condition = threading.Condition()
        self.clients, self.version = 0, 0
        self.frame: str | None = None
        self.updated_at = 0.0
        self.state_version = 0
        self.collection_started_sequence = 0
        self.heads: dict[str, dict[str, Any]] = {}
        self.blocks: dict[str, list[dict[str, Any]]] = {}
        self.block_workers = [threading.Thread(target=self.hydrate_blocks, args=(name,),
            daemon=True, name=f"{name}-block-details") for name in ("l1", "l2")]
        self.sources = {"l1": "connecting", "l2": "connecting"}
        self.watchers = [
            HeadWatcher(name, getattr(cache.collector, name), getattr(settings, f"{name}_ws_url"),
                        self, settings.live_update_seconds, settings.request_timeout_seconds)
            for name in ("l1", "l2")
        ]
        self.worker = threading.Thread(target=self.run, daemon=True, name="live-snapshots")

    def start(self) -> None:
        self.worker.start()
        for worker in self.block_workers:
            worker.start()
        for watcher in self.watchers:
            watcher.thread.start()

    def stop(self) -> None:
        self.stopped.set()
        self.active.set()
        self.wake.set()
        with self.condition:
            self.condition.notify_all()
        for thread in [self.worker, *self.block_workers, *(w.thread for w in self.watchers)]:
            if thread.is_alive():
                thread.join(timeout=1)

    def source(self, name: str, status: str) -> None:
        with self.condition:
            if self.sources[name] != status:
                self.sources[name] = status
                self.wake.set()

    def attach(self) -> int | None:
        with self.condition:
            if self.clients >= self.MAX_CLIENTS or self.stopped.is_set():
                return None
            self.clients += 1
            self.active.set()
            self.wake.set()
            # Reconnect sends the latest full snapshot, not a replay of old
            # notifications. An idle feed must first refresh its stale snapshot.
            recent = self.frame is not None and time.monotonic() - self.updated_at <= self.settings.refresh_seconds
            return -1 if recent else self.version

    def detach(self) -> None:
        with self.condition:
            self.clients -= 1
            if self.clients == 0:
                self.active.clear()

    def wait(self, version: int, timeout: float = 1) -> tuple[int, str | None]:
        with self.condition:
            self.condition.wait_for(lambda: self.version != version or self.stopped.is_set(), timeout=timeout)
            if self.version == version:
                return self.version, None
            if self.frame is not None and self.state_version > version:
                value = json.loads(self.frame)
                value["collectionStartedSequence"] = self.collection_started_sequence
            else:
                value = {"type": "heads"}
            # Include both latest heads so a slow reader never loses one chain
            # when the other chain updates. The size is bounded to two headers.
            value.update(sequence=self.version, heads=dict(self.heads), blocks=dict(self.blocks))
            return self.version, json.dumps(value, separators=(",", ":"))

    def hydrate_blocks(self, name: str) -> None:
        """Fill a bounded block window without waiting for settlement collection.

        Hash-addressed parent traversal cannot mix branches. Only the latest
        target is retained, so fast producers never build an unbounded queue.
        """
        completed = None
        cached: dict[str, dict[str, Any]] = {}
        setting = "recent_blocks" if name == "l1" else "l2_recent_blocks"
        limit = max(1, min(128, getattr(self.settings, setting, getattr(self.settings, "recent_blocks", 12))))
        while not self.stopped.is_set():
            with self.condition:
                self.condition.wait_for(lambda: self.stopped.is_set() or (
                    self.active.is_set() and self.heads.get(name, {}).get("block", {}).get("hash") != completed
                    and name in self.heads), timeout=1)
                if self.stopped.is_set():
                    return
                target = self.heads.get(name, {}).get("block")
                if not self.active.is_set() or not target or target["hash"] == completed:
                    continue
            rows = []
            wanted = target["hash"]
            try:
                for _ in range(limit):
                    if self.stopped.is_set() or not self.active.is_set():
                        break
                    block = cached.get(wanted) or self.cache.collector.live_block(name, wanted)
                    if (not isinstance(block, dict) or block.get("hash") != wanted
                            or block.get("number") != target["number"] - len(rows)):
                        raise ValueError("block does not match requested ancestry")
                    rows.append(block)
                    if block["number"] == 0:
                        break
                    wanted = block["parentHash"]
                if not rows:
                    continue
                cached = {row["hash"]: row for row in rows}
                with self.condition:
                    self.blocks[name] = rows
                    self.version += 1
                    self.condition.notify_all()
                completed = target["hash"]
            except Exception:
                # Retry a transient missing block without dropping the last
                # hydrated window or blocking immediate header delivery.
                self.stopped.wait(1)

    def publish_head(self, name: str, head: dict[str, Any]) -> None:
        def quantity(key):
            raw = head.get(key)
            if not isinstance(raw, str) or not raw.startswith("0x"):
                raise ValueError("invalid head quantity")
            value = int(raw, 16)
            if value < 0 or value > 2**53 - 1:
                raise ValueError("head quantity exceeds browser precision")
            return value
        try:
            block = {"number": quantity("number"), "numberHex": head["number"],
                     "hash": head["hash"], "parentHash": head.get("parentHash"),
                     "timestamp": quantity("timestamp"),
                     "gasUsed": quantity("gasUsed"), "gasLimit": quantity("gasLimit"),
                     # newHeads has no transaction bodies or blob counts.
                     "transactionCount": None, "blobTransactionCount": None}
        except (ValueError, TypeError, KeyError):
            return  # A partial/malformed header only requests reconciliation.
        with self.condition:
            if name not in self.sources or self.stopped.is_set():
                return
            self.version += 1
            self.heads[name] = {"block": block, "sequence": self.version,
                                "receivedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
            self.condition.notify_all()

    def publish(self, snapshot: dict[str, Any], event: str = "snapshot", *, started_sequence: int | None = None) -> None:
        with self.condition:
            self.collection_started_sequence = self.version if started_sequence is None else started_sequence
            self.version += 1
            self.state_version = self.version
            value = {**snapshot, "liveUpdates": {"sources": dict(self.sources)}}
            self.frame = json.dumps({"type": event, "sequence": self.version, "snapshot": value},
                                    separators=(",", ":"))
            self.updated_at = time.monotonic()
            self.condition.notify_all()

    def run(self) -> None:
        next_refresh, last_started = 0.0, 0.0
        while not self.stopped.is_set():
            if not self.active.wait(timeout=1):
                continue
            self.wake.wait(timeout=max(0, next_refresh - time.monotonic()))
            self.wake.clear()
            delay = max(0, last_started + self.settings.live_update_seconds - time.monotonic())
            if self.stopped.wait(delay):
                break
            if not self.active.is_set():
                continue
            last_started = time.monotonic()
            with self.condition:
                started_sequence = self.version
            try:
                self.publish(self.cache.get(force=True), started_sequence=started_sequence)
            except Exception:
                LOG.exception("live snapshot collection failed")
                self.publish({"error": "Network details temporarily unavailable"}, "unavailable", started_sequence=started_sequence)
            # Periodic reconciliation also catches safe/finalized updates and
            # delayed receipts/indexing that don't emit another newHeads event.
            next_refresh = time.monotonic() + self.settings.refresh_seconds


def serve_websocket(handler, feed: SnapshotFeed) -> None:
    """Upgrade the existing HTTP socket; websockets owns framing and keepalive.

    The HTTP handler uses unbuffered reads, so no frame bytes can remain in an
    HTTP read-ahead buffer when the connection changes protocol.
    """
    from websockets.datastructures import Headers
    from websockets.exceptions import ConnectionClosed
    from websockets.extensions.permessage_deflate import ServerPerMessageDeflateFactory
    from websockets.http11 import Request
    from websockets.protocol import OPEN
    from websockets.server import ServerProtocol
    from websockets.sync.connection import Connection

    if handler.request_version != "HTTP/1.1" or handler.headers.get("Transfer-Encoding") or handler.headers.get("Content-Length", "0") != "0":
        handler.send_error(400, "WebSocket upgrade requires HTTP/1.1 without a request body")
        return
    host = handler.headers.get("Host", "")
    protocol = ServerProtocol(origins=[f"http://{host}", f"https://{host}"], max_size=1024,
        extensions=[ServerPerMessageDeflateFactory(server_max_window_bits=12,
                    client_max_window_bits=12, compress_settings={"memLevel": 5})])
    request = Request(handler.path, Headers(handler.headers.raw_items()))
    protocol.receive_data(request.serialize())
    events = protocol.events_received()
    if not events:
        handler.send_error(400, "Invalid WebSocket handshake")
        return
    response = protocol.accept(events[0])
    cursor = None
    if response.status_code == 101:
        cursor = feed.attach()
        if cursor is None:
            response = protocol.reject(503, "Live viewer capacity reached; use snapshot polling")
    connection = None
    handler.close_connection = True
    try:
        protocol.send_response(response)
        for data in protocol.data_to_send():
            if data:
                handler.connection.sendall(data)
        if response.status_code != 101:
            return
        connection = Connection(handler.connection, protocol, ping_interval=15,
                                ping_timeout=15, close_timeout=1, max_queue=1)
        connection.start_keepalive()
        while not feed.stopped.is_set() and connection.state is OPEN:
            try:
                connection.recv(timeout=0)
            except TimeoutError:
                pass
            else:
                connection.close(1008, "This feed only publishes network updates")
                break
            cursor, frame = feed.wait(cursor)
            if frame is not None:
                connection.send(frame)
    except (ConnectionClosed, OSError):
        pass
    finally:
        if connection is not None:
            connection.close()
        if cursor is not None:
            feed.detach()
