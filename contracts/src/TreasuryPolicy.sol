// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IEEZProxyRegistry} from "./interfaces/IEEZProxyRegistry.sol";
import {IAllowanceModule} from "./interfaces/IAllowanceModule.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TreasuryAliasReader} from "./TreasuryAliasReader.sol";
import {TreasuryBridge} from "./TreasuryBridge.sol";

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// A single canonical USDC budget over two Safe allowance delegates.
/// @dev Demo policy: local and combined payments to either chain.
///      Only the official allowance module has Safe module power. Owners retain
///      direct spending and administration. Remote view calls require EEZ tables.
contract TreasuryPolicy {
    uint256 public constant SPLIT_VERSION = 1;
    uint256 public constant PERIOD = 600;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant GLOBAL_LIMIT = 150_000_000;
    uint256 public constant PER_PAYMENT = 150_000_000;
    address public immutable safeL1;
    address public immutable safeL2;
    address public immutable canonicalToken;
    address public immutable wrappedToken;
    IAllowanceModule public immutable allowanceL2;
    IAllowanceModule public immutable allowanceL1Proxy;
    IERC20 public immutable tokenL1Proxy;
    address public immutable aliasReaderL1;
    TreasuryAliasReader public immutable aliasReaderL1Proxy;
    uint64 public immutable rollupId;
    TreasuryBridge public immutable bridge;
    address public immutable bridgeL1;
    mapping(uint256 epoch => uint256 amount) public spent;
    bool private entered;

    error OnlySafe();
    error InvalidConfiguration();
    error InvalidAsset();
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidFraction();
    error StaleEpoch();
    error GlobalLimit();
    error Capacity();
    error UnalignedAllowance();
    error ApprovalFailed();
    error Reentered();
    error ResidualBalance();
    event Paid(
        address indexed token,
        address indexed recipient,
        bool onL1,
        uint256 amount,
        uint256 fromL1,
        uint256 fromL2,
        uint256 epoch
    );

    event RulePaid(
        address indexed token,
        address indexed recipient,
        bool onL1,
        uint16 bps,
        uint256 balanceL1,
        uint256 balanceL2,
        uint256 amount,
        uint256 epoch
    );

    // Hold the same authorization/reentrancy boundary across rule reads and all
    // payment legs. Each public entry point shares it; no self-call is needed.
    modifier paymentExecution() {
        _authorizePayment();
        if (entered) revert Reentered();
        entered = true;
        _;
        entered = false;
    }

    /// @dev Override only the authenticated entry boundary; payment accounting is shared.
    function _authorizePayment() internal virtual {
        if (msg.sender != safeL2) revert OnlySafe();
    }

    constructor(
        address safeL1_,
        address safeL2_,
        IEEZProxyRegistry manager,
        address aliasReaderL1_,
        address moduleL1,
        IAllowanceModule moduleL2,
        address token,
        TreasuryBridge bridge_
    ) {
        if (
            safeL1_ == address(0) || safeL2_.code.length == 0 || address(moduleL2).code.length == 0
                || aliasReaderL1_ == address(0) || moduleL1 == address(0) || token == address(0)
                || manager.ROLLUP_ID() == 0 || address(bridge_.manager()) != address(manager)
                || bridge_.rollupId() != manager.ROLLUP_ID() || bridge_.treasuryRollupId() != manager.ROLLUP_ID()
                || bridge_.canonicalToken() != token || bridge_.canonicalBridgeAddress() == address(0)
        ) revert InvalidConfiguration();
        address wrapped = bridge_.getWrappedToken(token, 0);
        (address original, uint64 origin) = bridge_.wrappedTokenInfo(wrapped);
        if (wrapped.code.length == 0 || original != token || origin != 0) revert InvalidConfiguration();
        safeL1 = safeL1_;
        safeL2 = safeL2_;
        canonicalToken = token;
        wrappedToken = wrapped;
        allowanceL2 = moduleL2;
        bridge = bridge_;
        bridgeL1 = bridge_.canonicalBridgeAddress();
        rollupId = manager.ROLLUP_ID();
        // Provision local proxies outside STATICCALL. The deployment must also
        // provision this policy's L1 alias before its first remote read.
        allowanceL1Proxy = IAllowanceModule(manager.getOrCreateCrossChainProxy(moduleL1, 0));
        tokenL1Proxy = IERC20(manager.getOrCreateCrossChainProxy(token, 0));
        aliasReaderL1 = aliasReaderL1_;
        aliasReaderL1Proxy = TreasuryAliasReader(manager.getOrCreateCrossChainProxy(aliasReaderL1_, 0));
    }

    /// @notice Spend only the destination chain's allowance.
    function pay(
        address token,
        address recipient,
        uint256 amount,
        bool onL1,
        uint256 expectedEpoch
    )
        external
        paymentExecution
    {
        _pay(token, recipient, amount, onL1, false, expectedEpoch, type(uint256).max);
    }

    /// @notice Fill the recipient's chain first and bridge the remainder from the other Safe.
    function payRouted(
        address token,
        address recipient,
        uint256 amount,
        bool onL1,
        uint256 expectedEpoch
    )
        external
        paymentExecution
    {
        _pay(token, recipient, amount, onL1, true, expectedEpoch, type(uint256).max);
    }

    /// @notice Pay exactly the contributions approved by the owners, on either chain.
    /// @dev The remainder comes from SafeL2. Never rebalance a signed allocation
    ///      when capacity changes; fail before either transfer instead.
    function paySplit(
        address token,
        address recipient,
        uint256 amount,
        bool onL1,
        uint256 expectedEpoch,
        uint256 fromL1
    )
        external
        paymentExecution
    {
        if (fromL1 > amount) revert InvalidAmount();
        _pay(token, recipient, amount, onL1, true, expectedEpoch, fromL1);
    }

    /// @notice Pay a fraction of both Safe holdings using destination-first routing.
    /// @dev Owners authorize the fraction, not a fixed preview amount. Both balances
    ///      are read before transfers; escrow and temporary policy custody are not
    ///      holdings. Rounds down to token base units. Zero or over-limit results,
    ///      an invalid fraction/epoch and insufficient capacity revert the payment.
    function payRule(
        address token,
        address recipient,
        uint16 bps,
        bool onL1,
        uint256 expectedEpoch
    )
        external
        paymentExecution
    {
        if (token != canonicalToken) revert InvalidAsset();
        if (expectedEpoch != block.timestamp / PERIOD) revert StaleEpoch();
        if (bps == 0 || bps > BPS_DENOMINATOR) revert InvalidFraction();
        uint256 balanceL1 = tokenL1Proxy.balanceOf(safeL1);
        uint256 balanceL2 = IERC20(wrappedToken).balanceOf(safeL2);
        uint256 amount = Math.mulDiv(balanceL1 + balanceL2, bps, BPS_DENOMINATOR);
        _pay(token, recipient, amount, onL1, true, expectedEpoch, type(uint256).max);
        emit RulePaid(canonicalToken, recipient, onL1, bps, balanceL1, balanceL2, amount, expectedEpoch);
    }

    function _pay(
        address token,
        address recipient,
        uint256 amount,
        bool onL1,
        bool routed,
        uint256 expectedEpoch,
        uint256 requestedL1
    )
        internal
    {
        if (token != canonicalToken) revert InvalidAsset();
        if (amount == 0 || amount > PER_PAYMENT || amount > type(uint96).max) revert InvalidAmount();
        uint256 epoch = block.timestamp / PERIOD;
        if (expectedEpoch != epoch) revert StaleEpoch();
        if (spent[epoch] + amount > GLOBAL_LIMIT) revert GlobalLimit();
        if (bridge.canonicalBridgeAddress() != bridgeL1) revert InvalidConfiguration();
        address alias_ = aliasReaderL1Proxy.aliasOf(address(this), rollupId);
        if (
            recipient == address(0) || recipient == address(this) || recipient == alias_ || recipient == safeL1
                || recipient == safeL2 || recipient == address(bridge) || recipient == bridgeL1
        ) revert InvalidRecipient();
        uint256 fromL1;
        uint256 fromL2;
        if (requestedL1 != type(uint256).max) {
            fromL1 = requestedL1;
            fromL2 = amount - fromL1;
            if (fromL1 > _capacity(true, alias_, epoch) || fromL2 > _capacity(false, alias_, epoch)) revert Capacity();
        } else if (onL1) {
            uint256 cap = _capacity(true, alias_, epoch);
            fromL1 = amount < cap ? amount : cap;
            fromL2 = amount - fromL1;
            if (fromL2 > 0 && (!routed || fromL2 > _capacity(false, alias_, epoch))) revert Capacity();
        } else {
            uint256 cap = _capacity(false, alias_, epoch);
            fromL2 = amount < cap ? amount : cap;
            fromL1 = amount - fromL2;
            if (fromL1 > 0 && (!routed || fromL1 > _capacity(true, alias_, epoch))) revert Capacity();
        }
        spent[epoch] += amount;
        // Execute the L2 contribution first. Required failures propagate through
        // the Safe's zero-refund execution, including a later L1 lock failure.
        if (fromL2 > 0) {
            uint256 beforeBalance = IERC20(wrappedToken).balanceOf(address(this));
            allowanceL2.executeAllowanceTransfer(
                safeL2,
                wrappedToken,
                payable(onL1 ? address(this) : recipient),
                uint96(fromL2),
                address(0),
                0,
                address(this),
                ""
            );
            if (onL1) bridge.bridgeTokens(wrappedToken, fromL2, 0, recipient);
            if (IERC20(wrappedToken).balanceOf(address(this)) != beforeBalance) revert ResidualBalance();
        }
        if (fromL1 > 0) {
            uint256 beforeBalance = onL1 ? 0 : tokenL1Proxy.balanceOf(alias_);
            allowanceL1Proxy.executeAllowanceTransfer(
                safeL1, canonicalToken, payable(onL1 ? recipient : alias_), uint96(fromL1), address(0), 0, alias_, ""
            );
            if (!onL1) {
                // This call originates in the policy, so the approving L1 caller
                // is its funded alias. The bridge derives that same payer alias.
                if (!tokenL1Proxy.approve(bridgeL1, fromL1)) revert ApprovalFailed();
                bridge.bridgeFromL1(fromL1, recipient);
                if (tokenL1Proxy.balanceOf(alias_) != beforeBalance || tokenL1Proxy.allowance(alias_, bridgeL1) != 0) {
                    revert ResidualBalance();
                }
            }
        }
        emit Paid(canonicalToken, recipient, onL1, amount, fromL1, fromL2, epoch);
    }

    function _capacity(bool onL1, address alias_, uint256 epoch) private view returns (uint256) {
        uint256 remaining = _remaining(
            onL1 ? allowanceL1Proxy : allowanceL2,
            onL1 ? safeL1 : safeL2,
            onL1 ? alias_ : address(this),
            onL1 ? canonicalToken : wrappedToken,
            epoch
        );
        uint256 balance = onL1 ? tokenL1Proxy.balanceOf(safeL1) : IERC20(wrappedToken).balanceOf(safeL2);
        return balance < remaining ? balance : remaining;
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
        virtual
        returns (uint256)
    {
        uint256[5] memory a = module.getTokenAllowance(safe, delegate, token);
        // Refuse mismatched periods or L1/L2 timestamp epochs instead of combining
        // different windows. The owners sign expectedEpoch, so delayed approval
        // cannot silently spend against a later period's budget.
        if (a[2] != PERIOD / 60 || a[3] != epoch * (PERIOD / 60)) revert UnalignedAllowance();
        return a[1] < a[0] ? a[0] - a[1] : 0;
    }
}
