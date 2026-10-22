// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ConfiguredTreasuryBridge} from "./ConfiguredTreasuryBridge.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Setup variant whose temporary executor can hand administration to its wallet.
/// @dev Keeps the previous bridge artifact unchanged for pending deployment recovery.
contract BootstrapTreasuryBridge is ConfiguredTreasuryBridge {
    constructor(
        address token,
        uint64 destinationRollup,
        address manager_,
        uint64 localRollup,
        address admin_
    )
        ConfiguredTreasuryBridge(token, destinationRollup, manager_, localRollup, admin_)
    {}

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
    }
}
