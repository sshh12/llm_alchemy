-- CreateTable
CREATE TABLE "AlchemyCredits" (
    "id" INT8 NOT NULL DEFAULT unique_rowid(),
    "userId" STRING NOT NULL,
    "credits" INT4 NOT NULL DEFAULT 0,
    "email" STRING NOT NULL,

    CONSTRAINT "AlchemyCredits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlchemyCredits_userId_key" ON "AlchemyCredits"("userId");
