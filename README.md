# Infinite Alchemy

![screen gif](https://github.com/sshh12/llm_alchemy/assets/6625384/ab7e9a64-52c8-4aa2-9602-20a37e37158f)

## How To Play

Drag and drop two or more elements on top of each other to combine them.

#### Objective

This is a relaxing game with no real objective, you could try to:

- Create as many new elements as possible
- Pick a specific item/thing in the real world and try to craft it from the basic elements
- Keep adding e.g. fire to something and see what happens

## AI-powered

This is very similar to an existing game called [Little Alchemy](https://littlealchemy2.com/), the main difference is that the elements, recipes, and "artwork" are dynamically generated with GPT-4 and DALLE.

##### GPT Prompt

```
You are a powerful alchemist, I will give you two items and you will do your best to describe the outcome of combining them.

Respond only with a single word which is the result item or thing. The results should be items or things. Use lower case unless it's a proper noun.

## Examples
* air + water = mist
...
```

##### DALLE Prompt

`image of ${element.name}, white background`

## Known Issues

(Things that are annoying but not currently worth fixing)

- The drag and drop UX can be funky
- Scrolling from the left item menu doesn't work
- Sometimes elements get stuck in the top left corner
- Sometimes elements never get images generated because the netlify <-> OpenAI function timed out
