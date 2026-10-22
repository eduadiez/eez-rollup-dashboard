// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {TreasuryPolicyUpgrade} from "./TreasuryPolicyUpgrade.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Enable owner-selected contributions without replacing either Safe.
contract SplitTreasuryPolicyUpgrade is TreasuryPolicyUpgrade {
    bool public immutable previousIsUpgrade;

    constructor(
        TreasuryPolicy previous,
        address moduleL1,
        bool previousIsUpgrade_
    )
        TreasuryPolicyUpgrade(previous, moduleL1)
    {
        previousIsUpgrade = previousIsUpgrade_;
    }

    /// @dev Include the predecessor's inherited counters, not just its transfers.
    function _previousCarry(uint256 epoch) internal view override returns (uint256, uint256) {
        if (!previousIsUpgrade) return (0, 0);
        return TreasuryPolicyUpgrade(address(previousPolicy)).carriedSpending(epoch);
    }
}
