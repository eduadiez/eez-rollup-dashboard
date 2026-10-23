// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Six-decimal private-devnet fixture, not Circle-issued USDC.
/// @dev Fixed setup supply; no mint authority remains after construction.
contract DevnetUSDC is ERC20 {
    constructor() ERC20("Devnet USD Coin", "USDC") {
        _mint(msg.sender, 450_000_000);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
