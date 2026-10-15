export function sendL2WithFees(options: {
  tx: Record<string, string>;
  from: string;
  chainId: string;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  wallet: { isRabby?: boolean; request(args: { method: string; params?: unknown[] }): Promise<unknown> };
  maxTotalFee: bigint;
  log?: (message: string) => void;
}): Promise<string>;
