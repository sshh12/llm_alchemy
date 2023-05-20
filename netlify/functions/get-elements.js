const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  // await prisma.AlchemyRecipesForElements.deleteMany();
  // await prisma.AlchemyRecipe.deleteMany();
  // await prisma.AlchemyElement.deleteMany();
  // await prisma.AlchemyElement.create({
  //   data: {
  //     name: "earth",
  //     imgUrl: "https://i.imgur.com/MVQZAIH.jpeg",
  //     starterElement: true,
  //   },
  // });
  // await prisma.AlchemyElement.create({
  //   data: {
  //     name: "water",
  //     imgUrl: "https://i.imgur.com/f97Y4iT.jpeg",
  //     starterElement: true,
  //   },
  // });
  // await prisma.AlchemyElement.create({
  //   data: {
  //     name: "air",
  //     imgUrl: "https://i.imgur.com/Zh8QGKm.jpeg",
  //     starterElement: true,
  //   },
  // });
  // await prisma.AlchemyElement.create({
  //   data: {
  //     name: "fire",
  //     imgUrl: "https://i.imgur.com/solE9oh.jpeg",
  //     starterElement: true,
  //   },
  // });
  // await prisma.AlchemyElement.create({
  //   data: {
  //     name: "time",
  //     imgUrl: "https://i.imgur.com/dJyZadY.jpeg",
  //     starterElement: true,
  //   },
  // });

  const { starterElements } = event.queryStringParameters;
  let options = {};
  if (starterElements) {
    options.where = { starterElement: true };
  }
  const allElements = await prisma.AlchemyElement.findMany(options);
  return {
    statusCode: 200,
    body: JSON.stringify(allElements, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
