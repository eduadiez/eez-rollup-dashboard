"""Shared, bounded snapshot delivery and optional node head subscriptions."""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

LOG = logging.getLogger("eez-dashboard.live")


class HeadWatcher:
    """Treat notifications as invalidations; canonical data still comes from RPC."""

    def __init__(self, name, client, ws_url, feed, interval, timeout):
        self.name, self.client, self.ws_url, self.feed = name, client, ws_url, feed
        self.interval, self.timeout = interval, timeout
        self.last_hash = None
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
            self.last_hash = block_hash
            # Hash comparison also catches replacements at the same height and
            # rollbacks. Never append a notification directly to the UI history.
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
    """One collection loop for every viewer; slow viewers retain no event queue."""

    MAX_CLIENTS = 16

    def __init__(self, cache, settings):
        self.cache, self.settings = cache, settings
        self.active, self.wake, self.stopped = threading.Event(), threading.Event(), threading.Event()
        self.condition = threading.Condition()
        self.clients, self.version = 0, 0
        self.frame: str | None = None
        self.updated_at = 0.0
        self.sources = {"l1": "connecting", "l2": "connecting"}
        self.watchers = [
            HeadWatcher(name, getattr(cache.collector, name), getattr(settings, f"{name}_ws_url"),
                        self, settings.live_update_seconds, settings.request_timeout_seconds)
            for name in ("l1", "l2")
        ]
        self.worker = threading.Thread(target=self.run, daemon=True, name="live-snapshots")

    def start(self) -> None:
        self.worker.start()
        for watcher in self.watchers:
            watcher.thread.start()

    def stop(self) -> None:
        self.stopped.set()
        self.active.set()
        self.wake.set()
        with self.condition:
            self.condition.notify_all()
        for thread in [self.worker, *(w.thread for w in self.watchers)]:
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
            return self.version - 1 if recent else self.version

    def detach(self) -> None:
        with self.condition:
            self.clients -= 1
            if self.clients == 0:
                self.active.clear()

    def wait(self, version: int, timeout: float = 1) -> tuple[int, str | None]:
        with self.condition:
            self.condition.wait_for(lambda: self.version != version or self.stopped.is_set(), timeout=timeout)
            return self.version, self.frame if self.version != version else None

    def publish(self, snapshot: dict[str, Any], event: str = "snapshot") -> None:
        with self.condition:
            self.version += 1
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
            try:
                self.publish(self.cache.get(force=True))
            except Exception:
                LOG.exception("live snapshot collection failed")
                self.publish({"error": "Snapshot temporarily unavailable"}, "unavailable")
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
                connection.close(1008, "This feed only publishes snapshots")
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
