"""Register real on-chain deployments; indexing derives owners and transaction state."""
import json
from safe_transaction_service.history.models import SafeMasterCopy, ProxyFactory
s = json.load(open('/rehearsal/settings.json'))['deployment']
SafeMasterCopy.objects.get_or_create(address=s['singleton'], defaults={
    'initial_block_number': 0, 'tx_block_number': 0, 'version': '1.4.1', 'deployer': 'Safe', 'l2': False})
ProxyFactory.objects.get_or_create(address=s['factory'], defaults={'initial_block_number': 0, 'tx_block_number': 0})
print('Registered actual Safe singleton and factory; state will be indexed from L1')
