const { PrismaClient } = require("@prisma/client");
const { Configuration, OpenAIApi } = require("openai");
const { ImgurClient } = require("imgur");

const prisma = new PrismaClient();
const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
);
const imgur = new ImgurClient({ clientId: process.env.IMGUR_CLIENT_ID });

exports.handler = async (event, context) => {
  const { id, skipRender } = event.queryStringParameters;
  let element = await prisma.AlchemyElement.findFirst({
    where: { id: BigInt(id) },
  });
  if (!element.imgUrl && !skipRender) {
    const imgResult = await openai.createImage({
      prompt: `image of ${element.name}, white background`,
      n: 1,
      size: "256x256",
      response_format: "url",
    });
    const imgURL = imgResult.data.data[0].url;
    const imgurResult = await imgur.upload({
      image: imgURL,
      title: element.name,
    });
    element = await prisma.AlchemyElement.update({
      where: {
        id: element.id,
      },
      data: {
        imgUrl: imgurResult.data.link,
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
