// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import {OwnerFixture, ReadThroughManager} from "./helpers/OwnerFixture.sol";
import {InvoiceMerchant} from "../src/InvoiceMerchant.sol";
import {TreasuryAliasReader} from "../src/TreasuryAliasReader.sol";
import {TreasuryPolicy} from "../src/TreasuryPolicy.sol";
import {DevnetUSDC} from "./fixtures/DevnetUSDC.sol";
import {TreasuryBridge} from "../src/TreasuryBridge.sol";
import {Bridge} from "eez-core-protocol/src/periphery/Bridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceModule} from "../src/interfaces/IAllowanceModule.sol";
import {IEEZProxyRegistry} from "../src/interfaces/IEEZProxyRegistry.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";

contract TreasuryPolicyTest is OwnerFixture {
    TreasuryPolicy policy;
    InvoiceMerchant merchant;
    DevnetUSDC usdc;
    IERC20 wrapped;
    TreasuryBridge bridge1;
    TreasuryBridge bridge2;
    IAllowanceModule module1;
    IAllowanceModule module2;
    address alias_;
    address recipient = address(0x1234);
    uint256 constant U = 1_000_000;

    function setUp() public override {
        super.setUp();
        usdc = new DevnetUSDC();
        bridge1 = new TreasuryBridge(address(usdc), ROLLUP_ID);
        bridge2 = new TreasuryBridge(address(usdc), ROLLUP_ID);
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
        _adminL1(abi.encodeCall(ISafe.enableModule, (address(module1))));
        _callL2(address(safeL2), abi.encodeCall(ISafe.enableModule, (address(module2))));
        _configure(true, abi.encodeCall(IAllowanceModule.addDelegate, (alias_)));
        _configure(false, abi.encodeCall(IAllowanceModule.addDelegate, (address(policy))));
        _setAllowance(true, 100 * U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
        _setAllowance(false, 100 * U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
    }

    function _newPolicy() internal virtual returns (TreasuryPolicy) {
        return new TreasuryPolicy(
            address(safeL1),
            address(safeL2),
            IEEZProxyRegistry(address(l2)),
            address(new TreasuryAliasReader(IEEZProxyRegistry(address(l1)))),
            address(module1),
            module2,
            address(usdc),
            bridge2,
            address(merchant)
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
                (onL1 ? alias_ : address(policy), onL1 ? address(usdc) : address(wrapped), uint96(amount), period, base)
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
            onL1 ? alias_ : address(policy),
            onL1 ? address(usdc) : address(wrapped)
        )[1];
    }

    function testPaymentsWithoutInvoiceFixtureAndExplicitInvoiceRejection() public {
        policy = new TreasuryPolicy(
            address(safeL1),
            address(safeL2),
            IEEZProxyRegistry(address(l2)),
            address(new TreasuryAliasReader(IEEZProxyRegistry(address(l1)))),
            address(module1),
            module2,
            address(usdc),
            bridge2,
            address(0)
        );
        alias_ = l1.getOrCreateCrossChainProxy(address(policy), ROLLUP_ID);
        _configure(true, abi.encodeCall(IAllowanceModule.addDelegate, (alias_)));
        _configure(false, abi.encodeCall(IAllowanceModule.addDelegate, (address(policy))));
        _setAllowance(true, 100 * U, 10, 10);
        _setAllowance(false, 100 * U, 10, 10);
        assertEq(policy.invoiceMerchant(), address(0));
        assertEq(address(policy.invoiceL1Proxy()), address(0));
        vm.prank(address(safeL2));
        vm.expectRevert(TreasuryPolicy.InvoicesDisabled.selector);
        policy.payInvoice(address(usdc), recipient, U, bytes32("missing"), vm.getBlockTimestamp() / 600);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(_spent(false), 0);
        assertEq(_spent(true), 0);
        testFortyThenSplit110ThenGlobalRejectsOneWithL2Capacity();
    }

    function testRemoteManagerDestinationIsRejectedButAliasReaderWorks() public {
        address remoteRegistry = l2.getOrCreateCrossChainProxy(address(l1), 0);
        vm.expectRevert(ReadThroughManager.EEZDestinationForbidden.selector);
        IEEZProxyRegistry(remoteRegistry).computeCrossChainProxyAddress(address(policy), ROLLUP_ID);
        TreasuryAliasReader readerProxy = policy.aliasReaderL1Proxy();
        vm.prank(address(policy));
        assertEq(readerProxy.aliasOf(address(policy), ROLLUP_ID), alias_);
    }

    function testFortyThenSplit110ThenGlobalRejectsOneWithL2Capacity() public {
        _pay(false, false, 40 * U);
        _pay(true, true, 110 * U);
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(wrapped.balanceOf(recipient), 40 * U);
        assertEq(usdc.balanceOf(address(safeL1)), 200 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 100 * U);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
        assertEq(usdc.balanceOf(address(bridge1)), 140 * U);
        assertEq(_spent(true), 100 * U);
        assertEq(_spent(false), 50 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 150 * U);
        vm.expectRevert(TreasuryPolicy.GlobalLimit.selector);
        vm.prank(address(safeL2));
        policy.pay(address(usdc), recipient, U, false, vm.getBlockTimestamp() / 600);
        assertEq(_spent(false), 50 * U);
        assertFalse(safeL1.isModuleEnabled(alias_));
        assertFalse(safeL2.isModuleEnabled(address(policy)));
        assertEq(wrapped.balanceOf(address(policy)), 0);
    }

    function testFinalL1TransferFailureRollsBackEarlierBridgeLegAndAllCounters() public {
        _pay(false, false, 40 * U);
        uint256 nonce = safeL2.nonce();
        uint256 l1Nonce = safeL1.nonce();
        uint256[5] memory a1 = module1.getTokenAllowance(address(safeL1), alias_, address(usdc));
        uint256[5] memory a2 = module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped));
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), abi.encode(false));
        bytes memory data = abi.encodeCall(
            TreasuryPolicy.payRouted, (address(usdc), recipient, 110 * U, true, vm.getBlockTimestamp() / 600)
        );
        bytes memory signature = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        // Require the earlier escrow release and the later failing transfer to
        // be reached, so an unrelated early rejection cannot satisfy this test.
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signature);
        assertEq(safeL2.nonce(), nonce);
        assertEq(safeL1.nonce(), l1Nonce);
        assertEq(wrapped.balanceOf(address(policy)), 0);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(wrapped.balanceOf(recipient), 40 * U);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 300 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 110 * U);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 40 * U);
        assertEq(abi.encode(a1), abi.encode(module1.getTokenAllowance(address(safeL1), alias_, address(usdc))));
        assertEq(
            abi.encode(a2), abi.encode(module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)))
        );
    }

    function testCombinedToL2LocksAndMintsWithExactConsumedApproval() public {
        _pay(true, false, 110 * U);
        assertEq(wrapped.balanceOf(recipient), 110 * U);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 290 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 50 * U);
        assertEq(_spent(true), 10 * U);
        assertEq(_spent(false), 100 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 110 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 160 * U);
        assertEq(wrapped.totalSupply(), 160 * U);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(wrapped.balanceOf(address(policy)), 0);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
        assertEq(bridge2.nextDepositNonce(), 1);
        assertTrue(bridge1.lockedDeposits(0));
        // The new representation shares the existing burn/release backing.
        vm.prank(recipient);
        bridge2.bridgeTokens(address(wrapped), 110 * U, 0, recipient);
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
    }

    function testL2DestinationUsesBalanceAndCanBeEntirelyFundedFromL1() public {
        vm.prank(address(safeL2));
        wrapped.transfer(address(0xbeef), 150 * U);
        _pay(true, false, 90 * U);
        assertEq(_spent(true), 90 * U);
        assertEq(_spent(false), 0);
        assertEq(wrapped.balanceOf(recipient), 90 * U);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
    }

    function testLockFailureRollsBackEarlierLocalTransferAndBothAllowances() public {
        uint256 nonce = safeL2.nonce();
        uint256[5] memory a1 = module1.getTokenAllowance(address(safeL1), alias_, address(usdc));
        uint256[5] memory a2 = module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped));
        bytes memory lockCall = abi.encodeCall(IERC20.transferFrom, (alias_, address(bridge1), 10 * U));
        vm.mockCall(address(usdc), lockCall, abi.encode(false));
        bytes memory data = abi.encodeCall(
            TreasuryPolicy.payRouted, (address(usdc), recipient, 110 * U, false, vm.getBlockTimestamp() / 600)
        );
        bytes memory signature = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.expectCall(address(wrapped), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (alias_, 10 * U)), 1);
        vm.expectCall(address(usdc), lockCall, 1);
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signature);
        assertEq(safeL2.nonce(), nonce);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 300 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(usdc.allowance(alias_, address(bridge1)), 0);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 0);
        assertEq(bridge2.nextDepositNonce(), 0);
        assertFalse(bridge1.lockedDeposits(0));
        assertEq(abi.encode(a1), abi.encode(module1.getTokenAllowance(address(safeL1), alias_, address(usdc))));
        assertEq(
            abi.encode(a2), abi.encode(module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)))
        );
    }

    function testLockAuthenticatesBridgeAndRejectsConsumedNonce() public {
        vm.expectRevert(Bridge.UnauthorizedCaller.selector);
        bridge1.lockForL2(address(policy), 10 * U, recipient, 0);
        _pay(true, false, 110 * U);
        address bridgeAlias = l1.computeCrossChainProxyAddress(address(bridge2), ROLLUP_ID);
        vm.expectRevert(TreasuryBridge.DepositAlreadyLocked.selector);
        vm.prank(bridgeAlias);
        bridge1.lockForL2(address(policy), 10 * U, recipient, 0);
        assertEq(wrapped.balanceOf(recipient), 110 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 160 * U);
    }

    function testCallerCannotUseAnotherPayersAliasApproval() public {
        vm.prank(address(safeL1));
        usdc.transfer(alias_, U);
        vm.prank(alias_);
        usdc.approve(address(bridge1), U);
        // bridgeFromL1 has no payer argument. An unrelated caller can only spend
        // its own alias, even when the policy's alias has funds and an approval.
        vm.expectRevert(
            abi.encodeWithSignature("ERC20InsufficientAllowance(address,uint256,uint256)", address(bridge1), 0, U)
        );
        bridge2.bridgeFromL1(U, recipient);
        assertEq(usdc.balanceOf(alias_), U);
        assertEq(usdc.allowance(alias_, address(bridge1)), U);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(bridge2.nextDepositNonce(), 0);
        assertFalse(bridge1.lockedDeposits(0));
    }

    function testMalformedLockReceiptCannotMint() public {
        address proxy = l2.getOrCreateCrossChainProxy(address(bridge1), 0);
        vm.mockCall(address(proxy), abi.encodeWithSelector(TreasuryBridge.lockForL2.selector), abi.encode(bytes32(0)));
        vm.expectRevert(TreasuryBridge.InvalidLockReceipt.selector);
        bridge2.bridgeFromL1(U, recipient);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(bridge2.nextDepositNonce(), 0);
    }

    function testLockRejectsTransferWithoutExactEscrowCredit() public {
        address bridgeAlias = l1.getOrCreateCrossChainProxy(address(bridge2), ROLLUP_ID);
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transferFrom, (alias_, address(bridge1), U)), abi.encode(true));
        vm.expectRevert(TreasuryBridge.InexactLock.selector);
        vm.prank(bridgeAlias);
        bridge1.lockForL2(address(policy), U, recipient, 0);
        assertFalse(bridge1.lockedDeposits(0));
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
    }

    function testBridgeRejectsWrongSideAndInvalidArguments() public {
        vm.expectRevert(TreasuryBridge.InvalidRoute.selector);
        bridge1.bridgeFromL1(U, recipient);
        vm.expectRevert(Bridge.ZeroAmount.selector);
        bridge2.bridgeFromL1(0, recipient);
        vm.expectRevert(Bridge.ZeroAddress.selector);
        bridge2.bridgeFromL1(U, address(0));
        bridge2.setCanonicalBridgeAddress(address(0xbeef));
        vm.expectRevert(TreasuryPolicy.InvalidConfiguration.selector);
        vm.prank(address(safeL2));
        policy.payRouted(address(usdc), recipient, U, false, vm.getBlockTimestamp() / 600);
    }

    function testRouterUsesBalanceAsWellAsAllowance() public {
        vm.prank(address(safeL1));
        usdc.transfer(address(0xbeef), 250 * U);
        _pay(true, true, 60 * U);
        assertEq(_spent(true), 50 * U);
        assertEq(_spent(false), 10 * U);
        assertEq(usdc.balanceOf(recipient), 60 * U);
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

    function _rule(uint16 bps, bool onL1) private {
        _callL2(
            address(policy),
            abi.encodeCall(TreasuryPolicy.payRule, (address(usdc), recipient, bps, onL1, vm.getBlockTimestamp() / 600))
        );
    }

    function testRuleThirtyThenReverse110ShareOneBudget() public {
        _pay(false, false, 40 * U);
        _pay(true, true, 110 * U);
        vm.warp((vm.getBlockTimestamp() / 600 + 1) * 600);
        vm.expectEmit(true, true, false, true, address(policy));
        emit TreasuryPolicy.RulePaid(
            address(usdc), recipient, true, 1000, 200 * U, 100 * U, 30 * U, vm.getBlockTimestamp() / 600
        );
        _rule(1000, true);
        assertEq(usdc.balanceOf(address(safeL1)), 170 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 100 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 30 * U);
        assertEq(_spent(true), 30 * U);
        _pay(true, false, 110 * U);
        assertEq(usdc.balanceOf(address(safeL1)), 160 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 0);
        assertEq(_spent(true), 40 * U);
        assertEq(_spent(false), 100 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 140 * U);
        // 10% of 160 is within L1 capacity, but only 10 remains globally.
        vm.expectRevert(TreasuryPolicy.GlobalLimit.selector);
        vm.prank(address(safeL2));
        policy.payRule(address(usdc), recipient, 1000, true, vm.getBlockTimestamp() / 600);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 140 * U);
    }

    function testRuleCountsOnlySafeHoldingsAndRoundsDown() public {
        vm.prank(address(safeL1));
        usdc.transfer(alias_, 7 * U);
        vm.prank(address(safeL2));
        wrapped.transfer(address(policy), 3 * U + 1);
        _rule(1000, true);
        assertEq(usdc.balanceOf(recipient), 43_999_999);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 43_999_999);
        assertEq(usdc.balanceOf(alias_), 7 * U);
        assertEq(wrapped.balanceOf(address(policy)), 3 * U + 1);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
    }

    function testSignedRuleUsesExecutionBalancesAfterAnL1OwnerTransfer() public {
        bytes memory data = abi.encodeCall(
            TreasuryPolicy.payRule, (address(usdc), recipient, 1000, true, vm.getBlockTimestamp() / 600)
        );
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        bytes memory transfer = abi.encodeCall(IERC20.transfer, (address(0xbeef), 100 * U));
        assertTrue(
            _execute(
                safeL1,
                address(usdc),
                transfer,
                0,
                _signTwo(keccak256(_preimage(safeL1, address(usdc), transfer, 0)), A, B)
            )
        );
        // The unchanged signed fraction now pays 35, not the earlier 45 estimate.
        assertTrue(_execute(safeL2, address(policy), data, 0, signatures));
        assertEq(usdc.balanceOf(recipient), 35 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 35 * U);
    }

    function _assertRuleRoutes(bool onL1) private {
        _pay(false, onL1, 90 * U);
        _rule(1000, onL1);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 126 * U);
        assertEq(_spent(onL1), 100 * U);
        assertEq(_spent(!onL1), 26 * U);
        assertEq((onL1 ? IERC20(address(usdc)) : wrapped).balanceOf(recipient), 126 * U);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(wrapped.balanceOf(address(policy)), 0);
    }

    function testRuleCombinesSafesForL1Recipient() public {
        _assertRuleRoutes(true);
    }

    function testRuleCombinesSafesForL2Recipient() public {
        _assertRuleRoutes(false);
    }

    function testRuleRejectsInvalidFractionCallerAssetRecipientAndEpoch() public {
        uint256 epoch = vm.getBlockTimestamp() / 600;
        vm.expectRevert(TreasuryPolicy.OnlySafe.selector);
        policy.payRule(address(usdc), recipient, 1000, true, epoch);
        vm.startPrank(address(safeL2));
        vm.expectRevert(TreasuryPolicy.InvalidFraction.selector);
        policy.payRule(address(usdc), recipient, 0, true, epoch);
        vm.expectRevert(TreasuryPolicy.InvalidFraction.selector);
        policy.payRule(address(usdc), recipient, 10001, true, epoch);
        vm.expectRevert(TreasuryPolicy.InvalidAsset.selector);
        policy.payRule(address(wrapped), recipient, 1000, true, epoch);
        vm.expectRevert(TreasuryPolicy.InvalidRecipient.selector);
        policy.payRule(address(usdc), address(policy), 1000, true, epoch);
        vm.expectRevert(TreasuryPolicy.StaleEpoch.selector);
        policy.payRule(address(usdc), recipient, 1000, true, epoch - 1);
        vm.stopPrank();
        assertEq(policy.spent(epoch), 0);
    }

    function testRuleRejectsPerPaymentLimitAndInsufficientCapacityWithoutClipping() public {
        vm.expectRevert(TreasuryPolicy.InvalidAmount.selector);
        vm.prank(address(safeL2));
        policy.payRule(address(usdc), recipient, 10000, true, vm.getBlockTimestamp() / 600);
        _setAllowance(true, U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
        _setAllowance(false, U, 10, uint32(vm.getBlockTimestamp() / 600 * 10));
        vm.expectRevert(TreasuryPolicy.Capacity.selector);
        vm.prank(address(safeL2));
        policy.payRule(address(usdc), recipient, 1000, false, vm.getBlockTimestamp() / 600);
        assertEq(usdc.balanceOf(recipient), 0);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(_spent(true) + _spent(false), 0);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 0);
    }

    function testRuleRejectsZeroResultAndAllowsWholeBalanceAtFractionBoundary() public {
        vm.prank(address(safeL1));
        usdc.transfer(address(0xbeef), 300 * U - 9);
        vm.prank(address(safeL2));
        wrapped.transfer(address(0xbeef), 150 * U);
        vm.expectRevert(TreasuryPolicy.InvalidAmount.selector);
        vm.prank(address(safeL2));
        policy.payRule(address(usdc), recipient, 1000, true, vm.getBlockTimestamp() / 600);
        _rule(10000, true);
        assertEq(usdc.balanceOf(recipient), 9);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 9);
    }

    function testRuleLargeIntermediateUsesFullPrecisionAndStillEnforcesLimit() public {
        vm.mockCall(
            address(usdc), abi.encodeCall(IERC20.balanceOf, (address(safeL1))), abi.encode(type(uint256).max - 150 * U)
        );
        vm.expectRevert(TreasuryPolicy.InvalidAmount.selector);
        vm.prank(address(safeL2));
        policy.payRule(address(usdc), recipient, 1000, true, vm.getBlockTimestamp() / 600);
    }

    function testRuleLaterTransferFailureRollsBackItsEarlierBridgeContribution() public {
        _pay(false, true, 90 * U);
        uint256 nonce = safeL2.nonce();
        uint256[5] memory a1 = module1.getTokenAllowance(address(safeL1), alias_, address(usdc));
        uint256[5] memory a2 = module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped));
        bytes memory data = abi.encodeCall(
            TreasuryPolicy.payRule, (address(usdc), recipient, 1000, true, vm.getBlockTimestamp() / 600)
        );
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), abi.encode(false));
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 26 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signatures);
        assertEq(safeL2.nonce(), nonce);
        assertEq(usdc.balanceOf(recipient), 90 * U);
        assertEq(wrapped.balanceOf(recipient), 0);
        assertEq(usdc.balanceOf(address(safeL1)), 210 * U);
        assertEq(wrapped.balanceOf(address(safeL2)), 150 * U);
        assertEq(usdc.balanceOf(address(bridge1)), 150 * U);
        assertEq(wrapped.totalSupply(), 150 * U);
        assertEq(wrapped.balanceOf(address(policy)), 0);
        assertEq(usdc.balanceOf(alias_), 0);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 90 * U);
        assertEq(abi.encode(a1), abi.encode(module1.getTokenAllowance(address(safeL1), alias_, address(usdc))));
        assertEq(
            abi.encode(a2), abi.encode(module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)))
        );
    }

    function testFuzzRuleFractionMatchesAmountAndAllowanceDebits(uint16 bps) public {
        bps = uint16(bound(bps, 1, 3333));
        uint256 expected = 450 * U * bps / 10_000;
        _rule(bps, true);
        assertEq(usdc.balanceOf(recipient), expected);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), expected);
        assertEq(_spent(true) + _spent(false), expected);
        assertEq(usdc.balanceOf(address(bridge1)), wrapped.totalSupply());
    }

    function _invoiceData(bytes32 id, uint256 amount) private view returns (bytes memory) {
        return
            abi.encodeCall(
                TreasuryPolicy.payInvoice, (address(usdc), recipient, amount, id, vm.getBlockTimestamp() / 600)
            );
    }

    function _treasuryState() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                usdc.balanceOf(address(safeL1)),
                wrapped.balanceOf(address(safeL2)),
                usdc.balanceOf(recipient),
                wrapped.balanceOf(recipient),
                usdc.balanceOf(address(bridge1)),
                wrapped.totalSupply(),
                usdc.balanceOf(alias_),
                wrapped.balanceOf(address(policy)),
                module1.getTokenAllowance(address(safeL1), alias_, address(usdc)),
                module2.getTokenAllowance(address(safeL2), address(policy), address(wrapped)),
                policy.spent(vm.getBlockTimestamp() / 600),
                safeL1.nonce(),
                safeL2.nonce()
            )
        );
    }

    function testInvoiceAcceptsExactTermsAfterBothContributions() public {
        bytes32 id = keccak256("invoice");
        merchant.open(id, recipient, 110 * U);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        _callL2(address(policy), _invoiceData(id, 110 * U));
        (,, InvoiceMerchant.Status status) = merchant.invoices(id);
        assertEq(uint256(status), uint256(InvoiceMerchant.Status.Paid));
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(policy.spent(vm.getBlockTimestamp() / 600), 110 * U);
        assertEq(_spent(true), 100 * U);
        assertEq(_spent(false), 10 * U);
        vm.expectRevert(abi.encodeWithSelector(InvoiceMerchant.InvoiceNotOpen.selector, id));
        vm.prank(alias_);
        merchant.accept(id, address(usdc), recipient, 110 * U);
    }

    function testClosedInvoiceRollsBackTransfersAllowancesBudgetAndSafeNonce() public {
        bytes32 id = keccak256("closed invoice");
        merchant.open(id, recipient, 110 * U);
        merchant.close(id);
        bytes32 beforeState = _treasuryState();
        bytes memory data = _invoiceData(id, 110 * U);
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 10 * U)), 1);
        vm.expectCall(address(usdc), abi.encodeCall(IERC20.transfer, (recipient, 100 * U)), 1);
        vm.expectCall(
            address(merchant), abi.encodeCall(InvoiceMerchant.accept, (id, address(usdc), recipient, 110 * U)), 1
        );
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signatures);
        assertEq(_treasuryState(), beforeState);
        (,, InvoiceMerchant.Status status) = merchant.invoices(id);
        assertEq(uint256(status), uint256(InvoiceMerchant.Status.Closed));
    }

    function testInvoiceTermsAndControllerCannotBeBypassed() public {
        bytes32 id = keccak256("terms");
        merchant.open(id, recipient, U);
        vm.expectRevert(InvoiceMerchant.Unauthorized.selector);
        merchant.accept(id, address(usdc), recipient, U);
        vm.expectRevert(InvoiceMerchant.Unauthorized.selector);
        vm.prank(recipient);
        merchant.close(id);
        vm.expectRevert(InvoiceMerchant.Unauthorized.selector);
        merchant.bindPolicy(recipient);
        vm.startPrank(alias_);
        vm.expectRevert(InvoiceMerchant.TermsMismatch.selector);
        merchant.accept(id, address(wrapped), recipient, U);
        vm.expectRevert(InvoiceMerchant.TermsMismatch.selector);
        merchant.accept(id, address(usdc), alias_, U);
        vm.expectRevert(InvoiceMerchant.TermsMismatch.selector);
        merchant.accept(id, address(usdc), recipient, U + 1);
        vm.stopPrank();
        vm.expectRevert(TreasuryPolicy.OnlySafe.selector);
        policy.payInvoice(address(usdc), recipient, U, id, vm.getBlockTimestamp() / 600);
        bytes32 beforeState = _treasuryState();
        bytes memory data = _invoiceData(id, 2 * U);
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(policy), data, 0)), A, B));
        vm.expectRevert("GS013");
        _execute(safeL2, address(policy), data, 0, signatures);
        assertEq(_treasuryState(), beforeState);
        merchant.close(id);
        vm.expectRevert(InvoiceMerchant.InvalidInvoice.selector);
        merchant.open(id, recipient, U);
    }
}
