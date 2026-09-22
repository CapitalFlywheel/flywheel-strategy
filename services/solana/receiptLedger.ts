import { allocateCreatorFees, assertConserved } from "./feeAllocation";

export interface CreatorFeeReceipt {
  signature: string;
  instructionIndex: number;
  slot: number;
  blockhash: string;
  phase: "pump-curve" | "pumpswap";
  creator: string;
  rawMstrx: bigint;
}

export interface ReceiptAllocation extends CreatorFeeReceipt {
  receiptId: string;
  holderRawMstrx: bigint;
  reserveRawMstrx: bigint;
}

export class ReceiptLedger {
  private readonly allocations = new Map<string, ReceiptAllocation>();

  record(receipt: CreatorFeeReceipt) {
    if (receipt.rawMstrx <= 0n) throw new Error("RECEIPT_EMPTY");
    if (!Number.isInteger(receipt.instructionIndex) || receipt.instructionIndex < 0) throw new Error("RECEIPT_INDEX_INVALID");
    const receiptId = `${receipt.signature}:${receipt.instructionIndex}`;
    const existing = this.allocations.get(receiptId);
    if (existing) {
      if (existing.slot !== receipt.slot || existing.blockhash !== receipt.blockhash || existing.rawMstrx !== receipt.rawMstrx) throw new Error("RECEIPT_CONFLICT");
      return existing;
    }
    const allocation = allocateCreatorFees(receipt.rawMstrx);
    assertConserved(allocation);
    const recorded = { ...receipt, receiptId, holderRawMstrx: allocation.holderRawMstrx, reserveRawMstrx: allocation.reserveRawMstrx };
    this.allocations.set(receiptId, recorded);
    return recorded;
  }

  totals() {
    return [...this.allocations.values()].reduce((totals, row) => ({
      receivedRawMstrx: totals.receivedRawMstrx + row.rawMstrx,
      holderRawMstrx: totals.holderRawMstrx + row.holderRawMstrx,
      reserveRawMstrx: totals.reserveRawMstrx + row.reserveRawMstrx,
    }), { receivedRawMstrx: 0n, holderRawMstrx: 0n, reserveRawMstrx: 0n });
  }
}
