import json
import os
import sys
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from live import HeadWatcher, SnapshotFeed
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import connect
from websockets.sync.server import serve

ENV = {"EEZ_L1_RPC_URL": "http://l1.invalid", "EEZ_L2_RPC_URL": "http://l2.invalid"}


def snapshot(height=12, block_hash="aa"):
    return {"generatedAt": "2026-09-14T12:00:00Z", "healthy": True,
            "chains": {"l2": {"latest": {"number": height, "hash": "0x" + block_hash * 32}}}}


def head(height=13, block_hash="bb", parent="aa"):
    return {"number": hex(height), "hash": "0x" + block_hash * 32,
            "parentHash": "0x" + parent * 32, "timestamp": hex(int(time.time())),
            "gasUsed": "0x5208", "gasLimit": "0x1c9c380"}


def feed_fixture():
    settings = SimpleNamespace(refresh_seconds=0.2, live_update_seconds=0.02,
        request_timeout_seconds=0.2, l1_ws_url=None, l2_ws_url=None)
    collector = mock.Mock()
    collector.collect.return_value = snapshot()
    return SnapshotFeed(server.SnapshotCache(collector, 4), settings), collector


@contextmanager
def http_fixture():
    feed, collector = feed_fixture()
    handler = type("TestDashboard", (server.DashboardHandler,),
                   {"feed": feed, "cache": feed.cache, "collector": collector})
    http = server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{http.server_port}"
    try:
        yield feed, collector, origin
    finally:
        feed.stop()
        http.shutdown()
        http.server_close()
        thread.join(timeout=1)


