const { PrismaClient } = require("@prisma/client");
const fs = require("fs").promises;

const prisma = new PrismaClient();

async function readJsonFile(filePath) {
  const data = await fs.readFile(filePath, "utf8");
  const json = JSON.parse(data);
  return json;
}

(async () => {
  const dump = await readJsonFile("./challenges.dump.json");
  // await prisma.alchemyDailyChallengeOnCredits.deleteMany({});
  // await prisma.alchemyDailyChallenge.deleteMany({});
  for (let row of dump) {
    const challenge = await prisma.alchemyDailyChallenge.upsert({
      where: { date: row.date },
      update: {},
      create: {
        date: row.date,
        elementEasy: { connect: { id: BigInt(row.easyId) } },
        elementHard: { connect: { id: BigInt(row.hardId) } },
        elementExpert: { connect: { id: BigInt(row.expertId) } },
      },
    });
    console.log(challenge);
  }
})();
