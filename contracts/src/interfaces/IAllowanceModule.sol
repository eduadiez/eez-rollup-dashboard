// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Official AllowanceModule v1.0.0 ABI (compiled separately with 0.7.6).
interface IAllowanceModule {
    function VERSION() external view returns (string memory);
    function addDelegate(address delegate) external;
    function setAllowance(
        address delegate,
        address token,
        uint96 amount,
        uint16 resetTimeMin,
        uint32 resetBaseMin
    )
        external;
    /// @return allowance [amount, effective spent, resetTimeMin, effective lastResetMin, nonce].
    function getTokenAllowance(
        address safe,
        address delegate,
        address token
    )
        external
        view
        returns (uint256[5] memory allowance);
    function executeAllowanceTransfer(
        address safe,
        address token,
        address payable to,
        uint96 amount,
        address paymentToken,
        uint96 payment,
        address delegate,
        bytes calldata signature
    )
        external;
}
