// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ISafe, ISafeProxyFactory} from "../src/interfaces/ISafe.sol";
import {IAllowanceModule} from "../src/interfaces/IAllowanceModule.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICircleUSDC is IERC20 {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function paused() external view returns (bool);
    function pauser() external view returns (address);
    function pause() external;
    function blacklister() external view returns (address);
    function blacklist(address account) external;
}

/// @dev Local-fork fixture only. The second transfer can fail after the first
///      succeeds, checking ERC-20/module rollback without claiming EEZ coverage.
contract ForkAllowanceDelegate {
    function pay(IAllowanceModule module_, address safe, address token, address to, uint96 amount) public {
        module_.executeAllowanceTransfer(safe, token, payable(to), amount, address(0), 0, address(this), "");
    }

    function payTwice(IAllowanceModule module_, address safe, address token, address first, address second) external {
        pay(module_, safe, token, first, 10_000_000);
        pay(module_, safe, token, second, 10_000_000);
    }
}

/// @notice Real Circle bytecode/state on an explicitly selected Ethereum fork.
/// @dev No broadcast path. Funding and role impersonation exist only in the fork.
contract USDCCompatibilityTest is Test {
    ICircleUSDC constant TOKEN = ICircleUSDC(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    uint256 constant OWNER_KEY = 0xA11CE;
    ISafe safe;
    IAllowanceModule allowanceModule;
    ForkAllowanceDelegate delegate;
    address recipient = address(0xBEEF);

    function setUp() public {
        require(block.chainid == 1 && address(TOKEN).code.length > 0, "Select an Ethereum fork");
        address holder = vm.envAddress("TREASURY_USDC_HOLDER");
        require(TOKEN.balanceOf(holder) >= 300_000_000 && !TOKEN.paused(), "Select an available USDC holder/block");
        address singleton = _deployLegacy("Safe");
        ISafeProxyFactory factory = ISafeProxyFactory(_deployLegacy("SafeProxyFactory"));
        address[] memory owners = new address[](1);
        owners[0] = vm.addr(OWNER_KEY);
        bytes memory setup =
            abi.encodeCall(ISafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0))));
        safe = ISafe(factory.createProxyWithNonce(singleton, setup, 1));
        allowanceModule = IAllowanceModule(_deployLegacy("AllowanceModule"));
        delegate = new ForkAllowanceDelegate();
        _execute(address(safe), abi.encodeCall(ISafe.enableModule, (address(allowanceModule))));
        _execute(address(allowanceModule), abi.encodeCall(IAllowanceModule.addDelegate, (address(delegate))));
        _execute(
            address(allowanceModule),
            abi.encodeCall(
                IAllowanceModule.setAllowance,
                (address(delegate), address(TOKEN), 100_000_000, 10, uint32(block.timestamp / 600 * 10))
            )
        );
        vm.prank(holder);
        assertTrue(TOKEN.transfer(address(safe), 300_000_000));
    }

    function test_RealUSDCMetadataAndContractDelegatePayment() public {
        assertEq(TOKEN.symbol(), "USDC");
        assertEq(TOKEN.decimals(), 6);
        uint256 supply = TOKEN.totalSupply();
        uint256 beforeBalance = TOKEN.balanceOf(recipient);
        delegate.pay(allowanceModule, address(safe), address(TOKEN), recipient, 40_000_001);
        assertEq(TOKEN.balanceOf(recipient) - beforeBalance, 40_000_001);
        assertEq(TOKEN.balanceOf(address(safe)), 259_999_999);
        assertEq(TOKEN.totalSupply(), supply);
        assertEq(_allowance()[1], 40_000_001);
    }

    function test_RealUSDCAllowanceCeiling() public {
        delegate.pay(allowanceModule, address(safe), address(TOKEN), recipient, 100_000_000);
        vm.expectRevert(bytes("newSpent > allowance.spent && newSpent <= allowance.amount"));
        delegate.pay(allowanceModule, address(safe), address(TOKEN), recipient, 1);
        assertEq(_allowance()[1], 100_000_000);
        assertEq(TOKEN.balanceOf(address(safe)), 200_000_000);
    }

    function test_PausedUSDCDoesNotConsumeAllowance() public {
        vm.prank(TOKEN.pauser());
        TOKEN.pause();
        uint256[5] memory beforeAllowance = _allowance();
        vm.expectRevert(bytes("Could not execute token transfer"));
        delegate.pay(allowanceModule, address(safe), address(TOKEN), recipient, 10_000_000);
        assertEq(keccak256(abi.encode(_allowance())), keccak256(abi.encode(beforeAllowance)));
        assertEq(TOKEN.balanceOf(address(safe)), 300_000_000);
    }

    function test_BlacklistedSecondTransferUndoesEarlierTransferAndAllowance() public {
        address rejected = address(0xBAD);
        vm.prank(TOKEN.blacklister());
        TOKEN.blacklist(rejected);
        uint256 beforeBalance = TOKEN.balanceOf(recipient);
        uint256 rejectedBalance = TOKEN.balanceOf(rejected);
        uint256[5] memory beforeAllowance = _allowance();
        vm.expectCall(address(TOKEN), abi.encodeCall(IERC20.transfer, (recipient, 10_000_000)));
        vm.expectCall(address(TOKEN), abi.encodeCall(IERC20.transfer, (rejected, 10_000_000)));
        vm.expectRevert(bytes("Could not execute token transfer"));
        delegate.payTwice(allowanceModule, address(safe), address(TOKEN), recipient, rejected);
        assertEq(TOKEN.balanceOf(recipient), beforeBalance);
        assertEq(TOKEN.balanceOf(rejected), rejectedBalance);
        assertEq(TOKEN.balanceOf(address(safe)), 300_000_000);
        assertEq(keccak256(abi.encode(_allowance())), keccak256(abi.encode(beforeAllowance)));
    }

    function _allowance() private view returns (uint256[5] memory) {
        return allowanceModule.getTokenAllowance(address(safe), address(delegate), address(TOKEN));
    }

    function _execute(address to, bytes memory data) private {
        bytes32 hash = safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, hash);
        assertTrue(
            safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v))
        );
    }

    function _deployLegacy(string memory name) private returns (address deployed) {
        bytes memory code = vm.parseJsonBytes(
            vm.readFile(string.concat("legacy/out/", name, ".sol/", name, ".json")), ".bytecode.object"
        );
        assembly ("memory-safe") { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "Legacy fixture deployment failed");
    }
}
