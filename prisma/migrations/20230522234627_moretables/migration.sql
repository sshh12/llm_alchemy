-- AlterTable
ALTER TABLE "AlchemyElement" ADD COLUMN     "createdUserId" STRING NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "AlchemyChallenge" (
    "id" INT8 NOT NULL DEFAULT unique_rowid(),
    "date" STRING NOT NULL,
    "elementId" INT8 NOT NULL,

    CONSTRAINT "AlchemyChallenge_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AlchemyChallenge" ADD CONSTRAINT "AlchemyChallenge_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "AlchemyElement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
