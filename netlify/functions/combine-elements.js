const { PrismaClient } = require("@prisma/client");
const { Configuration, OpenAIApi } = require("openai");

const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
);
const prisma = new PrismaClient();

const ALCHEMY_SYSTEM_PROMPT = `
You are a powerful alchemist, I will give you two items and you will do your best to describe the outcome of combining them.

Respond only with a single word which is the result item or thing.

## Rules
* The results should be items or things
* Use lower case unless it's a proper noun
* Avoid just prefixing "super" or "mega" unless it's a common prefix for the item

## Examples
* air + water = mist
* water + earth = mud
* fire + fire = energy
* earth + earth = land
* planet + planet = solar system
* earth + life = human
* electricity + primordial soup = life
* life + land = animal
* life + death = organic matter
* bird + metal = airplane
* fire + stone = metal
`;

async function getRecipe(recipeName) {
  return await prisma.AlchemyRecipe.findFirst({
    where: {
      name: recipeName,
    },
  });
}

async function buildRecipe(recipeName, elementIds) {
  const elementResult = await prisma.AlchemyElement.findMany({
    where: {
      id: {
        in: elementIds,
      },
    },
  });
  const elements = elementIds.map((id) =>
    elementResult.find((elr) => elr.id === id)
  );
  const llmResult = await openai.createChatCompletion({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: ALCHEMY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: elements.map((e) => e.name).join(" + "),
      },
    ],
  });
  const elementName = llmResult.data.choices[0].message.content;
  let resultElement = await prisma.AlchemyElement.findFirst({
    where: { name: elementName },
  });
  let isNewElement = false;
  if (!resultElement) {
    resultElement = await prisma.AlchemyElement.create({
      data: {
        name: elementName,
        imgUrl: "",
      },
    });
    isNewElement = true;
  }
  await prisma.AlchemyRecipe.create({
    data: {
      name: recipeName,
      resultElementId: resultElement.id,
      elements: {
        create: [...new Set(elementIds)].map((id) => ({ elementId: id })),
      },
    },
  });
  return [resultElement, isNewElement];
}

exports.handler = async (event, context) => {
  const { elementIdsCsv } = event.queryStringParameters;
  const elementIds = elementIdsCsv.split(",").map(BigInt).sort();
  const recipeName = "recipe:" + elementIds.join(",");
  const recipe = await getRecipe(recipeName);
  let resultElement;
  let isNewElement = false;
  if (recipe) {
    resultElement = await prisma.AlchemyElement.findFirst({
      where: { id: recipe.resultElementId },
    });
  } else {
    [resultElement, isNewElement] = await buildRecipe(recipeName, elementIds);
  }
  return {
    statusCode: 200,
    body: JSON.stringify(
      { ...resultElement, isNewElement: isNewElement },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    ),
  };
};
