const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  // const test = await prisma.alchemy_table.create({
  //   data: {
  //     item_a: "",
  //     item_b: "",
  //     result: "Stone",
  //     result_img_url: "https://i.imgur.com/PtElSx4.jpeg",
  //   },
  // });
  // await prisma.alchemy_table.deleteMany();
  const allElements = await prisma.alchemy_table.findMany();
  return {
    statusCode: 200,
    body: JSON.stringify(allElements, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
