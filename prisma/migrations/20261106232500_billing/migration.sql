-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "stripeProductId" TEXT;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "billingInterval" "BillingInterval",
ADD COLUMN     "compPlanId" TEXT,
ADD COLUMN     "lastEventAt" TIMESTAMP(3),
ADD COLUMN     "priceCents" INTEGER,
ADD COLUMN     "stripePriceId" TEXT;

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "providerPriceId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "interval" "BillingInterval" NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanPrice_providerPriceId_key" ON "PlanPrice"("providerPriceId");

-- CreateIndex
CREATE INDEX "PlanPrice_planId_isCurrent_idx" ON "PlanPrice"("planId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_stripeProductId_key" ON "Plan"("stripeProductId");

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_compPlanId_fkey" FOREIGN KEY ("compPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

