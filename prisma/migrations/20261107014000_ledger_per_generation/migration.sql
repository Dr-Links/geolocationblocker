
-- DropIndex
DROP INDEX "CreditLedgerEntry_generationRequestId_key";

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_generationRequestId_idx" ON "CreditLedgerEntry"("generationRequestId");
