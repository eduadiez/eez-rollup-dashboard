"""Build the pinned official gateway when its published ARM64 image cannot run locally."""
import hashlib
import io
import json
from pathlib import Path
import platform
import subprocess
import tarfile
import urllib.request

REVISION = '3bc60f70a12f097fc7774bb31597b2ac1f7fcb4c'
ARCHIVE_SHA256 = '47d1741bbe347c497d4875850534f3560104d56e4eeb5b28a7d5d2463b8c2ecd'
DOCKERFILE_SHA256 = '3a7170e9aa287db045fb7447f05c90028b00c8741647616300169f2df5bfde4b'


def native_gateway(directory: Path, published: str):
    architecture = subprocess.check_output(['docker','image','inspect',published,'--format','{{.Architecture}}'],text=True).strip()
    host = {'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine())
    if architecture == host:return None
    if host != 'amd64':raise RuntimeError(f'Unsupported rehearsal host architecture: {platform.machine()}')
    archive=directory/'gateway-source.tar.gz'
    if not archive.exists():
        archive.write_bytes(urllib.request.urlopen(f'https://codeload.github.com/safe-global/safe-client-gateway/tar.gz/{REVISION}',timeout=60).read())
    data=archive.read_bytes()
    if hashlib.sha256(data).hexdigest()!=ARCHIVE_SHA256:raise RuntimeError('Gateway source archive digest mismatch')
    source=directory/'gateway-source';source.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar.getmembers():
            parts=Path(member.name).parts[1:]
            if parts:
                member.name=str(Path(*parts));tar.extract(member,source,filter='data')
    if hashlib.sha256((source/'Dockerfile').read_bytes()).hexdigest()!=DOCKERFILE_SHA256:raise RuntimeError('Gateway Dockerfile mismatch')
    tag=f'treasury-safe-gateway:{REVISION[:8]}-amd64'
    print('Building pinned official gateway for AMD64 (locked Yarn dependencies)',flush=True)
    with (directory/'gateway-build.log').open('a') as log:
        subprocess.run(['docker','build','--build-arg','VERSION=v1.127.0','--build-arg',f'BUILD_NUMBER={REVISION}',
            '--label',f'org.opencontainers.image.revision={REVISION}','-t',tag,str(source)],stdout=log,stderr=subprocess.STDOUT,check=True)
    image=json.loads(subprocess.check_output(['docker','image','inspect',tag]))[0]
    assert image['Architecture']=='amd64'
    record={'upstreamCommit':REVISION,'archiveSha256':ARCHIVE_SHA256,'dockerfileSha256':DOCKERFILE_SHA256,
        'imageId':image['Id'],'reason':'Official v1.127.0 image is ARM64 only; this host is AMD64'}
    (directory/'gateway-build.json').write_text(json.dumps(record,indent=2)+'\n')
    return image['Id']
