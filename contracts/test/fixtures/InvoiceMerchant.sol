// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice WARNING: Unaudited demo contract. Not ready for production use.
/// Controlled invoice fixture for the isolated treasury demonstration.
/// @dev Closing an invoice is a separate committed transaction. Acceptance is a
///      required final leg of the payment and authenticates the policy's L1 alias.
contract InvoiceMerchant {
    enum Status {
        Missing,
        Open,
        Paid,
        Closed
    }

    struct Invoice {
        address recipient;
        uint256 amount;
        Status status;
    }
    address public immutable controller;
    address public immutable token;
    address public policyAlias;
    mapping(bytes32 id => Invoice) public invoices;

    error Unauthorized();
    error InvalidInvoice();
    error InvoiceNotOpen(bytes32 id);
    error TermsMismatch();
    event InvoiceOpened(bytes32 indexed id, address recipient, uint256 amount);
    event InvoiceClosed(bytes32 indexed id);
    event InvoiceAccepted(bytes32 indexed id);

    constructor(address token_) {
        if (token_.code.length == 0) revert InvalidInvoice();
        token = token_;
        controller = msg.sender;
    }

    function bindPolicy(address alias_) external {
        if (msg.sender != controller || policyAlias != address(0)) revert Unauthorized();
        if (alias_.code.length == 0) revert InvalidInvoice();
        policyAlias = alias_;
    }

    function open(bytes32 id, address recipient, uint256 amount) external {
        if (msg.sender != controller) revert Unauthorized();
        if (id == bytes32(0) || recipient == address(0) || amount == 0 || invoices[id].status != Status.Missing) {
            revert InvalidInvoice();
        }
        invoices[id] = Invoice(recipient, amount, Status.Open);
        emit InvoiceOpened(id, recipient, amount);
    }

    function close(bytes32 id) external {
        if (msg.sender != controller) revert Unauthorized();
        if (invoices[id].status != Status.Open) revert InvoiceNotOpen(id);
        invoices[id].status = Status.Closed;
        emit InvoiceClosed(id);
    }

    function accept(bytes32 id, address asset, address recipient, uint256 amount) external {
        if (msg.sender != policyAlias) revert Unauthorized();
        Invoice storage invoice = invoices[id];
        if (invoice.status != Status.Open) revert InvoiceNotOpen(id);
        if (asset != token || invoice.recipient != recipient || invoice.amount != amount) revert TermsMismatch();
        invoice.status = Status.Paid;
        emit InvoiceAccepted(id);
    }
}
