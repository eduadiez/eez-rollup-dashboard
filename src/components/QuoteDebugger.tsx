import { useEffect, useRef, useState, type FormEvent } from "react";
import { config, DISCOVERED_CHAIN_IDS } from "../config";
import { buildDebugQuote, decodeQuoteRun, requestDebugQuote, type QuoteFields, type QuoteRun } from "../lib/quoteDebug";
import styles from "./QuoteDebugger.module.css";

type RunMessage = { type: "run"; sequence: number; run: QuoteRun | null };
const empty: QuoteFields = { from: "", to: "", data: "0x", value: "0", gas: "", nonce: "" };

export function QuoteDebugger({ ready }: { ready: boolean }) {
  const iframe = useRef<HTMLIFrameElement>(null), port = useRef<MessagePort | null>(null);
  const quote = useRef<AbortController | null>(null), decoding = useRef<AbortController | null>(null);
  const request = useRef(0), lastRun = useRef<RunMessage | null>(null);
  const viewerSequence = useRef(0);
  const [connected, setConnected] = useState(false);
  const [fields, setFields] = useState(empty);
  const [chain, setChain] = useState<"l1" | "l2">("l2");
  const [type, setType] = useState<"0x0" | "0x2" | "both">("0x2");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(true);
  const onMessage = useRef<(data: Record<string, unknown>) => void>(() => {});

  function cancelQuote() {
    request.current++; quote.current?.abort(); quote.current = null; setBusy(false);
  }

  function enrich(message: RunMessage) {
    decoding.current?.abort();
    const controller = new AbortController(); decoding.current = controller;
    const { run, sequence } = message;
    if (!run) return;
    const send = (data: Record<string, unknown>) => {
      if (!controller.signal.aborted) port.current?.postMessage({ ...data, sequence, runId: run.id });
    };
    if (!ready) { send({ type: "decoding-status", text: "Waiting for network configuration before looking up verified ABIs…" }); return; }
    send({ type: "decoding-status", text: "Looking up verified contract ABIs…" });
    void decodeQuoteRun(run, { ...DISCOVERED_CHAIN_IDS }, {
      l1: config.l1ExplorerApi || config.l1Explorer, l2: config.l2ExplorerApi || config.l2Explorer,
    }, controller.signal, frames => send({ type: "annotations", frames })).then(text => send({ type: "decoding-status", text }))
      .catch(() => send({ type: "decoding-status", text: "Verified decoding unavailable; captured bytes are still available." }));
  }

  onMessage.current = data => {
    if (Number.isSafeInteger(data.sequence)) viewerSequence.current = data.sequence as number;
    if (data.type === "ready" && data.version === 1) setConnected(true);
    if (data.type === "import-started") {
      cancelQuote(); decoding.current?.abort(); lastRun.current = null;
    }
    if (data.type === "run" && Number.isSafeInteger(data.sequence) &&
      (data.run === null || (typeof data.run === "object" && Array.isArray((data.run as QuoteRun).frames) && (data.run as QuoteRun).frames.length <= 4096))) {
      // An import or run change supersedes a pending request and its metadata.
      cancelQuote(); setError(""); setFormOpen(false);
      lastRun.current = data as unknown as RunMessage;
      enrich(lastRun.current);
    }
    if (data.type === "invalid" && typeof data.message === "string") {
      cancelQuote(); decoding.current?.abort(); lastRun.current = null;
      setError(data.message.slice(0, 512)); setFormOpen(true);
    }
  };

  useEffect(() => {
    if (ready && lastRun.current) enrich(lastRun.current);
    // Configuration becomes usable once discovery completes. Runs themselves
    // are driven by the port, without reconnecting it on every form edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => () => {
    request.current++; quote.current?.abort(); decoding.current?.abort(); port.current?.close();
  }, []);

  function connect() {
    cancelQuote(); viewerSequence.current = 0;
    port.current?.close(); decoding.current?.abort(); lastRun.current = null;
    setConnected(false);
    const channel = new MessageChannel(); port.current = channel.port1;
    channel.port1.onmessage = event => {
      if (event.data && typeof event.data === "object") onMessage.current(event.data);
    };
    // A sandbox without allow-same-origin has an opaque target origin. The
    // receiver checks event.source and our origin before accepting this port.
    iframe.current?.contentWindow?.postMessage({ type: "eez-quote-connect", version: 1 }, "*", [channel.port2]);
  }

  async function simulate(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready || !connected) return;
    setError("");
    let body;
    try { body = buildDebugQuote(fields, type); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Invalid transaction."); return; }
    cancelQuote();
    const id = request.current, expectedSequence = viewerSequence.current, controller = new AbortController(); quote.current = controller;
    setBusy(true);
    try {
      const text = await requestDebugQuote(chain === "l1" ? config.l1ProxyRpc : config.l2ProxyRpc, body, controller.signal);
      if (id === request.current && !controller.signal.aborted) port.current?.postMessage({ type: "load", text, expectedSequence });
    } catch (failure) {
      if (id === request.current && !controller.signal.aborted) {
        setError(failure instanceof Error && failure.name === "TimeoutError"
          ? "The quote request timed out. Try again when the Composer is ready."
          : failure instanceof Error ? failure.message : "Unable to request a fee quote.");
      }
    } finally { if (id === request.current) { setBusy(false); quote.current = null; } }
  }

  const field = (key: keyof QuoteFields) => ({ value: fields[key], onChange: (event: { target: { value: string } }) =>
    setFields(previous => ({ ...previous, [key]: event.target.value })) });
  return <main id="main" tabIndex={-1} className={styles.page} aria-label="Quote debugger">
    <section className={styles.request} aria-label="Simulate a transaction">
      <button className={styles.toggle} aria-expanded={formOpen} aria-controls="quote-form" onClick={() => setFormOpen(!formOpen)}>
        <span>{formOpen ? "▾" : "▸"} Simulate a transaction</span><small>Fee estimate · no wallet required</small>
      </button>
      <form id="quote-form" onSubmit={simulate} hidden={!formOpen}>
        <p>Enter the unsigned transaction. Run a fee quote and inspect its calls here.</p>
        <div className={styles.grid}>
          <label>Source chain<select aria-label="Source chain" value={chain} disabled={busy} onChange={event => setChain(event.target.value as "l1" | "l2")}>
            <option value="l1">L1 · {config.l1NetworkName}</option><option value="l2">L2 · {config.rollupName}</option>
          </select></label>
          <label>Transaction format<select aria-label="Transaction format" value={type} disabled={busy} onChange={event => setType(event.target.value as typeof type)}>
            <option value="0x2">EIP-1559</option><option value="0x0">Legacy</option><option value="both">Both formats</option>
          </select></label>
          <label>From<input aria-label="From address" placeholder="0x… sender" spellCheck={false} required {...field("from")} /></label>
          <label>To<input aria-label="To address" placeholder="0x… target (empty for contract creation)" spellCheck={false} {...field("to")} /></label>
          <label className={styles.wide}>Calldata<textarea aria-label="Calldata" spellCheck={false} rows={3} {...field("data")} /></label>
          <label>Value (wei)<input aria-label="Value in wei" spellCheck={false} {...field("value")} /></label>
          <details className={styles.advanced}><summary>Gas and nonce (optional)</summary>
            <label>Gas limit<input aria-label="Gas limit" placeholder="Automatic" {...field("gas")} /></label>
            <label>Nonce<input aria-label="Nonce" placeholder="Resolve from current state" {...field("nonce")} /></label>
          </details>
        </div>
        <div className={styles.actions}>
          <button type="submit" className="btn btn-primary" disabled={busy || !ready || !connected}>{busy ? "Simulating…" : "Simulate fee quote"}</button>
          {busy && <button type="button" className="btn btn-outline" onClick={cancelQuote}>Cancel</button>}
          <span role="status">{!ready ? "Loading network configuration…" : !connected ? "Loading trace viewer…" : "Uses the source chain's Composer. Nothing is signed or broadcast."}</span>
        </div>
      </form>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
    <iframe ref={iframe} title="Cross-chain quote trace viewer" onLoad={connect}
      src={`${import.meta.env.BASE_URL}quote-trace/index.html?embedded=1`}
      sandbox="allow-scripts allow-downloads" className={styles.frame} />
  </main>;
}
