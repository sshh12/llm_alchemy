const { PrismaClient } = require("@prisma/client");
const { Configuration, OpenAIApi } = require("openai");
const request = require("request");

const prisma = new PrismaClient();
const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
);

function uploadImage(imageURL) {
  const options = {
    url: "https://api.imgur.com/3/upload",
    headers: {
      Authorization: "Client-ID " + process.env.IMGUR_CLIENT_ID,
    },
  };
  return new Promise((resolve, reject) => {
    const post = request.post(options, function (err, req, body) {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    const upload = post.form();
    upload.append("image", imageURL);
    upload.append("type", "url");
  });
}

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
    const imgurResult = await uploadImage(imgURL);
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