class LiveTests(unittest.TestCase):
    def test_recent_blocks_hydrate_without_waiting_for_collection(self):
        feed, collector = feed_fixture()
        feed.settings.recent_blocks = 3
        entered, release = threading.Event(), threading.Event()
        def slow_collection():
            entered.set()
            release.wait(3)
            return snapshot()
        collector.collect.side_effect = slow_collection
        blocks = {
            "0x" + byte * 32: {"number": number, "hash": "0x" + byte * 32,
                "parentHash": "0x" + parent * 32, "transactionCount": number + 1}
            for number, byte, parent in [(0, "aa", "00"), (1, "bb", "aa"),
                                         (2, "cc", "bb"), (3, "dd", "cc")]
        }
        collector.live_block.side_effect = lambda name, block_hash: blocks[block_hash]
        worker = threading.Thread(target=feed.hydrate_blocks, args=("l2",), daemon=True)
        feed.worker.start()
        worker.start()
        cursor = feed.attach()
        try:
            self.assertTrue(entered.wait(1))
            feed.publish_head("l2", head(2, "cc", "bb"))
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not feed.blocks.get("l2"):
                cursor, _ = feed.wait(cursor, timeout=0.1)
            self.assertEqual([row["number"] for row in feed.blocks["l2"]], [2, 1, 0])
            self.assertIsNone(feed.frame, "block hydration must bypass blocked settlement collection")
            _, frame = feed.wait(-1, timeout=0)
            self.assertEqual(json.loads(frame)["blocks"]["l2"][0]["transactionCount"], 3)
            calls = collector.live_block.call_count
            feed.publish_head("l2", head(3, "dd", "cc"))
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and feed.blocks["l2"][0]["number"] != 3:
                cursor, _ = feed.wait(cursor, timeout=0.1)
            self.assertEqual([row["number"] for row in feed.blocks["l2"]], [3, 2, 1])
            self.assertEqual(collector.live_block.call_count - calls, 1,
                             "contiguous blocks should reuse hydrated ancestors")
        finally:
            release.set()
            feed.stop()
            worker.join(timeout=1)

    def test_collector_is_api_only(self):
        with http_fixture() as (_, _, origin):
            for method in ("GET", "HEAD"):
                with self.subTest(method=method):
                    with urlopen(Request(origin + "/api/health", method=method), timeout=2) as response:
                        self.assertEqual(response.status, 200)
                    for path in ("/", "/index.html", "/app.js", "/styles.css"):
                        with self.assertRaises(HTTPError) as failure:
                            urlopen(Request(origin + path, method=method), timeout=2)
                        self.assertEqual(failure.exception.code, 404)
                        failure.exception.close()

    def test_config_defaults_and_non_default_values(self):
        with mock.patch.dict(os.environ, ENV, clear=True):
            settings = server.Settings.from_env()
            self.assertIsNone(settings.l1_ws_url)
            self.assertIsNone(settings.l2_ws_url)
            self.assertEqual(settings.live_update_seconds, 1)
        with mock.patch.dict(os.environ, {**ENV, "EEZ_L1_WS_URL": "wss://l1.example/ws?key=token",
                "EEZ_L2_WS_URL": "ws://127.0.0.1:18689", "EEZ_LIVE_UPDATE_SECONDS": "2"}, clear=True):
            settings = server.Settings.from_env()
            self.assertEqual(settings.l1_ws_url, "wss://l1.example/ws?key=token")
            self.assertEqual(settings.l2_ws_url, "ws://127.0.0.1:18689")
            self.assertEqual(settings.live_update_seconds, 2)

    def test_invalid_live_configuration_fails_early(self):
        for setting in [{"EEZ_L1_WS_URL": value} for value in
                        ["http://example.com", "wss://", "ws://user:secret@example.com", "ws://example.com/#fragment", "ws://localhost:99999"]] + [
                        {"EEZ_LIVE_UPDATE_SECONDS": value} for value in ["0", "-1", "5", "wat"]]:
            with self.subTest(setting=setting), mock.patch.dict(os.environ, {**ENV, **setting}, clear=True):
                with self.assertRaises(ValueError):
                    server.Settings.from_env()

    def test_hash_changes_invalidate_even_at_same_or_lower_height(self):
        feed = mock.Mock()
        watcher = HeadWatcher("l2", mock.Mock(), None, feed, 1, 1)
        watcher.observe({"number": "0xc", "hash": "0x" + "aa" * 32})
        watcher.observe({"number": "0xc", "hash": "0x" + "aa" * 32})
        watcher.observe({"number": "0xc", "hash": "0x" + "bb" * 32})
        watcher.observe({"number": "0xb", "hash": "0x" + "cc" * 32})
        self.assertEqual(feed.wake.set.call_count, 3)
        with self.assertRaises(ValueError):
            watcher.observe({"hash": "invalid"})

    def test_cache_forced_refresh_and_failure_preserve_stale_marker(self):
        collector = mock.Mock()
        collector.collect.return_value = snapshot()
        cache = server.SnapshotCache(collector, 60)
        self.assertEqual(cache.get(), snapshot())
        cache.get()
        self.assertEqual(collector.collect.call_count, 1)
        collector.collect.return_value = snapshot(13)
        self.assertEqual(cache.get(force=True)["chains"]["l2"]["latest"]["number"], 13)
        collector.collect.side_effect = RuntimeError("offline")
        self.assertTrue(cache.get(force=True)["stale"])

    def test_latest_snapshot_replaces_queue_and_idle_reconnect_waits_for_fresh_data(self):
        feed, collector = feed_fixture()
        cursor = feed.attach()
        for height in range(12, 22):
            feed.publish(snapshot(height))
        version, frame = feed.wait(cursor)
        self.assertEqual(version, 10)
        self.assertEqual(json.loads(frame)["snapshot"]["chains"]["l2"]["latest"]["number"], 21)
        self.assertFalse(collector.collect.called)
        feed.detach()
        with mock.patch("live.time.monotonic", return_value=feed.updated_at + 10):
            self.assertEqual(feed.attach(), version)
        feed.detach()

    def test_collection_coalesces_notifications_and_periodically_reconciles(self):
        feed, collector = feed_fixture()
        collected = threading.Event()
        collector.collect.side_effect = lambda: (collected.set(), snapshot())[1]
        feed.attach()
        feed.worker.start()
        try:
            self.assertTrue(collected.wait(1))
            first, _ = feed.wait(0)
            for _ in range(50):
                feed.wake.set()
            second, _ = feed.wait(first, timeout=1)
            self.assertGreater(second, first)
            # No new heads: safe/finalized changes still get another collection.
            third, _ = feed.wait(second, timeout=1)
            self.assertGreater(third, second)
            self.assertLess(collector.collect.call_count, 10)
        finally:
            feed.detach()
            feed.stop()

    def test_heads_do_not_wait_for_slow_collection(self):
        feed, collector = feed_fixture()
        entered, release = threading.Event(), threading.Event()
        def slow_collect():
            entered.set()
            release.wait(3)
            return snapshot(12)
        collector.collect.side_effect = slow_collect
        cursor = feed.attach()
        feed.worker.start()
        try:
            self.assertTrue(entered.wait(1))
            watcher = HeadWatcher("l2", mock.Mock(), None, feed, 1, 1)
            watcher.observe(head(13))
            version, raw = feed.wait(cursor, timeout=.5)
            event = json.loads(raw)
            self.assertEqual(event["type"], "heads")
            self.assertEqual(event["heads"]["l2"]["block"]["number"], 13)
            self.assertIsNone(event["heads"]["l2"]["block"]["transactionCount"])
            self.assertFalse(release.is_set(), "head must arrive before collection finishes")
            release.set()
            _, raw = feed.wait(version, timeout=1)
            details = json.loads(raw)
            self.assertEqual(details["type"], "snapshot")
            self.assertLess(details["collectionStartedSequence"], event["heads"]["l2"]["sequence"])
            self.assertEqual(details["heads"]["l2"]["block"]["number"], 13)
        finally:
            release.set()
            feed.detach()
            feed.stop()

    def test_slow_viewers_keep_latest_details_and_both_heads(self):
        feed, _ = feed_fixture()
        feed.publish(snapshot())
        for number in range(13, 100):
            feed.publish_head("l1", head(number, "aa"))
            feed.publish_head("l2", head(number + 10, "bb"))
        _, raw = feed.wait(-1)
        message = json.loads(raw)
        self.assertEqual(message["type"], "snapshot")
        self.assertEqual(message["heads"]["l1"]["block"]["number"], 99)
        self.assertEqual(message["heads"]["l2"]["block"]["number"], 109)
        self.assertEqual(len(feed.heads), 2)
        with http_fixture() as (live, _, origin):
            with connect(origin.replace("http:", "ws:") + "/api/live", origin=origin, close_timeout=1) as viewer:
                live.publish_head("l2", head())
                event = json.loads(viewer.recv(timeout=1))
                self.assertEqual(event["type"], "heads")
                self.assertEqual(event["heads"]["l2"]["block"]["number"], 13)

    def test_normal_l2_heads_do_not_trigger_full_collection(self):
        feed, collector = feed_fixture()
        watcher = HeadWatcher("l2", collector.l2, None, feed, 1, 1)
        watcher.observe(head(12, "aa", "00"))
        feed.wake.clear()
        watcher.observe(head(13, "bb", "aa"))
        self.assertFalse(feed.wake.is_set())
        self.assertEqual(feed.heads["l2"]["block"]["number"], 13)
        watcher.observe(head(13, "cc", "aa"))
        self.assertTrue(feed.wake.is_set(), "same-height replacement must reconcile history")

    def test_websocket_upgrade_two_clients_reorg_reconnect_and_readonly_contract(self):
        with http_fixture() as (feed, collector, origin):
            uri = origin.replace("http:", "ws:") + "/api/live"
            with connect(uri, origin=origin, close_timeout=1) as first, connect(uri, origin=origin, close_timeout=1) as second:
                self.assertTrue(first.protocol.extensions, "snapshot compression should be negotiated")
                feed.publish({**snapshot(), "largeField": "8080" * 40000})
                a, b = json.loads(first.recv(timeout=1)), json.loads(second.recv(timeout=1))
                self.assertEqual(a, b)
                self.assertEqual(a["snapshot"]["largeField"], "8080" * 40000)
                self.assertEqual(feed.clients, 2)
                feed.publish(snapshot(11, "bb"))
                self.assertEqual(json.loads(first.recv(timeout=1))["snapshot"]["chains"]["l2"]["latest"]["number"], 11)
                self.assertEqual(json.loads(second.recv(timeout=1))["snapshot"]["chains"]["l2"]["latest"]["hash"], "0x" + "bb" * 32)
                self.assertTrue(first.ping().wait(1))
                first.send('{"method":"eth_sendRawTransaction","params":[]}')
                with self.assertRaises(ConnectionClosed) as error:
                    first.recv(timeout=2)
                self.assertEqual(error.exception.rcvd.code, 1008)
            # Reconnect gets current full state even without another publication.
            feed.publish(snapshot(14, "cc"))
            with connect(uri, origin=origin, close_timeout=1) as third:
                self.assertEqual(json.loads(third.recv(timeout=1))["snapshot"]["chains"]["l2"]["latest"]["number"], 14)
            self.assertFalse(collector.collect.called)

    def test_websocket_origin_capacity_and_http_compatibility(self):
        with http_fixture() as (feed, collector, origin):
            uri = origin.replace("http:", "ws:") + "/api/live"
            for bad_origin in [None, "https://unrelated.example"]:
                with self.subTest(origin=bad_origin), self.assertRaises(InvalidStatus) as error:
                    connect(uri, origin=bad_origin)
                self.assertEqual(error.exception.response.status_code, 403)
            self.assertEqual(feed.clients, 0)
            with mock.patch.object(feed, "MAX_CLIENTS", 0), self.assertRaises(InvalidStatus) as error:
                connect(uri, origin=origin)
            self.assertEqual(error.exception.response.status_code, 503)
            self.assertEqual(feed.clients, 0)
            with urlopen(origin + "/api/snapshot", timeout=1) as response:
                self.assertEqual(json.load(response), snapshot())
            with urlopen(origin + "/api/health", timeout=1) as response:
                self.assertEqual(json.load(response)["status"], "ok")

    def test_subscription_validates_chain_routes_heads_and_reconciles_reconnect(self):
        for chain, chain_id in [("l1", "0x27d8"), ("l2", "0x1892")]:
            feed, collector = feed_fixture()
            events, connections = threading.Event(), []

            def upstream(ws):
                connections.append(ws)
                request = json.loads(ws.recv(timeout=1))
                self.assertEqual(request["method"], "eth_chainId")
                ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "result": chain_id}))
                request = json.loads(ws.recv(timeout=1))
                self.assertEqual(request["params"], ["newHeads"])
                ws.send('{"jsonrpc":"2.0","id":2,"result":"subscription"}')
                ws.send(json.dumps({"method": "eth_subscription", "params": {"subscription": "subscription", "result": {"hash": "0x" + "aa" * 32}}}))
                if len(connections) == 1:
                    ws.close(1001, "test reconnect")
                    return
                events.wait(2)

            with serve(upstream, "127.0.0.1", 0, close_timeout=1) as endpoint:
                t = threading.Thread(target=endpoint.serve_forever, daemon=True)
                t.start()
                client = mock.Mock()
                client.rpc.side_effect = lambda method, params: chain_id if method == "eth_chainId" else {"hash": "0x" + "bb" * 32}
                watcher = HeadWatcher(chain, client, f"ws://127.0.0.1:{endpoint.socket.getsockname()[1]}", feed, .01, 1)
                feed.attach()
                watcher.thread.start()
                try:
                    deadline = time.monotonic() + 3
                    while (len(connections) < 2 or feed.sources[chain] != "websocket" or watcher.last_hash != "0x" + "aa" * 32) and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertGreaterEqual(len(connections), 2)
                    self.assertEqual(watcher.last_hash, "0x" + "aa" * 32)
                    self.assertEqual(feed.sources[chain], "websocket")
                    self.assertTrue(feed.wake.is_set())
                    self.assertTrue(any(call.args[0] == "eth_getBlockByNumber" for call in client.rpc.call_args_list))
                finally:
                    feed.stopped.set()
                    events.set()
                    watcher.thread.join(timeout=2)
                    endpoint.shutdown()
                    t.join(timeout=1)

    def test_wrong_websocket_chain_is_rejected_before_subscribing(self):
        feed, collector = feed_fixture()
        client = mock.Mock()
        client.rpc.return_value = "0x27d8"
        ws = mock.MagicMock()
        ws.recv.return_value = '{"id":1,"result":"0x1"}'
        with mock.patch("websockets.sync.client.connect") as connector:
            connector.return_value.__enter__.return_value = ws
            with self.assertRaises(ValueError):
                HeadWatcher("l1", client, "wss://example.invalid", feed, 1, 1).subscribe()
        self.assertEqual(ws.send.call_count, 1)
        self.assertEqual(feed.sources["l1"], "connecting")


if __name__ == "__main__":
    unittest.main()
