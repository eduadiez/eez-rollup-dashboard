#!/usr/bin/env python3
"""Own an official Safe stack for one treasury devnet, using Linux loopback networking.

The generated Compose project and databases belong to this session. No .env is
read and stop preserves data. Host networking lets the official indexer reach
the existing loopback Anvil without exposing that RPC or modifying the devnet.
Every service listener is assigned an unused port and bound to loopback.
"""
import argparse
import json
from pathlib import Path
import secrets
import socket
import subprocess
import time
from gateway import native_gateway
from artifacts import prepare_artifacts

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def reserve_ports(names):
    leases = []
    try:
        for name in names:
            sock = socket.socket(); sock.bind(('127.0.0.1', 0)); leases.append((name, sock))
        return {name: sock.getsockname()[1] for name, sock in leases}
    finally:
        for _, sock in leases: sock.close()


def generate(settings, directory):
    p = settings['ports']; deploy = settings['deployment']; images = json.loads((HERE/'images.json').read_text())
    uri = lambda name: f'http://127.0.0.1:{p[name]}'
    secret = settings['secret']
    db = lambda name: f'psql://postgres:{secret}@127.0.0.1:{p["postgres"]}/{name}'
    common = {'network_mode': 'host', 'restart': 'no', 'cpus': 2, 'mem_limit': '1g',
              'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}}
    mount = [f'{directory}/bootstrap.json:/rehearsal/settings.json:ro', f'{HERE}:/scripts:ro']
    def service(image, env=None, cmd=None, **extra):
        return common | {'image': images[image], 'environment': env or {}} | ({'command': cmd} if cmd else {}) | extra
    cfg = {'SECRET_KEY': secret, 'POSTGRES_HOST': '127.0.0.1', 'POSTGRES_PORT': str(p['postgres']),
           'POSTGRES_NAME': 'cfg', 'POSTGRES_USER': 'postgres', 'POSTGRES_PASSWORD': secret,
           'DJANGO_ALLOWED_HOSTS': '*', 'DEFAULT_FILE_STORAGE': 'django.core.files.storage.FileSystemStorage',
           'CGW_URL': uri('cgw'), 'CGW_AUTH_TOKEN': secret, 'ROOT_LOG_LEVEL': 'INFO',
           'MEDIA_URL': deploy['dashboard'].split('#')[0]}
    txs = {'PYTHONPATH': '/app', 'DJANGO_SETTINGS_MODULE': 'config.settings.production', 'DJANGO_SECRET_KEY': secret,
           'DJANGO_ALLOWED_HOSTS': '*', 'DATABASE_URL': db('txs'), 'REDIS_URL': f'redis://127.0.0.1:{p["redis"]}/0',
           'CELERY_BROKER_URL': f'amqp://guest:guest@127.0.0.1:{p["rabbit"]}/', 'ETHEREUM_NODE_URL': deploy['l1']['rpc'],
           'ETHEREUM_TRACING_NODE_URL': deploy['l1']['rpc'], 'ETH_L2_NETWORK': '0', 'ETH_INTERNAL_NO_FILTER': '1',
           'ETH_INTERNAL_TXS_BLOCK_PROCESS_LIMIT': '100', 'ETH_INTERNAL_TXS_BLOCK_PROCESS_LIMIT_MAX': '100',
           'ETH_REORG_BLOCKS': '0', 'ETH_EVENTS_BLOCK_PROCESS_LIMIT': '100', 'CELERYD_CONCURRENCY': '4',
           'WORKER_QUEUES': 'default,indexing,processing,contracts,tokens,notifications,webhooks',
           'EVENTS_QUEUE_URL': f'amqp://guest:guest@127.0.0.1:{p["rabbit"]}/',
           'EVENTS_QUEUE_EXCHANGE_NAME': 'safe-transaction-service-events', 'ENABLE_SAFE_SETUP_CONTRACTS': '0'}
    cgw = {k: '' for k in ['EMAIL_API_APPLICATION_CODE','EMAIL_API_KEY','FINGERPRINT_ENCRYPTION_KEY','INFURA_API_KEY',
           'PUSH_NOTIFICATIONS_API_PROJECT','PUSH_NOTIFICATIONS_API_SERVICE_ACCOUNT_PRIVATE_KEY','RELAY_PROVIDER_API_KEY',
           'STAKING_API_KEY','STAKING_TESTNET_API_KEY','BRIDGE_API_KEY','EARN_TESTNET_API_KEY','EARN_MAINNET_API_KEY']}
    cgw.update({'AUTH_TOKEN': secret, 'AUTH_POST_LOGIN_REDIRECT_URI': uri('ui'), 'JWT_ISSUER': 'treasury-devnet',
        'JWT_SECRET': secret, 'EMAIL_API_FROM_EMAIL': 'demo@example.com', 'PUSH_NOTIFICATIONS_API_SERVICE_ACCOUNT_CLIENT_EMAIL': 'demo@example.com',
        'SAFE_CONFIG_BASE_URI': uri('cfg'), 'SAFE_CONFIG_CGW_KEY': 'CGW', 'ALLOW_CORS': 'true',
        'APPLICATION_HOST': '127.0.0.1', 'APPLICATION_PORT': str(p['cgw']), 'CGW_ENV': 'development',
        'POSTGRES_HOST': '127.0.0.1', 'POSTGRES_PORT': str(p['postgres']), 'POSTGRES_DB': 'cgw',
        'POSTGRES_USER': 'postgres', 'POSTGRES_PASSWORD': secret, 'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': str(p['redis']),
        'AMQP_URL': f'amqp://guest:guest@127.0.0.1:{p["rabbit"]}/', 'LOG_LEVEL': 'warn',
        'EXPIRATION_TIME_DEFAULT_SECONDS': '2', 'DD_TRACE_ENABLED': 'false', 'DD_INSTRUMENTATION_TELEMETRY_ENABLED': 'false',
        'SAFE_WEB_APP_BASE_URI': uri('ui'), 'SAFE_DATA_DECODER_BASE_URI': uri('decoder'),
        'CSV_AWS_ACCESS_KEY_ID': 'unused-devnet', 'CSV_AWS_SECRET_ACCESS_KEY': 'unused-devnet',
        'AWS_ACCESS_KEY_ID': 'unused-devnet', 'AWS_SECRET_ACCESS_KEY': 'unused-devnet'})
    ui = {'NEXT_PUBLIC_GATEWAY_URL_PRODUCTION': uri('cgw'), 'NEXT_PUBLIC_GATEWAY_URL_STAGING': uri('cgw'),
          'NEXT_PUBLIC_IS_PRODUCTION': 'true', 'NEXT_PUBLIC_DEFAULT_MAINNET_CHAIN_ID': '1337',
          'NEXT_PUBLIC_CONFIG_SERVICE_KEY': 'WALLET_WEB', 'NEXT_PUBLIC_SAFE_VERSION': '1.4.1',
          'NEXT_TELEMETRY_DISABLED': '1', 'NODE_OPTIONS': '--max-old-space-size=6144'}
    services = {
      'postgres': service('postgres', {'POSTGRES_PASSWORD': secret},
          ['postgres','-p',str(p['postgres']),'-c','listen_addresses=127.0.0.1'],
          volumes=[f'{directory}/postgres:/var/lib/postgresql/data',f'{directory}/databases.sql:/docker-entrypoint-initdb.d/databases.sql:ro']),
      'redis': service('redis', cmd=['redis-server','--bind','127.0.0.1','--port',str(p['redis']),'--save',''],
          volumes=[f'{directory}/redis:/data']),
      'rabbit': service('rabbitmq', {'RABBITMQ_NODENAME': f"rabbit@{settings['project']}", 'RABBITMQ_USE_LONGNAME':'false',
          'ERL_EPMD_PORT':str(p['epmd']), 'ERL_EPMD_ADDRESS':'127.0.0.1', 'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS':'+S 2:2'},
          hostname=settings['project'], extra_hosts={settings['project']: '127.0.0.1'}, volumes=[f'{directory}/rabbit.conf:/etc/rabbitmq/rabbitmq.conf:ro',f'{directory}/rabbit:/var/lib/rabbitmq']),
      'cfg': service('safe-config-service', cfg,
          ['gunicorn','--workers','2','--bind',f'127.0.0.1:{p["cfg"]}','--chdir','/app/src','config.wsgi'], entrypoint=[], volumes=mount),
      'txs': service('safe-transaction-service', txs,
          ['gunicorn','--workers','2','--bind',f'127.0.0.1:{p["txs"]}','config.wsgi:application'], volumes=mount),
      'worker': service('safe-transaction-service', txs, ['bash','docker/web/celery/worker/run.sh'], volumes=mount),
      'scheduler': service('safe-transaction-service', txs, ['bash','docker/web/celery/scheduler/run.sh']),
      # Preserve the POST body: the new gateway omits the slash required by the
      # transaction service's legacy decoder. Django's 301 would turn it into GET.
      'decoder': service('nginx', cmd=['nginx','-g','daemon off;'], entrypoint=[],
          volumes=[f'{directory}/decoder.conf:/etc/nginx/nginx.conf:ro']),
      'cgw': service('safe-client-gateway', cgw),
      'ui': service('safe-wallet-web', ui, ['sh','-c',f'yarn build && npx --yes serve@14.2.4 out --listen tcp://127.0.0.1:{p["ui"]}'], cpus=4, mem_limit='8g'),
    }
    if settings.get('gatewayImage'):
        services['cgw']['image'] = settings['gatewayImage']
        services['cgw']['pull_policy'] = 'never'
    return {'services': services}


def decoder_config(ports):
    return f"""events {{}}
http {{
  access_log off;
  server {{
    listen 127.0.0.1:{ports['decoder']};
    location = /api/v1/data-decoder {{
      proxy_pass http://127.0.0.1:{ports['txs']}/api/v1/data-decoder/;
    }}
    location / {{ proxy_pass http://127.0.0.1:{ports['txs']}; }}
  }}
}}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare','start','check','status','stop'])
    parser.add_argument('session', type=Path)
    args = parser.parse_args(); session = args.session.resolve()
    session.relative_to(ROOT/'.runtime/treasury-integration')
    directory = session.parent/'safe-app'; settings_file = directory/'settings.json'
    if args.action in ['prepare','start']:
        # Identity verification is read-only and precedes container/database changes.
        deployment = json.loads(subprocess.check_output(['node', str(HERE/'inspect.mjs'), str(session)], cwd=ROOT))
        if settings_file.exists():
            settings = json.loads(settings_file.read_text())
            assert settings['deployment']['instance'] == deployment['instance'], 'devnet instance changed'
        else:
            directory.mkdir(mode=0o700)
            settings = {'project': 'treasury-safe-'+secrets.token_hex(5), 'session': str(session), 'secret': secrets.token_hex(24),
                'ports': reserve_ports(['postgres','redis','rabbit','distribution','epmd','metrics','decoder','cfg','txs','cgw','ui']), 'deployment':deployment}
            settings_file.write_text(json.dumps(settings,indent=2)+'\n'); settings_file.chmod(0o600)
        (directory/'bootstrap.json').write_text(json.dumps({'ports': settings['ports'], 'deployment': settings['deployment']},indent=2)+'\n')
        (directory/'compose.json').write_text(json.dumps(generate(settings,directory),indent=2)+'\n')
        (directory/'compose.json').chmod(0o600)
        (directory/'databases.sql').write_text('CREATE DATABASE cfg;\nCREATE DATABASE txs;\nCREATE DATABASE cgw;\n')
        p=settings['ports']
        (directory/'rabbit.conf').write_text(f'listeners.tcp.default = 127.0.0.1:{p["rabbit"]}\ndistribution.listener.interface = 127.0.0.1\ndistribution.listener.port_range.min = {p["distribution"]}\ndistribution.listener.port_range.max = {p["distribution"]}\nloopback_users.guest = false\nprometheus.tcp.ip = 127.0.0.1\nprometheus.tcp.port = {p["metrics"]}\n')
        (directory/'decoder.conf').write_text(decoder_config(p))
    else: settings=json.loads(settings_file.read_text())
    compose=['docker','compose','--env-file','/dev/null','-p',settings['project'],'-f',str(directory/'compose.json')]
    def run(label, argv):
        print(label,flush=True)
        with (directory/(label+'.log')).open('a') as log:
            result=subprocess.run(argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:raise RuntimeError(f'{label} failed; see {directory/(label+".log")}')
    if args.action=='prepare':print(directory);return
    if args.action=='stop':run('stop',compose+['down']);return
    if args.action=='status':subprocess.run(compose+['ps'],check=True);return
    def check_and_link():
        result = subprocess.run(['node',str(HERE/'check.mjs'),str(session)],cwd=ROOT,capture_output=True,text=True)
        if result.returncode:
            with (directory/'readiness-errors.log').open('a') as log: log.write(result.stderr)
            raise RuntimeError(f'Safe stack not ready; see {directory / "readiness-errors.log"}')
        record = json.loads(result.stdout)
        for path in [session,session.parent/'ui-config.json']:
            content = json.loads(path.read_text())
            config = content['treasury'] if path == session else content['browser']['treasury']
            if config['instance'] != record['instance']: raise RuntimeError('Dashboard instance changed before linking')
            config['safeAppUrl'] = record['safeAppUrl']
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(content,indent=2)+'\n')
            temporary.replace(path)
        print(result.stdout,flush=True)
    if args.action=='check':
        check_and_link()
        return
    prepare_artifacts(directory)
    run('auxiliary-contracts',['node',str(HERE/'provision.mjs'),str(session)])
    services = generate(settings,directory)['services']
    run('pull',compose+['pull',*[name for name in services if name!='cgw' or not settings.get('gatewayImage')]])
    published = json.loads((HERE/'images.json').read_text())['safe-client-gateway']
    settings['gatewayImage'] = native_gateway(directory,published)
    settings_file.write_text(json.dumps(settings,indent=2)+'\n')
    (directory/'compose.json').write_text(json.dumps(generate(settings,directory),indent=2)+'\n')
    run('infrastructure',compose+['up','-d','postgres','redis','rabbit'])
    # Postgres bootstrap creates all three databases. Do not race migrations.
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        result=subprocess.run(compose+['exec','-T','postgres','pg_isready','-h','127.0.0.1','-p',str(settings['ports']['postgres']),'-U','postgres'],capture_output=True)
        if result.returncode==0:break
        time.sleep(1)
    else:raise RuntimeError('Owned Postgres did not become ready')
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        result=subprocess.run(compose+['exec','-T','rabbit','rabbitmq-diagnostics','-q','check_running'],capture_output=True)
        if result.returncode==0:break
        time.sleep(2)
    else:raise RuntimeError('Owned RabbitMQ did not become ready')
    for name, path in [('cfg','src/manage.py'),('txs','manage.py')]:
        run(name+'-migrate',compose+['run','--rm','--no-deps','--entrypoint','python',name,path,'migrate','--noinput'])
        if name=='txs':run('txs-setup',compose+['run','--rm','--no-deps','--entrypoint','python',name,path,'setup_service'])
        run(name+'-bootstrap',compose+['run','--rm','--no-deps','--entrypoint','python',name,path,'shell','-c',f'exec(open("/scripts/bootstrap_{name}.py").read())'])
    run('services',compose+['up','-d','cfg','txs','worker','scheduler','decoder','cgw','ui'])
    print('Waiting for Safe indexing and the official web build…',flush=True)
    deadline = time.monotonic()+600
    while True:
        try:
            check_and_link()
            break
        except RuntimeError:
            if time.monotonic() >= deadline: raise
            time.sleep(5)
    print(f'Owned configuration and logs: {directory}',flush=True)

if __name__=='__main__':main()
