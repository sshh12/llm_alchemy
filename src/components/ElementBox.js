import React, { useState, useEffect, useRef } from "react";
import Element from "./Element";
import { isTouchCapable, enableScroll, disableScroll } from "../lib/touch";
import { useGetFetch } from "../lib/api";
import { findIntersections, averagePosition } from "../lib/coords";
import Swal from "sweetalert2";
import withReactContent from "sweetalert2-react-content";
import {
  Stat,
  StatLabel,
  StatNumber,
  HStack,
  InputGroup,
  InputRightElement,
  Input,
  Box,
  Button,
  Flex,
  Spacer,
  StatHelpText,
  Text,
  VStack,
} from "@chakra-ui/react";
import { SearchIcon, ExternalLinkIcon } from "@chakra-ui/icons";

const swal = withReactContent(Swal);

function ChallengeSection({ stats, showChallengeInfo }) {
  let completedCount = 0;
  if (stats?.dailyChallengeHistory) {
    completedCount = stats.dailyChallengeHistory.reduce(
      (acc, v) => acc + (v.completedEasy + v.completedHard + v.completedExpert),
      0
    );
  }
  return (
    <VStack p={2}>
      <HStack align="center" justifyContent={"space-around"}>
        <Text color="green.700">
          <b>{stats?.dailyChallenge.elementEasy}</b>
        </Text>
        <Spacer />
        <Text color="orange.600">
          <b>{stats?.dailyChallenge.elementHard}</b>
        </Text>
        <Spacer />
        <Text color="red.700">
          <b>{stats?.dailyChallenge.elementExpert}</b>
        </Text>
        <Spacer />
      </HStack>
      <Button size="xs" colorScheme="blue" onClick={() => showChallengeInfo()}>
        Completed Challenges {completedCount}
      </Button>
    </VStack>
  );
}

