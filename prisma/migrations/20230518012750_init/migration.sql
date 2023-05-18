-- CreateTable
CREATE TABLE "alchemy_table" (
    "id" INT8 NOT NULL DEFAULT unique_rowid(),
    "item_a" STRING NOT NULL,
    "item_b" STRING NOT NULL,
    "result" STRING NOT NULL,
    "result_img_url" STRING NOT NULL,

    CONSTRAINT "alchemy_table_pkey" PRIMARY KEY ("id")
);
