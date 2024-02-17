const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

(async () => {
  const completedEasy = await prisma.alchemyDailyChallengeOnCredits.count({
    where: { completedEasy: true },
  });
  const completedHard = await prisma.alchemyDailyChallengeOnCredits.count({
    where: { completedHard: true },
  });
  const completedExpert = await prisma.alchemyDailyChallengeOnCredits.count({
    where: { completedExpert: true },
  });
  console.log(
    JSON.stringify({
      completedEasy,
      completedHard,
      completedExpert,
    })
  );
})();
