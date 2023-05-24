const { PrismaClient } = require("@prisma/client");
const { Configuration, OpenAIApi } = require("openai");

const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
);
const prisma = new PrismaClient();

const ALCHEMY_SYSTEM_PROMPT = `
You are a powerful alchemist, I will give you two or more items and you will do your best to describe the outcome of combining them.

Respond ONLY with a single word which is the result item or thing. Do not respond with the formula or anything else.

## Rules
* The results should be items or things
* Use lower case unless it's a proper noun
* Avoid just prefixing "super" or "mega" unless it's a common prefix for the item
* Do not use underscores

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
* earth + water + fire = steamy mud
* human + airplane + solar system = space traveler
* animal + metal + fire = mechanical beast
`;

async function getRecipe(recipeName) {
  return await prisma.AlchemyRecipe.findFirst({
    where: {
      name: recipeName,
    },
  });
}

async function generateElement(elements) {
  let elementName = "";
  let temp = 0.1;
  for (let i = 0; i < 10; i++) {
    const llmResult = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      temperature: temp,
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
    elementName = llmResult.data.choices[0].message.content;
    elementName = elementName.toLowerCase();
    elementName = elementName.replace(/[^a-z'\- ]/g, "");
    if (
      elementName.length > 0 &&
      (elementName.match(/([\s]+)/g) || "").length < 3
    ) {
      return elementName;
    }
    temp = 0.8;
  }
  logging.error("Failed to generate element name", elements);
  throw new Error("Failed to generate element name");
}

async function buildRecipe(recipeName, elementIds, userId) {
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
  const elementName = await generateElement(elements);
  let resultElement = await prisma.AlchemyElement.findFirst({
    where: { name: elementName },
  });
  let isNewElement = false;
  if (!resultElement) {
    resultElement = await prisma.AlchemyElement.create({
      data: {
        name: elementName,
        imgUrl: "",
        createdUserId: userId,
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
  const { elementIdsCsv, userId } = event.queryStringParameters;
  const elementIds = elementIdsCsv.split(",").map(BigInt).sort();
  const recipeName = "recipe:" + elementIds.join(",");
  const recipe = await getRecipe(recipeName);
  let resultElement;
  let isNewElement = false;
  let resp;
  if (recipe) {
    resultElement = await prisma.AlchemyElement.findFirst({
      where: { id: recipe.resultElementId },
    });
    resp = {
      ...resultElement,
    };
  } else {
    const credits = await prisma.AlchemyCredits.findFirst({
      where: { userId: userId },
    });
    if (credits.credits <= 0) {
      resp = {
        error:
          "Sorry GPT is expensive! Not enough mixtures. Buy more to make more elements.",
        creditsLeft: 0,
      };
    } else {
      [resultElement, isNewElement] = await buildRecipe(
        recipeName,
        elementIds,
        userId
      );
      await prisma.AlchemyCredits.update({
        where: { id: credits.id },
        data: { credits: credits.credits - 1 },
      });
      resp = {
        ...resultElement,
        creditsLeft: credits.credits - 1,
      };
    }
  }
  resp.isNewElement = isNewElement;
  return {
    statusCode: 200,
    body: JSON.stringify(resp, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
