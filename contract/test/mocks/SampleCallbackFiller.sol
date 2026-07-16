// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { PartialFillFillerBase } from "../../src/PartialFillFillerBase.sol";

/// Minimal concrete filler contract a filler operator would actually deploy:
/// PartialFillFillerBase already provides everything needed (caller auth,
/// target allowlist, the doRegister/doFill wrappers), so a filler with no
/// extra bookkeeping needs zero overrides — this file exists purely so tests
/// have something deployable and named.
contract SampleCallbackFiller is PartialFillFillerBase {
    constructor(address _reactor) PartialFillFillerBase(_reactor) {}
}
