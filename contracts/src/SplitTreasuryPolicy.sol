// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {BidirectionalTreasuryPolicy} from "./BidirectionalTreasuryPolicy.sol";
import {TreasuryBridge} from "./TreasuryBridge.sol";
import {IEEZProxyRegistry} from "./interfaces/IEEZProxyRegistry.sol";
import {IAllowanceModule} from "./interfaces/IAllowanceModule.sol";

/// @notice Versioned deployment for payments with exact Safe contributions.
contract SplitTreasuryPolicy is BidirectionalTreasuryPolicy {
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
        BidirectionalTreasuryPolicy(safeL1_, safeL2_, manager, aliasReaderL1_, moduleL1, moduleL2, token, bridge_)
    {}
}
