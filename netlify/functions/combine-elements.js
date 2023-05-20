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

Respond only with a single word which is the result item or thing. The results should be items or things. Use lower case unless it's a proper noun.

## Examples
* air + water = mist
* water + earth = mud
* fire + fire = energy
* earth + earth = land
* planet + planet = solar system
`;

async function getRecipe(recipeName) {
  return await prisma.AlchemyRecipe.findFirst({
    where: {
      name: recipeName,
    },
    include: {
      elements: {
        select: {
          element: true,
        },
      },
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
  if (!resultElement) {
    resultElement = await prisma.AlchemyElement.create({
      data: {
        name: elementName,
        imgUrl: "",
      },
    });
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
  return resultElement;
}

exports.handler = async (event, context) => {
  const { elementIdsCsv } = event.queryStringParameters;
  const elementIds = elementIdsCsv.split(",").map(BigInt).sort();
  const recipeName = "recipe:" + elementIds.join(",");
  const recipe = await getRecipe(recipeName);
  let resultElement;
  if (recipe) {
    resultElement = await prisma.AlchemyElement.findFirst({
      where: { id: recipe.resultElementId },
    });
  } else {
    resultElement = await buildRecipe(recipeName, elementIds);
  }
  return {
    statusCode: 200,
    body: JSON.stringify(resultElement, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
