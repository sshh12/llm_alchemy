const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  const stats = {
    totalElements: await prisma.AlchemyElement.count(),
    totalRecipes: await prisma.AlchemyRecipe.count(),
  };
  return {
    statusCode: 200,
    body: JSON.stringify(stats),
  };
};
