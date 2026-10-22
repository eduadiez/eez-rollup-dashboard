// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.7.6;

// Compile the unmodified dependencies with their original compiler family.
// The 0.8.34 tests deploy these artifacts through interfaces, not a port.
import {Safe} from "safe/Safe.sol";
import {SafeL2} from "safe/SafeL2.sol";
import {MultiSendCallOnly} from "safe/libraries/MultiSendCallOnly.sol";
import {SafeProxy} from "safe/proxies/SafeProxy.sol";
import {SafeProxyFactory} from "safe/proxies/SafeProxyFactory.sol";
import {AllowanceModule} from "safe-allowances/AllowanceModule.sol";
