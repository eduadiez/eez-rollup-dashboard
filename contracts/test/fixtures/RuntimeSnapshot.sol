// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @dev Isolated rehearsal only: install captured runtime bytes with explicit
/// proxy slots. All other state starts empty and is initialized using real APIs.
/// This is not a deployment script or a claim to reproduce mainnet balances.
contract RuntimeSnapshot {
    constructor(bytes memory runtime, bytes32[] memory slots, bytes32[] memory values) {
        require(slots.length == values.length && runtime.length > 0);
        for (uint256 i; i < slots.length; ++i) {
            bytes32 slot = slots[i];
            bytes32 value = values[i];
            assembly ("memory-safe") { sstore(slot, value) }
        }
        assembly ("memory-safe") { return(add(runtime, 32), mload(runtime)) }
    }
}
