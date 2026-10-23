"""Run by the pinned Config Service's Django shell, against its owned database."""
import json
from chains.models import Chain, Feature, GasPrice, Service, Wallet

s = json.load(open('/rehearsal/settings.json'))
p = s['ports']
rpc = s['deployment']['l1']['rpc']
uri = lambda name: f"http://127.0.0.1:{p[name]}"
chain, _ = Chain.objects.update_or_create(id=1337, defaults={
    'name': 'Treasury L1 Devnet', 'short_name': 'trl1', 'description': 'Isolated treasury rehearsal',
    'l2': False, 'is_testnet': True, 'hidden': False,
    'rpc_authentication': 'NO_AUTHENTICATION', 'rpc_uri': rpc,
    'public_rpc_authentication': 'NO_AUTHENTICATION', 'public_rpc_uri': rpc,
    'safe_apps_rpc_authentication': 'NO_AUTHENTICATION', 'safe_apps_rpc_uri': rpc,
    'vpc_rpc_uri': rpc, 'transaction_service_uri': uri('txs'), 'vpc_transaction_service_uri': uri('txs'),
    'currency_name': 'Devnet Ether', 'currency_symbol': 'ETH', 'currency_decimals': 18,
    'currency_logo_uri': 'logo-icon.png', 'recommended_master_copy_version': '1.4.1',
    'balances_provider_enabled': False, 'relayer_type': None,
    'block_explorer_uri_address_template': '',
    'block_explorer_uri_tx_hash_template': '',
    'block_explorer_uri_api_template': '',
})
GasPrice.objects.update_or_create(chain=chain, rank=1, defaults={'fixed_wei_value': 2000000000})
services = [Service.objects.get_or_create(key=k, defaults={'name': k})[0] for k in ['CGW','WALLET_WEB']]
for key in ['CONTRACT_INTERACTION', 'SPENDING_LIMIT', 'MY_ACCOUNTS']:
    feature, _ = Feature.objects.get_or_create(key=key)
    feature.chains.add(chain); feature.services.add(*services)
for key in ['metamask', 'rabby', 'detectedwallets']:
    wallet, _ = Wallet.objects.get_or_create(key=key); wallet.chains.add(chain)
print('Configured isolated L1 chain 1337')
