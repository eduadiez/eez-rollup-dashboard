// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ConfiguredTreasuryBridge} from "./ConfiguredTreasuryBridge.sol";

/// @notice Treasury bridge whose peer is fixed before other treasuries reuse it.
contract SharedTreasuryBridge is ConfiguredTreasuryBridge {
    constructor(
        address token,
        uint64 destinationRollup,
        address manager_,
        uint64 localRollup,
        address admin_
    )
        ConfiguredTreasuryBridge(token, destinationRollup, manager_, localRollup, admin_)
    {}

    function seal() external onlyAdmin {
        if (canonicalBridgeAddress == address(0)) revert InvalidRoute();
        // No reachable caller is address(0); inherited administration is disabled.
        admin = address(0);
    }
}