function ElementBox({
  starterElements,
  updateStarterElements,
  resetStarterElements,
  stats,
  userId,
  pollStats,
  elementW,
  elementH,
}) {
  const idCnt = useRef(0);
  const dragId = useRef(null);
  const [elements, setElements] = useState([]);
  const [fetchAPI] = useGetFetch();
  const [search, setSearch] = useState("");
  const [credits, setCredits] = useState(stats?.credits);

  useEffect(() => {
    setCredits(stats?.credits || 0);
  }, [stats]);

  const maxElementY = elements.reduce((acc, el) => Math.max(acc, el.y), 0);

  useEffect(() => {
    const onMove = ({ x, y }) => {
      setElements((state) => {
        if (dragId.current === null) return state;
        const dragElement = state.find((el) => el.id === dragId.current);
        state = state
          .filter((element) => element.id !== dragId.current)
          .concat(Object.assign(dragElement, { x, y }));
        const intersections = findIntersections(state, dragId.current);
        state = state.map((element) => {
          if (intersections.includes(element.id)) {
            element.hoverEffect = true;
          } else {
            element.hoverEffect = false;
          }
          return element;
        });
        return state;
      });
    };

    const onTouch = (e) => {
      if (dragId.current === null) return;
      e.preventDefault();
      const touch = e.targetTouches[0];
      onMove({ x: touch.pageX, y: touch.pageY });
    };

    const onMouse = (e) => {
      if (dragId.current === null) return;
      e.preventDefault();
      onMove({ x: e.pageX, y: e.pageY });
    };

    if (isTouchCapable) {
      window.addEventListener("touchmove", onTouch, { passive: false });
    } else {
      window.addEventListener("mousemove", onMouse);
    }

    return () => {
      if (isTouchCapable) {
        window.removeEventListener("touchmove", onTouch);
      } else {
        window.removeEventListener("mousemove", onMouse);
      }
    };
  }, [dragId]);

  const onDragStart = (element, e) => {
    e.preventDefault();
    disableScroll();
    dragId.current = element.id;
  };

  const onDragStop = (e) => {
    if (dragId.current === null) return;
    e.preventDefault();
    enableScroll();
    const otherIds = findIntersections(elements, dragId.current);
    const stopDragId = dragId.current;
    dragId.current = null;
    if (otherIds.length === 0) return;
    window.gtag("event", "element_combined", {
      numElements: otherIds.length + 1,
    });
    setElements(
      ((state) => {
        const targetElement = state.find((e) => e.id === stopDragId);
        if (!targetElement) {
          return state;
        }
        state = state.filter(
          (e) => e.id !== stopDragId && !otherIds.includes(e.id)
        );
        const otherElements = otherIds.map((id) =>
          elements.find((e) => e.id === id)
        );
        const newPos = averagePosition(otherElements.concat([targetElement]));
        const newElement = Object.assign({}, targetElement, {
          id: (idCnt.current++).toString(),
          element: null,
          imgUrl: null,
          x: newPos.x,
          y: newPos.y,
          name: "unknown",
        });
        const date = new Date().toISOString().slice(0, 10);
        fetchAPI(
          `/combine-elements?userId=${userId}&date=${date}&elementIdsCsv=${[
            targetElement.element.id,
          ]
            .concat(otherElements.map((e) => e.element.id))
            .join(",")}`
        ).then((v) => {
          if (v.errorMessage) {
            alert(
              "Failed to combine elements! It's possible this is a big or this project is out of OpenAI credits. Refresh and try again."
            );
            return;
          } else if (v.error) {
            alert(v.error);
            setCredits(v.creditsLeft);
            return;
          } else if (v.isNewElement) {
            swal.fire({
              title: `${v.name}`,
              text: `Congrats! You are the first person to discover ${v.name}.`,
              html: null,
            });
            window.gtag("event", "element_new", {
              element: v.name,
            });
            pollStats();
          } else if (v.challengeCredits > 0) {
            showChallengeComplete(v.challengeCredits);
            window.gtag("event", "challenge_complete", {
              element: v.name,
            });
            pollStats();
          }
          if (v.creditsLeft) {
            setCredits(v.creditsLeft);
          }
          setElement(newElement.id, v);
          if (!v.imgUrl) {
            let imgInterval;
            const checkImg = () => {
              fetchAPI(`/get-element?id=${v.id}`)
                .then((updatedValue) => {
                  if (updatedValue.imgUrl) {
                    setElement(newElement.id, updatedValue);
                    clearInterval(imgInterval);
                  }
                })
                .catch(console.error);
            };
            checkImg();
            imgInterval = setInterval(checkImg, 10000);
          }
        });
        state = state.concat([newElement]);
        return state;
      })(elements)
    );
  };

  const onFactoryDragStart = (baseElement, e) => {
    e.preventDefault();
    disableScroll();
    setElements(
      ((state) => {
        const newId = (idCnt.current++).toString();
        const newElement = Object.assign(
          {
            x: e.pageX,
            y: e.pageY,
            w: elementW,
            h: elementH,
            hoverEffect: false,
            element: baseElement,
            imgUrl: baseElement.imgUrl,
            name: baseElement.name,
          },
          {
            id: newId,
          }
        );
        dragId.current = newId;
        state = state.concat([newElement]);
        return state;
      })(elements)
    );
  };

  const setElement = (id, element) => {
    setElements((state) => {
      const targetElement = state.find((e) => e.id === id);
      state = state.filter((e) => e.id !== id);
      state = state.concat([
        Object.assign({}, targetElement, {
          element,
          imgUrl: element.imgUrl,
          name: element.name,
          w: elementW,
          h: elementH,
        }),
      ]);
      return state;
    });
    updateStarterElements((state) => {
      state = state.filter((e) => e.id !== element.id);
      state = state.concat([element]);
      state = state.sort((a, b) => a.name.localeCompare(b.name));
      return state;
    });
  };

  // hack way to refresh icons that timeout
  const oneTimeIconRefresh = useRef(false);
  useEffect(() => {
    if (starterElements && !oneTimeIconRefresh.current) {
      oneTimeIconRefresh.current = true;
      starterElements.forEach((element) => {
        if (!element.imgUrl) {
          fetchAPI(`/get-element?id=${element.id}`).then((updatedValue) => {
            if (updatedValue.imgUrl) {
              updateStarterElements((state) => {
                state = state.filter((e) => e.id !== updatedValue.id);
                state = state.concat([updatedValue]);
                state = state.sort((a, b) => a.name.localeCompare(b.name));
                return state;
              });
            }
          });
        }
      });
    }
  }, [fetchAPI, updateStarterElements, starterElements]);

  const clear = () => {
    window.gtag("event", "element_cleared");
    setElements([]);
    setSearch("");
  };

  const restart = () => {
    clear();
    resetStarterElements();
  };

  const showUserInfo = () => {
    swal.fire({
      title: `Your Stats`,
      text: `Congrats! You are the first person to discover asdasd.`,
      html: `You invented <b>${stats.userCreatedElements.length}</b> elements ${
        stats.userCreatedElements.length > 0
          ? "<br/>" + stats.userCreatedElements.join(", ")
          : ""
      }<hr style="margin:10px"/>User ID: <b>${userId}</b>`,
    });
  };

  const showChallengeComplete = (challengeCredits) => {
    swal.fire({
      title: `Daily Challenge Complete`,
      text: `Congrats! You recieved ${challengeCredits} free credits for completing the daily challenge.`,
    });
  };

  const showChallengeInfo = () => {
    if (!stats) {
      return;
    }
    const history = stats.dailyChallengeHistory;
    history.sort((a, b) => (a.date < b.date ? 1 : -1));
    const listHTML =
      "<br/><br/>" +
      history
        .filter(
          (dc) => dc.completedEasy || dc.completedHard || dc.completedExpert
        )
        .map((dc) => {
          return `<b>${dc.date}</b> - ${dc.elementEasy} ${
            dc.completedEasy ? "✅" : "❌"
          } ${dc.elementHard} ${dc.completedHard ? "✅" : "❌"} ${
            dc.elementExpert
          } ${dc.completedExpert ? "✅" : "❌"}`;
        })
        .join("");
    swal.fire({
      title: `Daily Challenges`,
      html:
        `These are daily elements you can make to earn free credits (easy 5 / hard 50 / expert 500). All challenges can be done by only combining 2 elements at a time and with already discovered combinations (meaning you can solve them without using any mixtures).` +
        listHTML,
    });
  };

  return (
    <div>
      <HStack bgColor={"#2D3748"} color={"#fff"} p={2}>
        <span>Infinite Alchemy</span>
        <span></span>
        <Spacer />
        <Box fontSize={"0.8rem"}>
          <a href="https://github.com/sshh12/llm_alchemy">
            GitHub <ExternalLinkIcon />
          </a>
        </Box>
      </HStack>

      <hr />
      <HStack padding={"20px"}>
        <Stat>
          <StatLabel>
            Your
            <br />
            Elements
          </StatLabel>
          <StatNumber>{starterElements.length}</StatNumber>
          <StatHelpText>
            {Math.ceil((starterElements.length / stats?.totalElements) * 100)}%
          </StatHelpText>
        </Stat>
        <Stat>
          <StatLabel>
            Known <br />
            Elements
          </StatLabel>
          <StatNumber>{stats?.totalElements || "-"}</StatNumber>
          <StatHelpText>
            {stats && (
              <Button
                size="xs"
                colorScheme="blue"
                onClick={() => showUserInfo()}
              >
                You Invented {stats?.userCreatedElements.length}
              </Button>
            )}
          </StatHelpText>
        </Stat>
        <Stat>
          <StatLabel>
            Mixtures <br />
            Remaining
          </StatLabel>
          <StatNumber>{credits || 0}</StatNumber>
          <StatHelpText>
            {stats && userId && (
              <Button size="xs" colorScheme="green">
                <a
                  href={`https://buy.stripe.com/6oE7w1cNbbC07IIeUV?client_reference_id=infalchemy___${userId.replace(
                    ":",
                    "_"
                  )}`}
                >
                  Buy More
                </a>
              </Button>
            )}
          </StatHelpText>
        </Stat>
      </HStack>
      <hr />

      <ChallengeSection stats={stats} showChallengeInfo={showChallengeInfo} />

      <hr />

      <Flex
        direction="row"
        spacing={4}
        align="center"
        padding={"10px"}
        textAlign={"center"}
      >
        <Button colorScheme="red" variant="outline" onClick={() => restart()}>
          Restart
        </Button>
        <Spacer />
        <Button colorScheme="blue" variant="outline" onClick={() => clear()}>
          Clear
        </Button>
      </Flex>
      <hr />

      <Box padding={"10px"}>
        <InputGroup maxWidth={"30rem"}>
          <InputRightElement pointerEvents="none">
            <SearchIcon color="gray.300" />
          </InputRightElement>
          <Input
            type="input"
            placeholder="Elements"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
      </Box>

      <div
        style={{
          height: "100%",
          padding: "10px",
          overflow: "scroll",
          minHeight: `${Math.max(maxElementY, window.innerHeight)}px`,
        }}
      >
        {starterElements
          .filter(
            (se) =>
              search === "" ||
              se.name.toLowerCase().includes(search.toLowerCase())
          )
          .map((se) => (
            <div key={se.id} style={{ paddingBottom: "10px" }}>
              <Element
                size={{ w: elementW, h: elementH }}
                onDragStart={(e) => onFactoryDragStart(se, e)}
                onDragStop={(e) => onDragStop(e)}
                hoverEffect={false}
                element={se}
                imgUrl={se.imgUrl}
                name={se.name}
              />
            </div>
          ))}
      </div>
      <div
        style={{
          zIndex: 10,
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        {elements.map((element) => (
          <Element
            key={element.id}
            position={{ x: element.x, y: element.y }}
            size={{ w: element.w, h: element.h }}
            onDragStart={(e) => onDragStart(element, e)}
            onDragStop={(e) => onDragStop(e)}
            hoverEffect={element.hoverEffect}
            imgUrl={element.imgUrl}
            name={element.name}
          />
        ))}
      </div>
    </div>
  );
}

export default ElementBox;
