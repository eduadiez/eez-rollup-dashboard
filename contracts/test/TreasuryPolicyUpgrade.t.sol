// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryPolicyTest} from "./TreasuryPolicy.t.sol";
import {TreasuryPolicy} from "../src/TreasuryPolicy.sol";
import {TreasuryPolicyUpgrade} from "../src/TreasuryPolicyUpgrade.sol";
import {IAllowanceModule} from "../src/interfaces/IAllowanceModule.sol";

import {SplitTreasuryPolicyUpgrade} from "../src/SplitTreasuryPolicyUpgrade.sol";

contract TreasuryPolicyUpgradeTest is TreasuryPolicyTest {
    TreasuryPolicyUpgrade next;
    address nextAlias;

    function _deployUpgrade() internal {
        next = new TreasuryPolicyUpgrade(policy, address(module1));
        nextAlias = l1.getOrCreateCrossChainProxy(address(next), ROLLUP_ID);
    }

    function _handover(bool onL1) internal {
        _setAllowance(onL1, 0, 10, 10);
        address delegate = onL1 ? nextAlias : address(next);
        _configure(onL1, abi.encodeCall(IAllowanceModule.addDelegate, (delegate)));
        _configure(
            onL1,
            abi.encodeCall(
                IAllowanceModule.setAllowance,
                (delegate, onL1 ? address(usdc) : address(wrapped), uint96(100 * U), uint16(10), uint32(10))
            )
        );
    }

    function _activate() internal {
        _callL2(address(next), abi.encodeCall(next.activate, ()));
    }

    function _nextPayment(bool sourceL1, bool destinationL1, uint256 amount) internal {
        bytes memory data = abi.encodeCall(
            next.payRouted, (address(usdc), recipient, amount, destinationL1, vm.getBlockTimestamp() / 600)
        );
        if (sourceL1) {
            assertTrue(
                _execute(safeL1, nextAlias, data, 0, _signTwo(keccak256(_preimage(safeL1, nextAlias, data, 0)), A, B))
            );
        } else {
            _callL2(address(next), data);
        }
    }

    function _reject(bool sourceL1, address target, bytes memory data) internal {
        bytes32 hash = keccak256(_preimage(sourceL1 ? safeL1 : safeL2, target, data, 0));
        bytes memory signatures = _signTwo(hash, A, B);
        if (!sourceL1) signatures = _outer(adapter, signatures);
        vm.expectRevert(bytes("GS013"));
        _execute(sourceL1 ? safeL1 : safeL2, target, data, 0, signatures);
    }

    function _rejectPayment(bool sourceL1, bool destinationL1) internal {
        _reject(
            sourceL1,
            sourceL1 ? nextAlias : address(next),
            abi.encodeCall(next.payRouted, (address(usdc), recipient, U, destinationL1, vm.getBlockTimestamp() / 600))
        );
    }

    function testUpgradeRetainsSafesBalancesAndLiveSpending() public {
        _pay(false, false, 30 * U);
        _deployUpgrade();
        _handover(true);
        // Old L2 payments can still execute between the two Safe approvals.
        _pay(false, false, 10 * U);
        uint256 balance1 = usdc.balanceOf(address(safeL1));
        uint256 balance2 = wrapped.balanceOf(address(safeL2));
        _handover(false);
        _activate();
        assertEq(next.safeL1(), address(safeL1));
        assertEq(next.safeL2(), address(safeL2));
        assertEq(usdc.balanceOf(address(safeL1)), balance1);
        assertEq(wrapped.balanceOf(address(safeL2)), balance2);
        assertEq(next.spent(vm.getBlockTimestamp() / 600), 40 * U);
        (uint256 carry1, uint256 carry2) = next.carriedSpending(vm.getBlockTimestamp() / 600);
        assertEq(carry1, 0);
        assertEq(carry2, 40 * U);
        _nextPayment(true, true, 110 * U);
        assertEq(usdc.balanceOf(recipient), 110 * U);
        assertEq(next.spent(vm.getBlockTimestamp() / 600), 150 * U);
        _rejectPayment(false, false);
    }

    function testUpgradeCarriesEachSafeCeiling() public {
        _pay(false, false, 90 * U);
        _deployUpgrade();
        _handover(true);
        _handover(false);
        _activate();
        _nextPayment(true, false, 20 * U);
        // Only ten of the remaining tokens fit on L2; the other ten bridge from L1.
        uint256[5] memory grant1 = module1.getTokenAllowance(address(safeL1), nextAlias, address(usdc));
        uint256[5] memory grant2 = module2.getTokenAllowance(address(safeL2), address(next), address(wrapped));
        assertEq(grant1[1], 10 * U);
        assertEq(grant2[1], 10 * U);
        assertEq(next.spent(vm.getBlockTimestamp() / 600), 110 * U);
    }

    function testNewEpochDoesNotCarryOldSpending() public {
        _pay(false, false, 40 * U);
        _deployUpgrade();
        _handover(true);
        _handover(false);
        _activate();
        vm.warp((vm.getBlockTimestamp() / 600 + 1) * 600);
        (uint256 carry1, uint256 carry2) = next.carriedSpending(vm.getBlockTimestamp() / 600);
        assertEq(carry1 + carry2, 0);
        _nextPayment(false, false, 110 * U);
        assertEq(next.spent(vm.getBlockTimestamp() / 600), 110 * U);
    }

    function testEpochChangeDuringHandover() public {
        _pay(false, false, 40 * U);
        _deployUpgrade();
        _handover(true);
        vm.warp((vm.getBlockTimestamp() / 600 + 1) * 600);
        _handover(false);
        _activate();
        assertEq(next.spent(vm.getBlockTimestamp() / 600), 0);
        _nextPayment(true, true, 110 * U);
    }

    function testInactivePolicyRejectsBothSafes() public {
        _deployUpgrade();
        _handover(true);
        _rejectPayment(true, true);
        _rejectPayment(false, false);
    }

    function testCannotActivateWithEitherOldGrantLive() public {
        _deployUpgrade();
        _reject(false, address(next), abi.encodeCall(next.activate, ()));
        _handover(false);
        _reject(false, address(next), abi.encodeCall(next.activate, ()));
        assertFalse(next.active());
        _handover(true);
        _activate();
    }

    function testActivationRejectsWrongCallerAndReplay() public {
        _deployUpgrade();
        _handover(true);
        _handover(false);
        vm.expectRevert(TreasuryPolicy.OnlySafe.selector);
        next.activate();
        _activate();
        _reject(false, address(next), abi.encodeCall(next.activate, ()));
    }

    function testBothOldDelegatesAreDisabled() public {
        _deployUpgrade();
        _handover(true);
        _handover(false);
        _activate();
        _reject(
            false,
            address(policy),
            abi.encodeCall(policy.pay, (address(usdc), recipient, U, true, vm.getBlockTimestamp() / 600))
        );
        _reject(
            false,
            address(policy),
            abi.encodeCall(policy.pay, (address(usdc), recipient, U, false, vm.getBlockTimestamp() / 600))
        );
    }

    function testActivationRejectsResetOldCounter() public {
        _pay(false, false, 40 * U);
        _deployUpgrade();
        _handover(true);
        _handover(false);
        vm.prank(address(safeL2));
        (bool ok,) = address(module2)
            .call(abi.encodeWithSignature("resetAllowance(address,address)", address(policy), address(wrapped)));
        assertTrue(ok);
        _reject(false, address(next), abi.encodeCall(next.activate, ()));
        assertFalse(next.active());
        assertEq(next.spent(vm.getBlockTimestamp() / 600), 0);
    }

    function testSecondUpgradeCarriesInheritedAndNewSpending() public {
        _pay(false, false, 40 * U);
        _deployUpgrade();
        _handover(true);
        _handover(false);
        _activate();
        _nextPayment(true, true, 20 * U);
        policy = next;
        alias_ = nextAlias;
        next = new SplitTreasuryPolicyUpgrade(policy, address(module1), true);
        nextAlias = l1.getOrCreateCrossChainProxy(address(next), ROLLUP_ID);
        _handover(true);
        _handover(false);
        _activate();
        (uint256 c1, uint256 c2) = next.carriedSpending(block.timestamp / 600);
        assertEq(c1, 20 * U);
        assertEq(c2, 40 * U);
        bytes memory data =
            abi.encodeCall(next.paySplit, (address(usdc), recipient, 90 * U, false, block.timestamp / 600, 80 * U));
        _callL2(address(next), data);
        assertEq(next.spent(block.timestamp / 600), 150 * U);
        _rejectPayment(true, true);
    }

    function testSplitUpgradeRejectsOmittedPriorCarry() public {
        _pay(false, false, 40 * U);
        _deployUpgrade();
        _handover(true);
        _handover(false);
        _activate();
        policy = next;
        alias_ = nextAlias;
        next = new SplitTreasuryPolicyUpgrade(policy, address(module1), false);
        nextAlias = l1.getOrCreateCrossChainProxy(address(next), ROLLUP_ID);
        _handover(true);
        _handover(false);
        _reject(false, address(next), abi.encodeCall(next.activate, ()));
        assertFalse(next.active());
    }
}
