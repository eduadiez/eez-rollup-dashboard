export interface CrossChainFeeQuote {
  transaction: Record<string, string>;
  expiresAt: string;
}

interface FeeOptions {
  tx: Record<string, string>;
  from: string;
  chainId: string;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  wallet: { isRabby?: boolean; request(args: { method: string; params?: unknown[] }): Promise<unknown> };
  maxTotalFee: bigint;
  log?: (message: string) => void;
  onQuote?: (quote: CrossChainFeeQuote) => void;
}

export function quoteCrossChainFees(options: FeeOptions): Promise<CrossChainFeeQuote>;
export function sendCrossChainWithFees(options: FeeOptions): Promise<string>;
