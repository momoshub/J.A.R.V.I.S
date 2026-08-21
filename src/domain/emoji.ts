/**
 * Reaction-bomb emoji categories (the `/br` command). Shortcodes without colons,
 * as the Slack reactions.add API expects. Custom-workspace categories (pepe,
 * acme, meme) are omitted - they need a per-workspace emoji list.
 */
export const EMOJI_CATEGORIES: Record<string, readonly string[]> = {
  positive: [
    "tada", "rocket", "fire", "raised_hands", "clap", "star2", "sparkles",
    "muscle", "100", "trophy", "medal", "ok_hand", "+1", "confetti_ball", "star-struck",
  ],
  party: ["tada", "confetti_ball", "partying_face", "balloon", "champagne", "clinking_glasses", "dizzy", "sparkles", "mirror_ball"],
  heart: ["heart", "two_hearts", "sparkling_heart", "heartpulse", "cupid", "revolving_hearts", "yellow_heart", "blue_heart", "green_heart", "orange_heart"],
  hand: ["wave", "raised_hands", "clap", "ok_hand", "+1", "fist", "handshake", "point_up", "call_me_hand"],
  face: ["smile", "joy", "grin", "smirk", "sunglasses", "star-struck", "relieved", "blush", "wink", "see_no_evil"],
  animal: ["dog", "cat", "panda_face", "fox_face", "unicorn_face", "hatching_chick", "penguin", "koala", "tiger"],
  flower: ["cherry_blossom", "hibiscus", "rose", "tulip", "sunflower", "bouquet", "blossom", "wilted_flower"],
  food: ["pizza", "hamburger", "fries", "sushi", "ramen", "taco", "doughnut", "cookie", "cake"],
  drink: ["coffee", "tea", "beer", "beers", "tropical_drink", "cocktail", "champagne", "bubble_tea"],
  nature: ["sunny", "rainbow", "ocean", "mountain", "deciduous_tree", "four_leaf_clover", "seedling", "star2"],
  money: ["moneybag", "money_with_wings", "dollar", "gem", "chart_with_upwards_trend", "credit_card"],
  negative: ["thumbsdown", "x", "no_entry", "skull", "melting_face", "sob", "facepalm", "clown_face"],
};

export const EMOJI_CATEGORY_NAMES = Object.keys(EMOJI_CATEGORIES);

/** How many emoji to show as a taste of each category. */
const PREVIEW = 5;

/** The categories, each with a few of its emoji rendered, for a help listing. */
export const renderCategories = (): string =>
  EMOJI_CATEGORY_NAMES.map((name) => {
    const preview = (EMOJI_CATEGORIES[name] ?? [])
      .slice(0, PREVIEW)
      .map((e) => `:${e}:`)
      .join(" ");
    return `- \`${name}\` ${preview}`;
  }).join("\n");

/** Pick up to `n` distinct emoji from a category (shuffled). Empty if unknown. */
export const pickBomb = (category: string, n: number, rng: () => number = Math.random): string[] => {
  const pool = EMOJI_CATEGORIES[category];
  if (!pool) return [];
  const shuffled = [...pool].sort(() => rng() - 0.5);
  return shuffled.slice(0, Math.max(0, Math.min(n, shuffled.length)));
};
