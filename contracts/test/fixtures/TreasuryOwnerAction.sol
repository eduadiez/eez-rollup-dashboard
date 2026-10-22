// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @dev Integration-only action: establish that the real L2 Safe executed the call.
contract TreasuryOwnerAction {
    address public immutable safe;
    uint256 public value;
    address public lastCaller;

    constructor(address safe_) {
        safe = safe_;
    }

    function setValue(uint256 value_) external {
        require(msg.sender == safe, "only Safe");
        value = value_;
        lastCaller = msg.sender;
    }
}
