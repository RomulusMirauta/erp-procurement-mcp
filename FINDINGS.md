# Findings

Bugs found in this project, how they were found and how they were fixed.

## 2026-11-18: code review of v0.1.0

An independent review found the issues below. All were reproduced with a script before fixing, and each one now has a test.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | A duplicate invoice dated **before** the paid original came back `matched`, so it could be paid twice. It also made the paid original show as a duplicate. "Earlier" was decided by invoice date only. | Approved and paid invoices now always come before pending ones (`comesBefore` in `repository.ts`). Invoice date only orders invoices within each group. |
| 2 | High | Pending invoices, including ones that had failed matching (wrong supplier, duplicate), used up received quantity. A correct invoice then failed with `QUANTITY_NOT_RECEIVED`. | Only approved and paid invoices use up quantity. |
| 3 | High | The same PO line on two lines of one invoice was checked one line at a time, so billing 30 + 30 against 30 received passed. | Quantities are added up per PO line across the invoice. |
| 4 | Medium | A free-of-charge PO line (price 0) divided by zero: "differs by Infinity%". | The price check compares in integers (basis points), and the message names the free-of-charge case. |
| 5 | Medium | Floating-point error at the tolerance boundary: 100 → 107 at a 7% tolerance was flagged. | Same integer comparison as #4. |
| 6 | Medium | Nothing compared the billed quantity with the **ordered** quantity, so an over-delivery could be billed in full. | New exception, `QUANTITY_EXCEEDS_PO`. |
| 7 | Medium | The price tolerance was a `match_invoice` argument, so the agent could loosen the check it was running. `match_invoice` and `request_approval` could also disagree. | The tolerance is now server configuration (`ERP_PRICE_TOLERANCE_PCT`), and both tools use it. |
| 8 | Low | `request_approval` accepted invoices that were already paid, approved or rejected. | Only `received` and `on_hold` invoices are accepted. |

Known limitation, documented in the README rather than fixed: approval idempotency holds within one server process, because the store is in memory.
