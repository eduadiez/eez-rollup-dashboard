import { useEffect, useState } from 'react';
import { deliverSourceRequest, sourceRequests } from '../lib/treasury/sourceVerification';
import type { SourceJob } from '../lib/treasury/sourceVerification';
import { L1_CHAIN, L2_CHAIN, config } from '../config';
import styles from './TreasuryDemo.module.css';

export function TreasurySourceVerification() {
  const [jobs, setJobs] = useState<{ chainId: number; job: SourceJob }[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, running = false, dirty = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (running) { dirty = true; return; }
      running = true; clearTimeout(timer);
      try {
        const results = [];
        // Delivery is idempotent; the persistent worker continues when this
        // component unmounts. Reopening also retries undelivered journal intents.
        for (const request of sourceRequests(localStorage).filter(r => [Number(BigInt(L1_CHAIN.chainId)), Number(BigInt(L2_CHAIN.chainId))].includes(r.chainId))) {
          if (!alive) return;
          results.push({ chainId: request.chainId, job: await deliverSourceRequest(request, `${import.meta.env.BASE_URL}treasury-verification/jobs`) });
        }
        if (alive) { setJobs(results); setError(''); }
      } catch (e) { if (alive) setError((e as Error).message); }
      finally { running = false; if (alive) timer = setTimeout(poll, dirty ? 0 : 15_000); dirty = false; }
    };
    const changed = () => { void poll(); };
    window.addEventListener('treasury-source-request', changed);
    void poll(); return () => { alive = false; clearTimeout(timer); window.removeEventListener('treasury-source-request', changed); };
  }, []);
  if (!jobs.length && !error) return null;
  const entries = jobs.flatMap(({ chainId, job }) => job.contracts.map(c => ({ chainId, ...c })));
  const unique = [...new Map(entries.map(c => [`${c.chainId}:${c.address}`, c])).values()];
  const verified = unique.filter(c => ['verified','sourcify-verified'].includes(c.status)).length;
  const pending = jobs.some(j => !['verified','reverted'].includes(j.job.status));
  return <details className={styles.hint} aria-label="Contract source verification">
    <summary>{error ? 'Contract source verification will retry automatically' : pending ? `Publishing contract sources · ${verified} of ${unique.length} verified` : 'Contract sources verified'}</summary>
    {error && <p role="status">{error}</p>}
    <ul>{unique.map(c => <li key={`${c.chainId}:${c.address}`}>
      <a href={`${(c.chainId === 1 ? 'https://eth.blockscout.com' : c.chainId === Number(BigInt(L1_CHAIN.chainId)) ? config.l1Explorer : config.l2Explorer).replace(/\/$/, '')}/address/${c.address}?tab=contract`} target="_blank" rel="noreferrer">{c.name ?? 'Contract'} · {c.address.slice(0, 8)}…{c.address.slice(-4)}</a>{' · '}
      {c.status === 'verified' ? 'Verified on explorer' : c.status === 'sourcify-verified' ? <><a href={`https://repo.sourcify.dev/${c.chainId}/${c.address}`} target="_blank" rel="noreferrer">Exact source verified</a> · explorer publication pending</> : c.status === 'source-unavailable' ? 'Source build needs attention' : 'Publishing automatically'}
    </li>)}</ul>
  </details>;
}
