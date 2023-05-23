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

async function deleteElementById(elementId) {
  try {
    const element = await prisma.alchemyElement.findUnique({
      where: {
        id: elementId,
      },
      include: {
        recipes: true,
        challenges: true,
      },
    });
    for (let recipe of element.recipes) {
      await prisma.alchemyRecipesForElements.deleteMany({
        where: {
          elementId: element.id,
          recipeId: recipe.recipeId,
        },
      });
    }
    for (let recipe of element.recipes) {
      await prisma.alchemyRecipe.delete({
        where: {
          id: recipe.recipeId,
        },
      });
    }
    for (let challenge of element.challenges) {
      await prisma.alchemyChallenge.delete({
        where: {
          id: challenge.id,
        },
      });
    }
    await prisma.alchemyElement.delete({
      where: {
        id: elementId,
      },
    });
    console.log(`Element with id ${elementId} and its recipes deleted.`);
  } catch (err) {
    console.error(`Error deleting element with id ${elementId}:`, err);
  }
}

exports.handler = async (event, context) => {
  const { starterElements, purgeInvalid } = event.queryStringParameters;
  let options = {};
  if (starterElements) {
    options.where = { starterElement: true };
  }
  const allElements = await prisma.AlchemyElement.findMany(options);
  const invalidElements = allElements.filter((e) => !validateElement(e));
  if (purgeInvalid) {
    for (let e of invalidElements) {
      console.log("deleting", e);
      try {
        await deleteElementById(e.id);
      } catch (e) {
        await deleteElementById(e.id);
      }
    }
  }
  const resp = allElements.map((e) => ({ ...e, valid: validateElement(e) }));
  return {
    statusCode: 200,
    body: JSON.stringify(resp, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
