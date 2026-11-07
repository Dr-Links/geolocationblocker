-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "seriesId" TEXT;

-- AlterTable
ALTER TABLE "PostTarget" ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Post_seriesId_idx" ON "Post"("seriesId");

