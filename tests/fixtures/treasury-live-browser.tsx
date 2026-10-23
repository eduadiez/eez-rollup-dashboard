import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { toHex } from 'viem';
import { TreasuryConnected } from '../../src/components/TreasuryConnected';
import '../../src/styles/global.css';

// Replaces only the browser extension. The production client, RPCs, signatures,
// contracts, receipt recovery and history remain real in this owned devnet.
export function mount(config: any, addresses: Record<string,string>) {
  const w = window as any;
  const control = { label: sessionStorage.getItem('owner') || 'A', chain: sessionStorage.getItem('chain') || toHex(config.l1.chainId), select: (_label:string) => {} };
  const provider = { request: ({method,params}:any) => {
    if(method==='eth_chainId') return Promise.resolve(control.chain);
    if(method==='eth_accounts') return Promise.resolve([addresses[control.label]]);
    return w.liveWallet({label:control.label,chainId:control.chain,method,params});
  }};
  function Harness() {
    const [label,setLabel]=useState(control.label),[chain,setChain]=useState(control.chain);
    control.select=(next:string)=>{control.label=next;sessionStorage.setItem('owner',next);setLabel(next);};
    const switchTo=async(side:'l1'|'l2')=>{
      control.chain=toHex(config[side].chainId);sessionStorage.setItem('chain',control.chain);setChain(control.chain);
      await w.liveWallet({label:control.label,chainId:control.chain,method:'wallet_switchEthereumChain',params:[]});return true;
    };
    return <main style={{maxWidth:1200,margin:'32px auto',padding:20}}><TreasuryConnected deployment={config} payments wallet={{provider,address:addresses[label],chainId:chain,walletOptions:[],connect:async()=>{},switchToL1:()=>switchTo('l1'),switchToL2:()=>switchTo('l2')} as any}/></main>;
  }
  w.liveTreasury=control;createRoot(document.getElementById('root')!).render(<Harness/>);
}
