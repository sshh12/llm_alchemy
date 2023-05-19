/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `AlchemyRecipe` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `name` to the `AlchemyRecipe` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AlchemyRecipe" ADD COLUMN     "name" STRING NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AlchemyRecipe_name_key" ON "AlchemyRecipe"("name");
