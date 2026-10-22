"""Isolation regressions for the local Safe rehearsal launcher (no Docker required)."""
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts/treasury-safe'))
from rehearsal import generate, reserve_ports, decoder_config
from artifacts import prepare_artifacts


class RehearsalTests(unittest.TestCase):
    def settings(self):
        names = ['postgres','redis','rabbit','distribution','epmd','metrics','decoder','cfg','txs','cgw','ui']
        return {'project': 'treasury-safe-test', 'secret': 'public-test-secret',
                'ports': {name: 20000+i for i,name in enumerate(names)},
                'deployment': {'l1': {'rpc': 'http://127.0.0.1:18000/rpc/l1'},
                               'dashboard': 'http://127.0.0.1:18000/dashboard/#/treasury-demo'}}

    def test_ports_are_distinct_and_avoid_an_existing_listener(self):
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            ports = reserve_ports(['a', 'b', 'c'])
            self.assertEqual(len(set(ports.values())), 3)
            self.assertNotIn(occupied.getsockname()[1], ports.values())

    def test_own_paths_pinned_images_and_no_operator_environment(self):
        services = generate(self.settings(), Path('/tmp/owned-rehearsal'))['services']
        self.assertEqual(len(services), 10)
        for value in services.values():
            self.assertIn('@sha256:', value['image'])
            self.assertEqual(value['network_mode'], 'host')
            self.assertNotIn('env_file', value)
            self.assertNotIn('container_name', value)
            self.assertNotIn('ports', value)
            self.assertNotIn('privileged', value)
            for mount in value.get('volumes', []):
                self.assertTrue(mount.startswith(('/tmp/owned-rehearsal/', str(ROOT/'scripts/treasury-safe')+':')))
        self.assertIn('127.0.0.1', ' '.join(services['postgres']['command']))
        self.assertIn('127.0.0.1', services['redis']['command'])
        for service in ['cfg', 'txs', 'ui']:
            self.assertIn('127.0.0.1', ' '.join(services[service]['command']))
        self.assertEqual(services['cgw']['environment']['APPLICATION_HOST'], '127.0.0.1')
        self.assertEqual(services['rabbit']['extra_hosts'], {'treasury-safe-test': '127.0.0.1'})
        self.assertEqual(services['rabbit']['environment']['ERL_EPMD_ADDRESS'], '127.0.0.1')
        txs = services['worker']['environment']
        self.assertEqual(txs['ETH_L2_NETWORK'], '0')
        self.assertEqual(txs['ETHEREUM_TRACING_NODE_URL'], self.settings()['deployment']['l1']['rpc'])
        self.assertNotIn('DISABLE_SERVICE_EVENTS', txs)

    def test_decoder_keeps_post_body_without_a_redirect(self):
        settings = self.settings()
        config = decoder_config(settings['ports'])
        self.assertIn(f"listen 127.0.0.1:{settings['ports']['decoder']}", config)
        self.assertIn('location = /api/v1/data-decoder {', config)
        self.assertIn(f"proxy_pass http://127.0.0.1:{settings['ports']['txs']}/api/v1/data-decoder/;", config)
        self.assertNotIn('return 301', config)

    def test_local_gateway_build_uses_immutable_image_identity(self):
        settings = self.settings(); settings['gatewayImage'] = 'sha256:'+'a'*64
        cgw = generate(settings, Path('/tmp/owned-rehearsal'))['services']['cgw']
        self.assertEqual(cgw['image'], settings['gatewayImage'])
        self.assertEqual(cgw['pull_policy'], 'never')

    def test_corrupt_artifacts_fail_before_extraction_or_any_network_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory); (path/'contracts.tgz').write_bytes(b'wrong release')
            with patch('artifacts.urllib.request.urlopen', side_effect=AssertionError('unexpected network')):
                with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
                    prepare_artifacts(path)
            self.assertFalse((path/'contracts').exists())


if __name__ == '__main__':
    unittest.main()
