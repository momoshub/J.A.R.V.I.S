/**
 * Reaction-bomb emoji categories (the `bomb` command). Shortcodes without
 * colons, as the Slack reactions.add API expects. Custom-workspace categories
 * (pepe, meme) are omitted - they need a per-workspace emoji list.
 *
 * Each category carries at least `BOMB_SIZE` emoji wherever the subject matter
 * allows, so a bomb lands its full burst instead of exhausting the pool a third
 * of the way in. Two rules keep the count honest:
 *
 * - no duplicates and no alias pairs within a category (`+1` and `thumbsup` are
 *   one emoji to Slack, so the second call returns `already_reacted`)
 * - long-established shortcodes only; a name the workspace does not know fails
 *   as `invalid_name` and silently costs a reaction
 */

/** How many reactions a bomb aims for, and the most it will ever add. */
export const BOMB_SIZE = 23;

/** Category used when the caller names none. */
export const DEFAULT_CATEGORY = "positive";

export const EMOJI_CATEGORIES: Record<string, readonly string[]> = {
  positive: [
    "tada", "rocket", "fire", "raised_hands", "clap", "star2", "sparkles",
    "muscle", "100", "trophy", "medal", "ok_hand", "+1", "confetti_ball",
    "star-struck", "star", "zap", "boom", "dart", "white_check_mark", "crown",
    "gem", "rainbow", "sunny", "heart_eyes",
  ],
  party: [
    "tada", "confetti_ball", "partying_face", "balloon", "champagne",
    "clinking_glasses", "dizzy", "sparkles", "cake", "birthday", "gift",
    "beers", "cocktail", "musical_note", "notes", "headphones", "guitar",
    "dancer", "man_dancing", "sparkler", "fireworks", "tickets", "star2",
    "microphone",
  ],
  heart: [
    "heart", "two_hearts", "sparkling_heart", "heartpulse", "cupid",
    "revolving_hearts", "yellow_heart", "blue_heart", "green_heart",
    "orange_heart", "purple_heart", "black_heart", "white_heart", "brown_heart",
    "heartbeat", "gift_heart", "heart_decoration", "love_letter", "kiss",
    "kissing_heart", "smiling_face_with_3_hearts", "heart_eyes", "hugging_face",
    "rose",
  ],
  hand: [
    "wave", "raised_hands", "clap", "ok_hand", "+1", "fist", "handshake",
    "point_up", "call_me_hand", "v", "crossed_fingers", "pray", "muscle",
    "writing_hand", "open_hands", "point_right", "point_left", "point_down",
    "raised_hand", "vulcan_salute", "metal", "punch", "raised_back_of_hand",
    "love_you_gesture",
  ],
  face: [
    "smile", "joy", "grin", "smirk", "sunglasses", "relieved", "blush", "wink",
    "see_no_evil", "hear_no_evil", "speak_no_evil", "thinking_face",
    "upside_down_face", "rolling_on_the_floor_laughing", "sweat_smile",
    "laughing", "innocent", "nerd_face", "zany_face", "exploding_head",
    "face_with_monocle", "raised_eyebrow", "yum", "hugging_face",
  ],
  animal: [
    "dog", "cat", "panda_face", "fox_face", "hatching_chick", "penguin",
    "koala", "tiger", "bear", "rabbit", "mouse", "hamster", "monkey_face",
    "pig", "cow", "frog", "lion_face", "wolf", "owl", "dolphin", "whale",
    "turtle", "butterfly", "honeybee",
  ],
  flower: [
    "cherry_blossom", "hibiscus", "rose", "tulip", "sunflower", "bouquet",
    "blossom", "wilted_flower", "rosette", "seedling", "herb",
    "four_leaf_clover", "leaves", "maple_leaf", "fallen_leaf",
    "deciduous_tree", "evergreen_tree", "palm_tree", "cactus", "ear_of_rice",
    "shamrock", "potted_plant", "white_flower", "bamboo",
  ],
  food: [
    "pizza", "hamburger", "fries", "sushi", "ramen", "taco", "doughnut",
    "cookie", "cake", "burrito", "hotdog", "popcorn", "bread", "croissant",
    "pancakes", "bacon", "egg", "rice", "curry", "spaghetti", "stew",
    "dumpling", "ice_cream", "chocolate_bar",
  ],
  drink: [
    "coffee", "tea", "beer", "beers", "tropical_drink", "cocktail", "champagne",
    "wine_glass", "sake", "milk_glass", "baby_bottle", "tumbler_glass",
    "clinking_glasses", "cup_with_straw", "mate_drink", "ice_cube",
    "potable_water", "lemon", "watermelon", "coconut",
  ],
  nature: [
    "sunny", "rainbow", "ocean", "mountain", "deciduous_tree",
    "four_leaf_clover", "seedling", "star2", "crescent_moon", "full_moon",
    "sunrise", "city_sunset", "cloud", "snowflake", "zap", "volcano", "desert",
    "beach_with_umbrella", "national_park", "milky_way", "star", "herb",
    "palm_tree", "mount_fuji",
  ],
  money: [
    "moneybag", "money_with_wings", "dollar", "gem", "chart_with_upwards_trend",
    "credit_card", "yen", "euro", "pound", "coin", "bank", "atm", "receipt",
    "briefcase", "money_mouth_face", "chart", "heavy_dollar_sign", "ledger",
    "convenience_store", "shopping_trolley",
  ],
  negative: [
    "thumbsdown", "x", "no_entry", "skull", "sob", "facepalm", "clown_face",
    "no_entry_sign", "warning", "rotating_light", "broken_heart", "cry",
    "disappointed", "weary", "tired_face", "confounded", "angry", "rage",
    "poop", "wastebasket", "bug", "skull_and_crossbones", "zipper_mouth_face",
    "see_no_evil",
  ],
};

