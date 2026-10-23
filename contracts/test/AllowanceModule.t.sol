// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {OwnerFixture} from "./helpers/OwnerFixture.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {IAllowanceModule} from "../src/interfaces/IAllowanceModule.sol";
import {ICrossChainProxy} from "eez-core-protocol/src/interfaces/ICrossChainProxy.sol";

contract AllowanceTestToken {
    mapping(address => uint256) public balanceOf;
    bool public failTransfers;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFailTransfers(bool value) external {
        failTransfers = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Test-only caller proving that official allowances accept a contract delegate.
///      TreasuryPolicy, with its authorization and shared counter, is a later milestone.
contract AllowanceTestDelegate {
    IAllowanceModule public immutable module;

    constructor(IAllowanceModule module_) {
        module = module_;
    }

    function pay(address safe, address token, address payable to, uint96 amount) external {
        module.executeAllowanceTransfer(safe, token, to, amount, address(0), 0, address(this), "");
    }
}

contract AllowanceModuleTest is OwnerFixture {
    IAllowanceModule private module;
    AllowanceTestDelegate private delegate;
    AllowanceTestToken private token;
    address payable private recipient = payable(address(0x1234));
    uint96 private constant UNIT = 1_000_000;

    function setUp() public override {
        super.setUp();
        module = IAllowanceModule(_deployLegacy("AllowanceModule"));
        delegate = new AllowanceTestDelegate(module);
        token = new AllowanceTestToken();
        token.mint(address(safeL2), 150 * UNIT);
        _callL2(address(safeL2), abi.encodeCall(ISafe.enableModule, (address(module))));
        _callL2(address(module), abi.encodeCall(IAllowanceModule.addDelegate, (address(delegate))));
        _callL2(
            address(module),
            abi.encodeCall(
                IAllowanceModule.setAllowance,
                (address(delegate), address(token), 100 * UNIT, 10, uint32(block.timestamp / 60))
            )
        );
    }

    function _pay(uint96 amount) private {
        _callL2(
            address(delegate),
            abi.encodeCall(AllowanceTestDelegate.pay, (address(safeL2), address(token), recipient, amount))
        );
    }

    function _allowance() private view returns (uint256[5] memory) {
        return module.getTokenAllowance(address(safeL2), address(delegate), address(token));
    }

    function testContractDelegateUsesOfficialModuleWithoutModulePower() public {
        _pay(40 * UNIT);
        assertEq(module.VERSION(), "1.0.0");
        assertTrue(safeL2.isModuleEnabled(address(module)));
        assertFalse(safeL2.isModuleEnabled(address(delegate)));
        assertEq(token.balanceOf(recipient), 40 * UNIT);
        assertEq(token.balanceOf(address(safeL2)), 110 * UNIT);
        uint256[5] memory allowance = _allowance();
        assertEq(allowance[0], 100 * UNIT);
        assertEq(allowance[1], 40 * UNIT);
        assertEq(allowance[4], 2);
    }

    function testEmptySignatureDoesNotLetAnotherCallerSpendAsDelegate() public {
        vm.expectRevert("expectedDelegate == signer && delegates[address(safe)][uint48(signer)].delegate == signer");
        module.executeAllowanceTransfer(
            address(safeL2), address(token), recipient, UNIT, address(0), 0, address(delegate), ""
        );
        uint256[5] memory allowance = _allowance();
        assertEq(allowance[1], 0);
        assertEq(allowance[4], 1);
        assertEq(token.balanceOf(recipient), 0);
    }

    function testPerSafeCeilingAndFailedTokenPreserveCountersAndSafeNonce() public {
        _pay(80 * UNIT);
        uint256 safeNonce = safeL2.nonce();
        bytes memory data =
            abi.encodeCall(AllowanceTestDelegate.pay, (address(safeL2), address(token), recipient, 30 * UNIT));
        bytes memory signatures =
            _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(delegate), data, 0)), A, B));
        vm.expectRevert("GS013");
        _execute(safeL2, address(delegate), data, 0, signatures);
        assertEq(safeL2.nonce(), safeNonce);
        token.setFailTransfers(true);
        data = abi.encodeCall(AllowanceTestDelegate.pay, (address(safeL2), address(token), recipient, UNIT));
        signatures = _outer(adapter, _signTwo(keccak256(_preimage(safeL2, address(delegate), data, 0)), A, B));
        vm.expectRevert("GS013");
        _execute(safeL2, address(delegate), data, 0, signatures);
        uint256[5] memory allowance = _allowance();
        assertEq(allowance[1], 80 * UNIT);
        assertEq(allowance[4], 2);
        assertEq(safeL2.nonce(), safeNonce);
        assertEq(token.balanceOf(recipient), 80 * UNIT);
    }

    function testEffectiveAllowanceResetsAtAlignedTenMinuteBoundary() public {
        _pay(100 * UNIT);
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 599);
        uint256[5] memory beforeReset = _allowance();
        assertEq(beforeReset[1], 100 * UNIT);
        vm.warp(start + 600);
        uint256[5] memory afterReset = _allowance();
        assertEq(afterReset[1], 0);
        assertEq(afterReset[3], (start + 600) / 60);
        assertEq(afterReset[4], beforeReset[4], "reset must not reset nonce");
        _pay(UNIT);
        assertEq(token.balanceOf(recipient), 101 * UNIT);
    }

    function testActualL1ProxyCanUseItsAllowanceAsCaller() public {
        address alias_ = l1.getOrCreateCrossChainProxy(address(delegate), ROLLUP_ID);
        _adminL1(abi.encodeCall(ISafe.enableModule, (address(module))));
        _configureL1(abi.encodeCall(IAllowanceModule.addDelegate, (alias_)));
        _configureL1(
            abi.encodeCall(
                IAllowanceModule.setAllowance, (alias_, address(token), 100 * UNIT, 10, uint32(block.timestamp / 60))
            )
        );
        token.mint(address(safeL1), 300 * UNIT);
        bytes memory transfer = abi.encodeCall(
            IAllowanceModule.executeAllowanceTransfer,
            (address(safeL1), address(token), recipient, 100 * UNIT, address(0), 0, alias_, bytes(""))
        );
        // The real proxy permits executeOnBehalf only to its manager. The test supplies
        // that trusted delivery; it does not simulate L1 posting or validate a proof.
        vm.prank(address(l1));
        (bool success, bytes memory result) =
            alias_.call(abi.encodeCall(ICrossChainProxy.executeOnBehalf, (address(module), 0, transfer)));
        assertTrue(success, string(result));
        assertEq(token.balanceOf(recipient), 100 * UNIT);
        assertEq(token.balanceOf(address(safeL1)), 200 * UNIT);
        assertFalse(safeL1.isModuleEnabled(alias_));
        uint256[5] memory allowance = module.getTokenAllowance(address(safeL1), alias_, address(token));
        assertEq(allowance[1], 100 * UNIT);
    }

    function testSharedModuleSeparatesEachSafeAllowance() public {
        _adminL1(abi.encodeCall(ISafe.enableModule, (address(module))));
        _configureL1(abi.encodeCall(IAllowanceModule.addDelegate, (address(delegate))));
        _configureL1(
            abi.encodeCall(
                IAllowanceModule.setAllowance,
                (address(delegate), address(token), 100 * UNIT, 10, uint32(block.timestamp / 60))
            )
        );
        token.mint(address(safeL1), 300 * UNIT);
        _pay(40 * UNIT);
        assertEq(module.getTokenAllowance(address(safeL1), address(delegate), address(token))[1], 0);
        delegate.pay(address(safeL1), address(token), recipient, 70 * UNIT);
        assertEq(module.getTokenAllowance(address(safeL1), address(delegate), address(token))[1], 70 * UNIT);
        assertEq(_allowance()[1], 40 * UNIT);
        assertEq(token.balanceOf(address(safeL1)), 230 * UNIT);
        assertEq(token.balanceOf(address(safeL2)), 110 * UNIT);
    }

    function testNewTreasuryDelegatePreservesExistingAllowance() public {
        _pay(40 * UNIT);
        uint256[5] memory previous = _allowance();
        AllowanceTestDelegate next = new AllowanceTestDelegate(module);
        _callL2(address(module), abi.encodeCall(IAllowanceModule.addDelegate, (address(next))));
        _callL2(
            address(module),
            abi.encodeCall(
                IAllowanceModule.setAllowance,
                (address(next), address(token), 100 * UNIT, 10, uint32(block.timestamp / 60))
            )
        );
        next.pay(address(safeL2), address(token), recipient, 25 * UNIT);
        assertEq(abi.encode(_allowance()), abi.encode(previous));
        assertEq(module.getTokenAllowance(address(safeL2), address(next), address(token))[1], 25 * UNIT);
        assertEq(token.balanceOf(address(safeL2)), 85 * UNIT);
        assertTrue(safeL2.isModuleEnabled(address(module)));
    }

    function _configureL1(bytes memory data) private {
        bytes memory signatures = _signTwo(keccak256(_preimage(safeL1, address(module), data, 0)), A, B);
        assertTrue(_execute(safeL1, address(module), data, 0, signatures));
    }
}
