const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function validateElement(element) {
  let elementName = element.name;
  elementName = elementName.toLowerCase();
  elementName = elementName.replace(/[^a-z0-9'\- ]/g, "");
  return (
    elementName.length > 0 &&
    (elementName.match(/([\s]+)/g) || "").length < 3 &&
    elementName === element.name
  );
}

async function purgeElements(invalidElements) {
  const elementIds = invalidElements.map((element) => element.id);
  await prisma.alchemyRecipesForElements.deleteMany({
    where: {
      elementId: { in: elementIds },
    },
  });
  await prisma.alchemyElement.deleteMany({
    where: {
      id: { in: elementIds },
    },
  });
}

async function purgeInvalidRecipies() {
  const elements = await prisma.alchemyElement.findMany({
    select: {
      id: true,
    },
  });
  const elementIds = elements.map((element) => element.id);
  const recipes = await prisma.alchemyRecipe.findMany({
    include: {
      elements: true,
    },
  });
  const invalidRecipes = recipes.filter(
    (recipe) =>
      !elementIds.includes(recipe.resultElementId) || elements.length === 0
  );
  await prisma.alchemyRecipesForElements.deleteMany({
    where: {
      recipeId: { in: invalidRecipes.map((recipe) => recipe.id) },
    },
  });
  await prisma.alchemyRecipe.deleteMany({
    where: {
      id: { in: invalidRecipes.map((recipe) => recipe.id) },
    },
  });
}

async function purgeElementsWithNoRecipes() {
  const recipes = await prisma.alchemyRecipe.findMany({
    select: {
      id: true,
      resultElementId: true,
    },
  });
  const elements = await prisma.alchemyElement.findMany({
    where: {
      id: { notIn: recipes.map((recipe) => recipe.resultElementId) },
      starterElement: false,
    },
  });
  await purgeElements(elements);
}

exports.handler = async (event, context) => {
  const { starterElements, purgeInvalid } = event.queryStringParameters;
  let options = {};
  if (starterElements) {
    options.where = { starterElement: true };
  }
  const allElements = await prisma.AlchemyElement.findMany(options);
  if (purgeInvalid) {
    await purgeElements(allElements.filter((e) => !validateElement(e)));
    await purgeInvalidRecipies();
    await purgeElementsWithNoRecipes();
  }
  const resp = allElements.map((e) => ({ ...e, valid: validateElement(e) }));
  return {
    statusCode: 200,
    body: JSON.stringify(resp, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
