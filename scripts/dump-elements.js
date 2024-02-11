const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

(async () => {
  const elements = await prisma.alchemyElement.findMany({});
  const recipes = await prisma.alchemyRecipe.findMany({});
  for (const element of elements) {
    console.log(
      JSON.stringify(element, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    );
  }
  for (const recipe of recipes) {
    console.log(
      JSON.stringify(recipe, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    );
  }
})();
