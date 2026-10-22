// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {BidirectionalTreasuryPolicy} from "./BidirectionalTreasuryPolicy.sol";
import {IAllowanceModule} from "./interfaces/IAllowanceModule.sol";
import {IEEZProxyRegistry} from "./interfaces/IEEZProxyRegistry.sol";

/// @notice Replace an existing policy without replacing its Safes or resetting its budget.
contract TreasuryPolicyUpgrade is BidirectionalTreasuryPolicy {
    TreasuryPolicy public immutable previousPolicy;
    bool public active;
    uint256 public activationEpoch;
    uint256 private carriedL1;
    uint256 private carriedL2;

    error InactivePolicy();
    error InvalidHandover();
    event Activated(address indexed previousPolicy, uint256 epoch, uint256 fromL1, uint256 fromL2);

    constructor(
        TreasuryPolicy previous,
        address moduleL1
    )
        BidirectionalTreasuryPolicy(
            previous.safeL1(),
            previous.safeL2(),
            IEEZProxyRegistry(address(previous.bridge().manager())),
            previous.aliasReaderL1(),
            moduleL1,
            previous.allowanceL2(),
            previous.canonicalToken(),
            previous.bridge()
        )
    {
        if (
            address(allowanceL1Proxy) != address(previous.allowanceL1Proxy()) || previous.PERIOD() != PERIOD
                || previous.GLOBAL_LIMIT() != GLOBAL_LIMIT
        ) revert InvalidConfiguration();
        previousPolicy = previous;
    }

    /// @dev The final SafeL2 batch revokes its old grant immediately before this
    /// call. Read the L1 revocation and both counters at activation, not at
    /// deployment: the previous policy may have spent between wallet approvals.
    function activate() external {
        if (msg.sender != safeL2) revert OnlySafe();
        if (active) revert InvalidHandover();
        uint256 epoch = block.timestamp / PERIOD;
        address previousAlias = aliasReaderL1Proxy.aliasOf(address(previousPolicy), rollupId);
        address nextAlias = aliasReaderL1Proxy.aliasOf(address(this), rollupId);
        uint256 usedL1 = _handover(allowanceL1Proxy, safeL1, previousAlias, nextAlias, canonicalToken, epoch);
        uint256 usedL2 = _handover(allowanceL2, safeL2, address(previousPolicy), address(this), wrappedToken, epoch);
        (uint256 priorL1, uint256 priorL2) = _previousCarry(epoch);
        usedL1 += priorL1;
        usedL2 += priorL2;
        uint256 used = previousPolicy.spent(epoch);
        // An administrator resetting one of the counters creates an ambiguous
        // handover. Wait for the next aligned period rather than infer capacity.
        if (used != usedL1 + usedL2 || used > GLOBAL_LIMIT || usedL1 > 100_000_000 || usedL2 > 100_000_000) {
            revert InvalidHandover();
        }
        activationEpoch = epoch;
        carriedL1 = usedL1;
        carriedL2 = usedL2;
        spent[epoch] = used;
        active = true;
        emit Activated(address(previousPolicy), epoch, usedL1, usedL2);
    }

    function _previousCarry(uint256) internal view virtual returns (uint256, uint256) {
        return (0, 0);
    }

    function carriedSpending(uint256 epoch) public view returns (uint256 fromL1, uint256 fromL2) {
        return active && epoch == activationEpoch ? (carriedL1, carriedL2) : (uint256(0), uint256(0));
    }

    function _handover(
        IAllowanceModule module,
        address safe,
        address previous,
        address next,
        address token,
        uint256 epoch
    )
        private
        view
        returns (uint256)
    {
        uint256[5] memory oldGrant = module.getTokenAllowance(safe, previous, token);
        uint256[5] memory newGrant = module.getTokenAllowance(safe, next, token);
        if (
            oldGrant[0] != 0 || oldGrant[1] > 100_000_000 || newGrant[0] != 100_000_000 || newGrant[1] != 0
                || oldGrant[2] != 10 || newGrant[2] != 10 || oldGrant[3] != epoch * 10 || newGrant[3] != epoch * 10
        ) {
            revert InvalidHandover();
        }
        return oldGrant[1];
    }

    function _authorizePayment() internal override {
        if (!active) revert InactivePolicy();
        super._authorizePayment();
    }

    function _remaining(
        IAllowanceModule module,
        address safe,
        address delegate,
        address token,
        uint256 epoch
    )
        internal
        view
        override
        returns (uint256)
    {
        uint256 capacity = super._remaining(module, safe, delegate, token, epoch);
        (uint256 usedL1, uint256 usedL2) = carriedSpending(epoch);
        uint256 carried = address(module) == address(allowanceL1Proxy) ? usedL1 : usedL2;
        return capacity > carried ? capacity - carried : 0;
    }
}
