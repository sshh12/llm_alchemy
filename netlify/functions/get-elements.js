const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  const { starterElements } = event.queryStringParameters;
  let options = {};
  if (starterElements) {
    options.where = { starterElement: true };
  }
  const allElements = await prisma.AlchemyElement.findMany(options);
  return {
    statusCode: 200,
    body: JSON.stringify(allElements, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};
