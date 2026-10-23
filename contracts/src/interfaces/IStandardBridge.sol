// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Public ABI of the existing generic EEZ bridge pair.
interface IStandardBridge {
    function manager() external view returns (address);
    function rollupId() external view returns (uint64);
    function canonicalBridgeAddress() external view returns (address);
    function getWrappedToken(address token, uint64 origin) external view returns (address);
    function wrappedTokenInfo(address token) external view returns (address, uint64);
    function bridgeTokens(address token, uint256 amount, uint64 destination, address recipient) external;
}
