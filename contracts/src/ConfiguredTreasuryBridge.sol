// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryBridge} from "./TreasuryBridge.sol";
import {IEEZ} from "eez-core-protocol/src/interfaces/IEEZ.sol";
import {IEEZProxyRegistry} from "./interfaces/IEEZProxyRegistry.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Constructor-initialized treasury bridge for the shared testnet.
/// @dev The inherited test bridge has a public first-caller initializer. Binding
///      its manager and admin during creation removes that separate transaction's
///      takeover window. The administrator still configures the remote pair.
contract ConfiguredTreasuryBridge is TreasuryBridge {
    constructor(
        address token,
        uint64 destinationRollup,
        address manager_,
        uint64 localRollup,
        address admin_
    )
        TreasuryBridge(token, destinationRollup)
    {
        if (
            manager_.code.length == 0 || admin_ == address(0)
                || (localRollup != 0
                    && (localRollup != destinationRollup || IEEZProxyRegistry(manager_).ROLLUP_ID() != localRollup))
        ) revert InvalidRoute();
        manager = IEEZ(manager_);
        rollupId = localRollup;
        admin = admin_;
    }
}
