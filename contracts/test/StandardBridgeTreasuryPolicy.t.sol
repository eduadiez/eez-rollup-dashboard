// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {OwnerFixture, ReadThroughManager} from "./helpers/OwnerFixture.sol";
import {InvoiceMerchant} from "../src/InvoiceMerchant.sol";
import {TreasuryAliasReader} from "../src/TreasuryAliasReader.sol";
import {StandardBridgeTreasuryPolicy as TreasuryPolicy} from "../src/StandardBridgeTreasuryPolicy.sol";
import {StandardBridgeDelegate} from "../src/StandardBridgeDelegate.sol";
import {IStandardBridge} from "../src/interfaces/IStandardBridge.sol";
import {DevnetUSDC} from "./fixtures/DevnetUSDC.sol";
import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceModule} from "../src/interfaces/IAllowanceModule.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";

contract StandardBridgeTreasuryPolicyTest is OwnerFixture {
    TreasuryPolicy policy;
    StandardBridgeDelegate executor;
    InvoiceMerchant merchant;
    DevnetUSDC usdc;
    IERC20 wrapped;
    Bridge bridge1;
    Bridge bridge2;
    IAllowanceModule module1;
    IAllowanceModule module2;
    address alias_;
    address recipient = address(0x1234);
    uint256 constant U = 1_000_000;

    function setUp() public override {
        super.setUp();
        usdc = new DevnetUSDC();
        bridge1 = new Bridge();
        bridge2 = new Bridge();
        bridge1.initialize(address(l1), 0, address(this));
        bridge2.initialize(address(l2), ROLLUP_ID, address(this));
        bridge1.setCanonicalBridgeAddress(address(bridge2));
        bridge2.setCanonicalBridgeAddress(address(bridge1));
        usdc.transfer(address(safeL1), 300 * U);
        usdc.approve(address(bridge1), 150 * U);
        bridge1.bridgeTokens(address(usdc), 150 * U, ROLLUP_ID, address(safeL2));
        wrapped = IERC20(bridge2.getWrappedToken(address(usdc), 0));
        module1 = IAllowanceModule(_deployLegacy("AllowanceModule"));
        module2 = IAllowanceModule(_deployLegacy("AllowanceModule"));
        merchant = new InvoiceMerchant(address(usdc));
        policy = _newPolicy();
        alias_ = l1.getOrCreateCrossChainProxy(address(policy), ROLLUP_ID);
        merchant.bindPolicy(alias_);
        vm.prank(address(safeL1));
        executor.bindPolicy(alias_);
        _adminL1(abi.encodeCall(ISafe.enableModule, (address(module1))));
        _callL2(address(safeL2), abi.encodeCall(ISafe.enableModule, (address(module2))));
        _configure(true, abi.encodeCall(IAllowanceModule.addDelegate, (address(executor))));
        _configure(false, abi.encodeCall(IAllowanceModule.addDelegate, (address(policy))));
        _setAllowance(true, 100 * U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
        _setAllowance(false, 100 * U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
    }

    function _newPolicy() internal virtual returns (TreasuryPolicy) {
        executor =
            new StandardBridgeDelegate(address(safeL1), module1, usdc, IStandardBridge(address(bridge1)), ROLLUP_ID);
        return new TreasuryPolicy(
            address(safeL1),
            address(safeL2),
            IEEZProxyRegistry(address(l2)),
            address(new TreasuryAliasReader(IEEZProxyRegistry(address(l1)))),
            address(module1),
            module2,
            address(usdc),
            IStandardBridge(address(bridge2)),
            address(merchant),
            address(executor)
        );
    }

    function _configure(bool onL1, bytes memory data) internal {
        if (!onL1) {
            _callL2(address(module2), data);
        } else {
            assertTrue(
                _execute(
                    safeL1,
                    address(module1),
                    data,
                    0,
                    _signTwo(keccak256(_preimage(safeL1, address(module1), data, 0)), A, B)
                )
            );
        }
    }

    function _setAllowance(bool onL1, uint256 amount, uint16 period, uint32 base) internal {
        _configure(
            onL1,
            abi.encodeCall(
                IAllowanceModule.setAllowance,
                (
                    onL1 ? address(executor) : address(policy),
                    onL1 ? address(usdc) : address(wrapped),
                    uint96(amount),
                    period,
                    base
                )
            )
        );
    }

    function _pay(bool routed, bool onL1, uint256 amount) internal {
        _callL2(
            address(policy),
            abi.encodeWithSelector(
                routed ? policy.payRouted.selector : policy.pay.selector,
                address(usdc),
                recipient,
                amount,
                onL1,
                vm.getBlockTimestamp() / 600
            )
        );
    }

    function _spent(bool onL1) internal view returns (uint256) {
        return (onL1 ? module1 : module2)
        .getTokenAllowance(
            onL1 ? address(safeL1) : address(safeL2),
            onL1 ? address(executor) : address(policy),
            onL1 ? address(usdc) : address(wrapped)
        )[1];
    }

    function testPeriodResetAndSignedEpochRejectStaleApproval() public {
        _pay(false, false, 40 * U);
        _pay(true, true, 110 * U);
        uint256 old = vm.getBlockTimestamp() / 600;
        vm.warp((old + 1) * 600 - 1);
        assertEq(_spent(false), 50 * U);
        vm.warp((old + 1) * 600);
        assertEq(_spent(true), 0);
        assertEq(_spent(false), 0);
        vm.expectRevert(TreasuryPolicy.StaleEpoch.selector);
        vm.prank(address(safeL2));
        policy.pay(address(usdc), recipient, U, false, old);
        _pay(false, false, U);
        assertEq(policy.spent(old), 150 * U);
        assertEq(policy.spent(old + 1), U);
    }

    function testOnlySafeCanonicalAssetAndCheckedAmounts() public {
        vm.expectRevert(TreasuryPolicy.OnlySafe.selector);
        policy.pay(address(usdc), recipient, U, false, vm.getBlockTimestamp() / 600);
        vm.startPrank(address(safeL2));
        vm.expectRevert(TreasuryPolicy.InvalidAsset.selector);
        policy.pay(address(wrapped), recipient, U, false, vm.getBlockTimestamp() / 600);
        vm.expectRevert(TreasuryPolicy.InvalidAmount.selector);
        policy.pay(address(usdc), recipient, type(uint256).max, false, vm.getBlockTimestamp() / 600);
        vm.expectRevert(TreasuryPolicy.InvalidAmount.selector);
        policy.pay(address(usdc), recipient, 0, false, vm.getBlockTimestamp() / 600);
        vm.expectRevert(TreasuryPolicy.InvalidRecipient.selector);
        policy.pay(address(usdc), address(policy), U, false, vm.getBlockTimestamp() / 600);
        vm.expectRevert(TreasuryPolicy.Capacity.selector);
        policy.pay(address(usdc), recipient, 101 * U, true, vm.getBlockTimestamp() / 600);
        vm.expectRevert(TreasuryPolicy.Capacity.selector);
        policy.pay(address(usdc), recipient, 101 * U, false, vm.getBlockTimestamp() / 600);
        vm.stopPrank();
    }

    function testMisalignedAllowanceCannotCrossEpochs() public {
        _setAllowance(true, 100 * U, 11, uint32(vm.getBlockTimestamp() / 60));
        vm.expectRevert(TreasuryPolicy.UnalignedAllowance.selector);
        vm.prank(address(safeL2));
        policy.pay(address(usdc), recipient, U, true, vm.getBlockTimestamp() / 600);
    }

    function testFuzzLocalPaymentCannotExceedEitherBudget(uint96 amount) public {
        amount = uint96(bound(amount, 1, 100 * U));
        _pay(false, false, amount);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), amount);
        assertEq(_spent(false), amount);
        assertEq(wrapped.balanceOf(recipient), amount);
    }

    function _l1Data(bool onL1, uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(policy.payRouted, (address(usdc), recipient, amount, onL1, block.timestamp / 600));
    }

    function _fromL1(bytes memory data) internal {
        assertTrue(_execute(safeL1, alias_, data, 0, _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B)));
    }

    function testL1OwnerTransactionSplitsToL2() public {
        uint256 n1 = safeL1.nonce();
        uint256 n2 = safeL2.nonce();
        _fromL1(_l1Data(false, 110 * U));
        assertEq(wrapped.balanceOf(recipient), 110 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 50 * U);
        assertEq(usdc.balanceOf(address(safeL1)), 290 * U);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
        assertEq(_spent(true), 10 * U);
        assertEq(_spent(false), 100 * U);
        assertEq(policy.spent(block.timestamp / 600), 110 * U);
        assertEq(safeL1.nonce(), n1 + 1);
        assertEq(safeL2.nonce(), n2);
    }

    function testL1OwnerTransactionSplitsToL1() public {
        _fromL1(_l1Data(true, 110 * U));
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(_spent(true), 100 * U);
        assertEq(_spent(false), 10 * U);
        assertEq(policy.spent(block.timestamp / 600), 110 * U);
    }

    function _expectL1Failure(bytes memory) internal virtual {
        vm.expectRevert(bytes("GS013"));
    }

    function testSharedBudgetAcrossBothInitiators() public {
        _pay(false, false, 40 * U);
        _fromL1(_l1Data(true, 110 * U));
        assertEq(policy.spent(block.timestamp / 600), 150 * U);
        assertEq(_spent(false), 50 * U);
        uint256 nonce = safeL1.nonce();
        bytes memory data = _l1Data(false, U);
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B);
        _expectL1Failure(abi.encodeWithSelector(TreasuryPolicy.GlobalLimit.selector));
        _execute(safeL1, alias_, data, 0, signatures);
        assertEq(safeL1.nonce(), nonce);
        assertEq(_spent(false), 50 * U);
    }

    function testL1OwnerSignatureCannotReplay() public {
        bytes memory data = _l1Data(false, U);
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B);
        assertTrue(_execute(safeL1, alias_, data, 0, signatures));
        vm.expectRevert();
        _execute(safeL1, alias_, data, 0, signatures);
        assertEq(wrapped.balanceOf(recipient), U);
    }

    function testL1EntryRejectsEOAAndOtherProxy() public {
        bytes memory data = _l1Data(false, U);
        vm.prank(vm.addr(A));
        (bool direct,) = address(policy).call(data);
        assertFalse(direct);
        vm.prank(vm.addr(A));
        (bool viaProxy,) = alias_.call(data);
        assertFalse(viaProxy);
        assertEq(policy.spent(block.timestamp / 600), 0);
    }

    function testL1FailureRollsBackEarlierL2LegAndNonce() public {
        bytes memory data = abi.encodeCall(
            policy.payInvoice, (address(usdc), recipient, 110 * U, bytes32("closed"), block.timestamp / 600)
        );
        uint256 nonce = safeL1.nonce();
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, alias_, data, 0)), A, B);
        _expectL1Failure(abi.encodeWithSelector(InvoiceMerchant.InvoiceNotOpen.selector, bytes32("closed")));
        _execute(safeL1, alias_, data, 0, signatures);
        assertEq(safeL1.nonce(), nonce);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U);
        assertEq(_spent(true), 0);
        assertEq(_spent(false), 0);
        assertEq(policy.spent(block.timestamp / 600), 0);
    }

    function testFundingDelegateBindsOnlyOnceThroughItsSafe() public {
        StandardBridgeDelegate fresh =
            new StandardBridgeDelegate(address(safeL1), module1, usdc, IStandardBridge(address(bridge1)), ROLLUP_ID);
        vm.expectRevert(StandardBridgeDelegate.OnlySafe.selector);
        fresh.bindPolicy(alias_);
        vm.prank(address(safeL1));
        fresh.bindPolicy(alias_);
        vm.prank(address(safeL1));
        vm.expectRevert(StandardBridgeDelegate.InvalidConfiguration.selector);
        fresh.bindPolicy(alias_);
    }

    function testFundingDelegateCannotBeSpentByOwnerOrOtherPolicy() public {
        vm.prank(vm.addr(A));
        vm.expectRevert(StandardBridgeDelegate.OnlyPolicy.selector);
        executor.pay(recipient, U, true);
        vm.prank(address(policy));
        vm.expectRevert(StandardBridgeDelegate.OnlyPolicy.selector);
        executor.pay(recipient, U, false);
        assertEq(_spent(true), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 300 * U);
    }

    function testReverseLegUsesExistingGenericBridgeAPI() public {
        vm.expectCall(
            address(bridge1),
            abi.encodeCall(IStandardBridge.bridgeTokens, (address(usdc), 10 * U, ROLLUP_ID, recipient))
        );
        _fromL1(_l1Data(false, 110 * U));
        assertEq(wrapped.balanceOf(recipient), 110 * U);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
        assertEq(usdc.balanceOf(alias_), 0);
    }
}
