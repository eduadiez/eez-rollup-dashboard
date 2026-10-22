import React from 'react';
import { createRoot } from 'react-dom/client';
import { TreasuryDemo } from '../../src/components/TreasuryDemo';
import { setConfig, L1_CHAIN, L2_CHAIN } from '../../src/config';
import { MainnetSetup } from '../../src/lib/treasury/mainnetSetup';
import network from '../../src/lib/treasury/mainnet-network.json';
import '../../src/styles/global.css';

export function mount() {
  const w = window as any;
  L1_CHAIN.chainId='0x1'; L2_CHAIN.chainId='0xaa29e';
  setConfig({rollupsAddress:network.registry,ccmL2Address:network.manager,l1Bridge:network.contracts.bridgeL1.address,l2Bridge:network.contracts.bridgeL2.address,
    l1Rpc:'https://mainnet.eez.dev/rpc/l1',l2Rpc:'https://mainnet.eez.dev/rpc/l2',l1ProxyRpc:'https://mainnet.eez.dev/composer/l1',l2ProxyRpc:'https://mainnet.eez.dev/composer/l2',
    l1Explorer:'https://etherscan.io',l2Explorer:'https://explorer.eez.dev',l1FeesEnabled:true,l2FeesEnabled:true,treasury:null});
  // Form-only fixture: selection is recorded before the real planner would make
  // its on-chain checks. It does not manufacture a deployment or open a wallet.
  MainnetSetup.prototype.configure=async function(deployer,safeL1,safeL2){w.selection={deployer,safeL1,safeL2};throw Error('Fixture stopped before network validation');};
  const wallet={address:'0x00000000000000000000000000000000000000C8',chainId:'0x1',provider:{request:async()=>{throw Error('Unexpected wallet prompt');}},walletOptions:[],connect:async()=>{},switchToL1:async()=>true,switchToL2:async()=>true};
  createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1200,margin:'32px auto',padding:20}}><TreasuryDemo ready wallet={wallet as any}/></main>);
}
