import { gameSpecSchema, type GameSpec } from "./spec";

/** The featured example on /games: a spec the local LLM designed from one
 *  sentence on a real run (verified playable headless). Served at
 *  /api/games/example/play so visitors can play before they create. */
export const EXAMPLE_GAME_ID = "example";
export const EXAMPLE_GAME: GameSpec = gameSpecSchema.parse({
  "genre": "platformer",
  "title": "Foxfire Pagoda",
  "tagline": "Leap across frozen roofs to gather the last light before nightfall.",
  "story": {
    "intro": "The village lanterns are extinguishing one by one. You, a red fox ninja, must race across the slippery pagoda rooftops to relight the spirit flames before the darkness claims the town.",
    "win": "The final lantern blazes to life, banishing the cold. The village is saved, and the snow glows with a warm, golden hue.",
    "lose": "A shadowy crow snatches your spirit flame. The rooftops go dark, and the cold seeps into your bones."
  },
  "theme": "snow",
  "palette": {
    "sky": "#2b3a67",
    "ground": "#e0fbfc",
    "player": "#ff4500",
    "enemy": "#4b0082",
    "pickup": "#ffbf00",
    "accent": "#e0e1dd"
  },
  "player": {
    "name": "Kitsune",
    "look": "ninja",
    "speed": 7,
    "jump": 9,
    "lives": 3
  },
  "enemies": [
    {
      "name": "Raven Shade",
      "look": "bat",
      "behavior": "chase",
      "speed": 6
    }
  ],
  "pickup": {
    "name": "Spirit Lantern",
    "look": "fruit"
  },
  "goal": {
    "kind": "collect",
    "target": 10
  },
  "difficulty": 3,
  "length": 3,
  "version": 1,
  "seed": 3512719136
});
