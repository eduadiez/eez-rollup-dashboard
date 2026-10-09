/** Reserve the chosen gas limit at the source-chain fee cap, using integer units. */
export async function prepareNativeBridgeMax({ balance, feeCap, gasOverride, estimate }: {
  balance: bigint;
  feeCap: bigint;
  gasOverride: bigint | null;
  estimate: (value: bigint) => Promise<bigint>;
}): Promise<{ amount: bigint; reserve: bigint }> {
  if (balance <= 0n) throw new Error("No balance available to bridge.");
  if (feeCap < 0n) throw new Error("Invalid gas fee quote.");
  let amount = balance;
  for (let attempt = 0; attempt < 4; attempt++) {
    const estimatedGas = await estimate(amount);
    const gas = gasOverride ?? estimatedGas;
    if (gas <= 0n) throw new Error("A valid gas limit is required for MAX.");
    const reserve = gas * feeCap;
    const available = balance - reserve;
    if (available <= 0n) throw new Error("Not enough native balance to cover gas.");
    // Amounts only decrease. A lower second estimate leaves a small extra reserve.
    if (amount <= available) return { amount, reserve };
    amount = available;
  }
  throw new Error("The gas requirement changed repeatedly. Enter an amount manually.");
}
