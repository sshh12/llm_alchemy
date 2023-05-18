import { Handler } from "@netlify/functions";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const handler = async (_event, _context) => {
  // load all players from the database
  const allPlayers = await prisma.players.findMany();
  return {
    statusCode: 200,
    body: JSON.stringify(allPlayers, (_key, value) =>
      // need to add a custom serializer because CockroachDB IDs map to
      // JavaScript BigInts, which JSON.stringify has trouble serializing.
      typeof value === "bigint" ? value.toString() : value
    ),
  };
};

export { handler };
