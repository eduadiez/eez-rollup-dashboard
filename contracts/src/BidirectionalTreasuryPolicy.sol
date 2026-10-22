// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {TreasuryBridge} from "./TreasuryBridge.sol";
import {IEEZProxyRegistry} from "./interfaces/IEEZProxyRegistry.sol";
import {IAllowanceModule} from "./interfaces/IAllowanceModule.sol";
import {ISafe} from "./interfaces/ISafe.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// One budget for payments initiated by either treasury Safe.
contract BidirectionalTreasuryPolicy is TreasuryPolicy {
    address public immutable safeL1Proxy;

    /// @dev Safe increments its nonce before calling the policy. This event binds
    ///      canonical L2 payment evidence to the reviewed L1 Safe call. A later
    ///      payment failure also rolls this event back.
    event L1PaymentAuthorized(uint256 indexed safeNonce, bytes32 indexed callHash);

    constructor(
        address safeL1_,
        address safeL2_,
        IEEZProxyRegistry manager,
        address aliasReaderL1_,
        address moduleL1,
        IAllowanceModule moduleL2,
        address token,
        TreasuryBridge bridge_
    )
        TreasuryPolicy(safeL1_, safeL2_, manager, aliasReaderL1_, moduleL1, moduleL2, token, bridge_)
    {
        address proxy = manager.getOrCreateCrossChainProxy(safeL1_, 0);
        (bool registered, address original, uint64 origin) = manager.authorizedProxies(proxy);
        if (!registered || original != safeL1_ || origin != 0 || proxy.code.length == 0) {
            revert InvalidConfiguration();
        }
        safeL1Proxy = proxy;
    }

    function _authorizePayment() internal virtual override {
        if (msg.sender == safeL2) return;
        if (msg.sender != safeL1Proxy) revert OnlySafe();
        emit L1PaymentAuthorized(ISafe(safeL1Proxy).nonce(), keccak256(msg.data));
    }
}
