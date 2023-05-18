const { PrismaClient } = require("@prisma/client");
const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  const { itemA, itemB } = event.queryStringParameters;
  let element = await prisma.alchemy_table.findFirst({
    where: { item_a: itemA, item_b: itemB },
  });
  if (!element) {
    element = await prisma.alchemy_table.findFirst({
      where: { item_a: itemB, item_b: itemA },
    });
  }
  if (!element) {
    let result = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are a powerful alchemist, I will give you two items and you will do your best to describe the outcome of combining them. Respond only with a single word which is the result item or thing. The results should be items or things.",
        },
        {
          role: "user",
          content: `${itemA} + ${itemB}`,
        },
      ],
    });
    let newItem = result.data.choices[0].message.content;
    let imgResult = await openai.createImage({
      prompt: `a cartoon image of a ${newItem}, web icon`,
      n: 1,
      size: "1024x1024",
      response_format: "url",
    });
    element = await prisma.alchemy_table.create({
      data: {
        item_a: itemA,
        item_b: itemB,
        result: newItem,
        result_img_url: imgResult.data.data[0].url,
      },
    });
  }
  return {
    statusCode: 200,
    body: JSON.stringify(element, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
