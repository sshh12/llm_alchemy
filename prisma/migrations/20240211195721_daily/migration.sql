/*
  Warnings:

  - You are about to drop the `AlchemyChallenge` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AlchemyChallenge" DROP CONSTRAINT "AlchemyChallenge_elementId_fkey";

-- DropTable
DROP TABLE "AlchemyChallenge";

-- CreateTable
CREATE TABLE "AlchemyDailyChallenge" (
    "id" INT8 NOT NULL DEFAULT unique_rowid(),
    "date" STRING NOT NULL,
    "elementEasyId" INT8 NOT NULL,
    "elementHardId" INT8 NOT NULL,
    "elementExpertId" INT8 NOT NULL,

    CONSTRAINT "AlchemyDailyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlchemyDailyChallengeOnCredits" (
    "id" INT8 NOT NULL DEFAULT unique_rowid(),
    "completedEasy" BOOL NOT NULL DEFAULT false,
    "completedHard" BOOL NOT NULL DEFAULT false,
    "completedExpert" BOOL NOT NULL DEFAULT false,
    "challengeId" INT8 NOT NULL,
    "creditsId" INT8 NOT NULL,

    CONSTRAINT "AlchemyDailyChallengeOnCredits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlchemyDailyChallenge_date_key" ON "AlchemyDailyChallenge"("date");

-- AddForeignKey
ALTER TABLE "AlchemyDailyChallenge" ADD CONSTRAINT "AlchemyDailyChallenge_elementEasyId_fkey" FOREIGN KEY ("elementEasyId") REFERENCES "AlchemyElement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlchemyDailyChallenge" ADD CONSTRAINT "AlchemyDailyChallenge_elementHardId_fkey" FOREIGN KEY ("elementHardId") REFERENCES "AlchemyElement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlchemyDailyChallenge" ADD CONSTRAINT "AlchemyDailyChallenge_elementExpertId_fkey" FOREIGN KEY ("elementExpertId") REFERENCES "AlchemyElement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlchemyDailyChallengeOnCredits" ADD CONSTRAINT "AlchemyDailyChallengeOnCredits_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "AlchemyDailyChallenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlchemyDailyChallengeOnCredits" ADD CONSTRAINT "AlchemyDailyChallengeOnCredits_creditsId_fkey" FOREIGN KEY ("creditsId") REFERENCES "AlchemyCredits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
