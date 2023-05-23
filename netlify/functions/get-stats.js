const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  const { userId, allElements } = event.queryStringParameters;
  const [totalElements, totalRecipes, recentElements, userCreatedElements] =
    await Promise.all([
      prisma.AlchemyElement.count(),
      prisma.AlchemyRecipe.count(),
      allElements
        ? await prisma.AlchemyElement.findMany({})
        : prisma.AlchemyElement.findMany({
            orderBy: {
              createdAt: "desc",
            },
            take: 10,
          }),
      prisma.AlchemyElement.count({ where: { createdUserId: userId } }),
    ]);
  const stats = {
    totalElements: totalElements,
    totalRecipes: totalRecipes,
    recentElementNames: recentElements.map((e) => e.name),
    userCreatedElements: userCreatedElements,
  };
  return {
    statusCode: 200,
    body: JSON.stringify(stats),
  };
};
