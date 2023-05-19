/*
  Warnings:

  - You are about to drop the `alchemy_table` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "alchemy_table";

-- CreateTable
CREATE TABLE "AlchemyElement" (
    "id" INT8 NOT NULL DEFAULT unique_rowid(),
    "name" STRING NOT NULL,
    "imgUrl" STRING NOT NULL,
    "starterElement" BOOL NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlchemyElement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlchemyRecipe" (
    "id" INT8 NOT NULL DEFAULT unique_rowid(),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlchemyRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlchemyRecipesForElements" (
    "elementId" INT8 NOT NULL,
    "recipeId" INT8 NOT NULL,

    CONSTRAINT "AlchemyRecipesForElements_pkey" PRIMARY KEY ("elementId","recipeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlchemyElement_name_key" ON "AlchemyElement"("name");

-- AddForeignKey
ALTER TABLE "AlchemyRecipesForElements" ADD CONSTRAINT "AlchemyRecipesForElements_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "AlchemyElement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlchemyRecipesForElements" ADD CONSTRAINT "AlchemyRecipesForElements_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "AlchemyRecipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
