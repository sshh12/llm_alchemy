const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  if (!process.env.ENABLE_RESET) {
    return {
      statusCode: 403,
      body: "Reset is disabled",
    };
  }
  await prisma.AlchemyRecipesForElements.deleteMany();
  await prisma.AlchemyRecipe.deleteMany();
  await prisma.AlchemyElement.deleteMany();
  await prisma.AlchemyElement.create({
    data: {
      name: "earth",
      imgUrl: "https://i.imgur.com/MVQZAIH.jpeg",
      starterElement: true,
    },
  });
  await prisma.AlchemyElement.create({
    data: {
      name: "water",
      imgUrl: "https://i.imgur.com/81nYTcv.jpeg",
      starterElement: true,
    },
  });
  await prisma.AlchemyElement.create({
    data: {
      name: "air",
      imgUrl: "https://i.imgur.com/Zh8QGKm.jpeg",
      starterElement: true,
    },
  });
  await prisma.AlchemyElement.create({
    data: {
      name: "fire",
      imgUrl: "https://i.imgur.com/solE9oh.jpeg",
      starterElement: true,
    },
  });
  await prisma.AlchemyElement.create({
    data: {
      name: "time",
      imgUrl: "https://i.imgur.com/dJyZadY.jpeg",
      starterElement: true,
    },
  });
  return {
    statusCode: 200,
    body: "",
  };
};
