-- AlterTable
ALTER TABLE "GenerationRequest" ADD COLUMN     "attemptLog" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "ProviderCredential" ADD COLUMN     "last4" TEXT;

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

