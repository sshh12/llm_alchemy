const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

exports.handler = async (event, context) => {
  const { userId, allElements, date } = event.queryStringParameters;
  if (!userId) {
    return {
      statusCode: 200,
      body: JSON.stringify({}),
    };
  }
  const [
    totalElements,
    totalRecipes,
    recentElements,
    userCreatedElements,
    challenge,
    credits,
  ] = await Promise.all([
    prisma.AlchemyElement.count(),
    prisma.AlchemyRecipe.count(),
    allElements
      ? await prisma.AlchemyElement.findMany({})
      : prisma.AlchemyElement.findMany({
          orderBy: {
            createdAt: "desc",
          },
          take: 10,
        }),
    prisma.AlchemyElement.findMany({ where: { createdUserId: userId } }),
    prisma.alchemyDailyChallenge.findFirst({
      where: { date: date },
      include: {
        elementEasy: true,
        elementHard: true,
        elementExpert: true,
      },
    }),
    prisma.AlchemyCredits.upsert({
      where: { userId: userId },
      update: {},
      create: { userId: userId, credits: 0, email: "" },
    }),
  ]);
  const challengeHistory = await prisma.alchemyDailyChallengeOnCredits.findMany(
    {
      where: { credits: { id: credits.id } },
      include: {
        challenge: {
          include: {
            elementEasy: true,
            elementHard: true,
            elementExpert: true,
          },
        },
      },
    }
  );
  if (!challengeHistory.find((c) => c.challengeId === challenge.id)) {
    await prisma.alchemyDailyChallengeOnCredits.create({
      data: {
        challenge: { connect: { id: challenge.id } },
        credits: { connect: { id: credits.id } },
      },
    });
  }
  const stats = {
    totalElements: totalElements,
    totalRecipes: totalRecipes,
    recentElementNames: recentElements.map((e) => e.name),
    userCreatedElements: userCreatedElements.map((e) => e.name),
    credits: credits.credits,
  };
  if (challenge) {
    stats.dailyChallenge = {
      date: challenge.date,
      elementEasy: challenge.elementEasy.name,
      elementEasyImgUrl: challenge.elementEasy.imgUrl,
      elementHard: challenge.elementHard.name,
      elementHardImgUrl: challenge.elementHard.imgUrl,
      elementExpert: challenge.elementExpert.name,
      elementExpertImgUrl: challenge.elementExpert.imgUrl,
    };
    stats.dailyChallengeHistory = challengeHistory.map((dc) => ({
      date: dc.challenge.date,
      elementEasy: dc.challenge.elementEasy.name,
      elementHard: dc.challenge.elementHard.name,
      elementExpert: dc.challenge.elementExpert.name,
      completedEasy: dc.completedEasy,
      completedHard: dc.completedHard,
      completedExpert: dc.completedExpert,
    }));
  }
  return {
    statusCode: 200,
    body: JSON.stringify(stats),
  };
};