export const EMOJI_CATEGORY_NAMES = Object.keys(EMOJI_CATEGORIES);

/** How many emoji to show as a taste of each category. */
const PREVIEW = 5;

/** The categories, each with a few of its emoji rendered, for a help listing. */
export const renderCategories = (): string =>
  EMOJI_CATEGORY_NAMES.map((name) => {
    const pool = EMOJI_CATEGORIES[name] ?? [];
    const preview = pool.slice(0, PREVIEW).map((e) => `:${e}:`).join(" ");
    return `- \`${name}\` (${pool.length}) ${preview}`;
  }).join("\n");

/** Split a `money,face,negative` argument into clean category names. */
export const parseCategories = (raw: string): string[] => [
  ...new Set(
    raw
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

export type BombPick = {
  /** The emoji to add, shuffled and distinct. */
  emojis: string[];
  /** Categories that contributed. */
  used: string[];
  /** Names that matched nothing. */
  unknown: string[];
};

/**
 * Pick up to `n` distinct emoji from one or more categories.
 *
 * Categories are pooled and de-duplicated before the draw, so combining them
 * widens the palette rather than favouring whichever came first - and asking
 * for more than a single category holds still gets you the full burst.
 */
export const pickBomb = (
  categories: readonly string[] | string,
  n: number,
  rng: () => number = Math.random,
): BombPick => {
  const names = typeof categories === "string" ? parseCategories(categories) : categories;
  const used: string[] = [];
  const unknown: string[] = [];
  const pool = new Set<string>();

  for (const name of names) {
    const emojis = EMOJI_CATEGORIES[name];
    if (!emojis) {
      unknown.push(name);
      continue;
    }
    used.push(name);
    for (const e of emojis) pool.add(e);
  }

  const shuffled = [...pool].sort(() => rng() - 0.5);
  const take = Math.max(0, Math.min(Math.floor(n), shuffled.length));
  return { emojis: shuffled.slice(0, take), used, unknown };
};
