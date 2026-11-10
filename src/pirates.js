// Parrots & Pirates: who gets which pirate name.
//
// A name is five parts: rank, nickname, title, duty aboard and weapon of choice. The Dive Bar hands
// each part out once before it hands any out twice: a new pirate gets the least-used entry in each
// list, starting from a spot picked by their own first name, so nobody shares a nickname, a title,
// a duty or a weapon until a list has been all the way round. Ranks are the short list and repeat
// first, evenly.
//
// Once a guest is christened the name is saved against their cabin and never changes. The three
// advisors' names were published before this rule existed, so they are held for them and for
// nobody else.

import { getPirate, listPirateParts, insertPirate } from './db.js';

export const PIRATE = {
  rank: [
    "Captain", "Commodore", "Admiral", "First Mate", "Bosun", "Quartermaster", "Cap'n", "Rear Admiral",
    "Navigator", "Lookout", "Skipper", "Harbormaster", "Gunner", "Purser", "Privateer", "Buccaneer",
    "Corsair", "Swashbuckler", "Sea Dog", "Deckhand", "Coxswain", "Sailing Master", "Second Mate",
    "Commander", "Vice Admiral", "Fleet Admiral", "Ensign", "Lieutenant", "Pilot", "Cannoneer", "Rigger",
    "Scallywag", "Stowaway", "Mutineer", "Powder Monkey", "Ship's Cook", "Master Gunner", "Chief Mate",
    "Dread Pirate", "Castaway", "Old Salt", "Landlubber", "Ship's Surgeon", "Beachcomber",
  ],
  adj: [
    "Salty", "Barefoot", "Sunburnt", "Rum-Soaked", "Flip-Flop", "Landshark", "Coconut", "Tiki",
    "Hammock-Bound", "Sandbar", "One-Flop", "Lime-Squeezin'", "Blender-Breakin'", "Latitude-Lost",
    "Boat-Drink", "Cheeseburger", "Fins-Up", "Volcano", "Last-Mango", "Pencil-Thin", "Banana-Wind",
    "Jolly", "Fruitcake", "Parakeet", "Grapefruit", "Pink-Crustacean", "Havana", "Ragtop", "Lone-Palm",
    "Conch-Blowin'", "Sun-Baked", "Sandy-Toed", "Windblown", "Barnacle", "Driftwood", "Seashell",
    "Starboard", "Portside", "Leeward", "Windward", "Margarita", "Salt-Rimmed", "Shaker-Huntin'",
    "Limbo", "Conga-Line", "Steel-Drum", "Ukulele", "Calypso", "Reggae", "Island-Time", "Five-O'Clock",
    "Sunset", "Moonlit", "High-Tide", "Low-Tide", "Riptide", "Tradewind", "Hurricane", "Squall-Dodgin'",
    "Tropical", "Key-Lime", "Pineapple", "Mango-Salsa", "Papaya", "Guava", "Plantain", "Jerk-Chicken",
    "Conch-Fritter", "Coconut-Shrimp", "Rum-Punch", "Mai-Tai", "Daiquiri", "Mojito", "Painkiller",
    "Rum-Runner", "Bushwacker", "Hula", "Grass-Skirt", "Aloha-Shirt", "Straw-Hat", "Shades-On",
    "Sunscreen", "Aloe-Soaked", "Tan-Line", "Beach-Bum", "Bonfire", "Lighthouse", "Anchor-Droppin'",
    "Sail-Trimmin'", "Knot-Tyin'", "Plank-Walkin'", "Treasure-Huntin'", "Map-Readin'",
    "Parrot-Whisperin'", "Shanty-Singin'", "Wave-Ridin'", "Deck-Swabbin'", "Cannonball", "Belly-Flop",
    "Poolside", "Hot-Tub", "Buffet-Bound", "Midnight-Snack", "Sea-Legged", "Peg-Leg", "Eye-Patch",
    "Gold-Tooth", "Doubloon", "Jolly-Roger", "Black-Flag", "Marooned", "Shipwrecked", "Nautical-Wheeler",
    "Six-String", "Peanut-Butter", "Twelve-Volt", "Bubbles-Up", "Love-and-Luck", "Lovely-Cruise",
    "License-to-Chill", "Jamaica-Mistaica", "Barometer-Soup", "Floridays", "Bama-Breeze", "Biloxi",
    "Come-Monday", "Door-Number-Three", "Quietly-Making-Noise", "Trip-Around-the-Sun", "Boats-to-Build",
    "Stars-on-the-Water", "Jolly-Mon",
  ],
  tail: [
    "the Unanchored", "of the Lost Shaker", "Scourge of the Lido Deck", "Terror of Duval Street",
    "of Key West", "the Latitude-Challenged", "Keeper of the Last Mango", "the Mostly Harmless",
    "of the Flip Flop Bar", "who Fears No Blender", "Protector of the Pool Deck",
    "the Perpetually Boat-Drunk", "of Seven Mile Beach", "Admiral of the Hot Tub", "the Volcano-Tested",
    "of One Particular Harbour", "who Grew Older but Not Up", "of the Coconut Telegraph",
    "Defender of the Cheeseburger", "Mayor of Margaritaville", "Ruler of the Tiki Bar",
    "Bane of Hurricane Season", "Keeper of the Tin Cup Chalice", "who Never Found the Salt",
    "Lookout of the Hemisphere Dancer", "of the Pascagoula Run", "Sultan of Sunsets",
    "the Barefoot Buccaneer", "Warden of the Towel Chairs", "who Claims Every Hammock",
    "the Unsinkable", "the Thoroughly Sunscreened", "the Gloriously Overdressed", "the Rarely Thirsty",
    "of the High Seas", "of the Seven Seas", "Terror of the Buffet Line", "Scourge of the Salad Bar",
    "the Barnacle-Proof", "the Sand-Proof", "of Grand Cayman", "of Ocho Rios", "of Stingray City",
    "of Dunn's River Falls", "of Mile Marker Zero", "of Mallory Square", "of the Southernmost Point",
    "Governor of the Conch Republic", "of the Dry Tortugas", "of the Florida Straits",
    "of the Gulf Stream", "Pride of the Caribbean", "of the Port of Miami", "of Biscayne Bay",
    "of Montego Bay", "the Tide-Turner", "the Wave-Tamer", "the Storm-Dodger", "the Sunset-Chaser",
    "the Shark-Whisperer", "Friend to All Parrots", "the Parrot-Tamer", "Leader of the Fin Parade",
    "Champion of the Limbo", "Menace of the Dance Floor", "High Roller of the Casino Deck",
    "Sovereign of the Sun Deck", "Monarch of the Midnight Buffet", "Sheriff of the Sushi Bar",
    "Guardian of the Guacamole", "Champion of the Chip Basket", "Defender of the Last Nacho",
    "Hoarder of the Hot Sauce", "Keeper of the Key Lime Pie", "Finder of Lost Flip-Flops",
    "Loser of Many Sunglasses", "who Lost Another Hat Overboard", "who Packed Only Hawaiian Shirts",
    "who Naps at Noon", "who Never Misses Sailaway", "who Knows Where the Rum Went",
    "who Dances Like Nobody Is Steering", "who Brought a Spare Flip-Flop", "who Always Finds the Shade",
    "who Has Never Missed a Sunset", "who Tips in Doubloons", "who Sings Off Key in Key West",
    "the Fearless", "the Fashionably Late", "the Slightly Sunburnt", "the Well-Seasoned", "the Unsalted",
    "the Extra-Salty", "the Twice-Shipwrecked", "the Never-Seasick", "the Easily Marooned",
    "the Happily Lost", "the Tropically Inclined", "the Leisurely", "the Unhurried", "the Fin-Tastic",
    "the Shore-Leave Enthusiast", "the Deck-Chair Diplomat", "the Poolside Philosopher",
    "the Gangway Greeter", "the Sailaway Serenader", "Boss of the Balcony", "Legend of the Lido Deck",
    "the Captain's Favorite Troublemaker", "Commander of the Coconut Fleet",
    "Skipper of the Rubber Duck Armada", "Protector of the Parrot Perch", "Keeper of the Crow's Nest",
    "Watcher of the Horizon", "Chaser of the Green Flash", "Rider of the Trade Winds",
    "Collector of Tiny Umbrellas", "Wrangler of Runaway Beach Balls", "Regular of the LandShark Bar",
    "Darling of Frank and Lola's", "Toast of 5 O'Clock Somewhere", "Scourge of the Cantina",
    "Regular of Floridays", "the Last One Off the Dance Floor", "the First One at the Buffet",
    "the One Who Started the Conga Line",
  ],
  duty: [
    "Keeper of the Blender", "Officer in Charge of Sunscreen", "Chief Hammock Inspector",
    "Head of the Conga Line", "Minister of Boat Drinks", "Lookout for Land Sharks",
    "Quartermaster of Salt Shakers", "Navigator, cheerfully lost", "Judge of the Cannonball Contest",
    "Sergeant at Arms of the Buffet Line", "Master of the Cheeseburger Grill",
    "Curator of Hawaiian Shirts", "Commander of the Sailaway Playlist", "Keeper of the Sunset Toast",
    "Ambassador to Key West", "Admiral of the Fins Up Salute", "Inspector of Flip-Flop Tan Lines",
    "Chaplain of 5 O'Clock Somewhere", "Treasurer of the Swear Jar", "Captain of the Late Seating",
    "Director of Deck Chair Reservations", "Chief Towel Animal Critic", "Supervisor of Sunset Watching",
    "Official Taster of the Rum Punch", "Keeper of the Spare Flip-Flops", "Minister of Naps",
    "Secretary of Shore Leave", "Ambassador to Grand Cayman", "Ambassador to Ocho Rios",
    "Envoy to the Stingrays", "Chief Lime Wedge Officer", "Guardian of the Salt Rim",
    "Inspector of Tiny Umbrellas", "Head of Hat Retrieval", "Director of Sunglasses Lost and Found",
    "Chief of Poolside Operations", "Hot Tub Temperature Monitor", "Commissioner of Cannonballs",
    "Referee of the Belly Flop Contest", "Judge of the Limbo Finals", "Conductor of the Shanty Choir",
    "Lead Singer, enthusiastically off key", "Second Verse Specialist", "Air Guitar Section Leader",
    "Steel Drum Roadie", "Keeper of the Ukulele Tuner", "Chief Tambourine Officer",
    "Dance Floor Safety Officer", "Captain of the Conga Caboose", "Director of Fin Choreography",
    "Parrot Wrangler", "Chief Parrot Translator", "Keeper of the Crackers",
    "Treasure Map Reader, mostly upside down", "Keeper of the Treasure Chest Key", "Counter of Doubloons",
    "Polisher of the Ship's Bell", "Swabber of One Small Section of Deck", "Lookout from the Lounge Chair",
    "Watch Officer of the Dessert Table", "Chief Guacamole Inspector", "Nacho Distribution Officer",
    "Taco Quality Control", "Keeper of the Hot Sauce", "Midnight Buffet Scout", "Breakfast Bacon Auditor",
    "Minister of Second Desserts", "Chief Coffee Finder", "Bubbles Up Brunch Toastmaster",
    "Mimosa Refill Coordinator", "Champagne Cork Spotter", "Bartender Appreciation Officer",
    "Keeper of the Koozies", "Ice Bucket Brigade Captain", "Straw Hat Fitter",
    "Bandana Folding Instructor", "Eye Patch Quality Inspector", "Costume Contest Hype Crew",
    "Pirate Accent Coach", "Official Arrr Counter", "Plank Safety Inspector", "Keeper of the Jolly Roger",
    "Flag Raiser, weather permitting", "Knot Tyer, one knot only", "Anchor Emotional Support Officer",
    "Compass Holder, pointing roughly south", "Chief Horizon Watcher", "Green Flash Spotter",
    "Dolphin Spotter First Class", "Flying Fish Counter", "Seagull Negotiator", "Wave Height Estimator",
    "Weather Optimist", "Sailaway Horn Appreciator", "Gangway Greeter", "Elevator Small Talk Captain",
    "Cabin Door Decoration Judge", "Balcony Sunrise Correspondent", "Group Photo Wrangler",
    "Selfie Stick Sergeant", "Keeper of the Charging Cables", "Silent Auction Bid Spotter",
    "Cruising for Change Cheerleader", "Meet and Greet Welcome Committee", "First Timer Tour Guide",
    "Head Counter at Muster", "Lifejacket Fashion Critic", "Shore Excursion Snack Carrier",
    "Beach Bag Quartermaster", "Sandcastle Architect", "Seashell Appraiser", "Tide Pool Supervisor",
    "Snorkel Mask Defogger", "Keeper of the Waterproof Phone Pouch", "Souvenir Shirt Negotiator",
    "Duval Street Tour Guide", "Mile Marker Zero Photographer", "Key Lime Pie Taste Tester",
    "Conch Fritter Critic", "Jerk Chicken Scout", "Trivia Team Ringer", "Keeper of the Dive Bar Password",
    "Rumor Mill Operator", "Bedtime Denier", "Last Call Negotiator", "Morning After Coffee Courier",
    "Chief Storyteller, details vary", "Keeper of the Inside Jokes",
  ],
  weapon: [
    "a salt shaker", "a blender on high", "a frozen concoction", "a single flip-flop", "a conch shell",
    "a ukulele, badly tuned", "a koozie", "sunscreen, SPF 50", "a parrot on the shoulder",
    "a boat drink in each hand", "a pool noodle", "a paper umbrella", "a tiki torch",
    "a beach towel claimed at 6 AM", "a shaker of salt, finally found", "a cheeseburger, medium rare",
    "a lime wedge", "a tiny cocktail sword", "a foam cutlass", "an inflatable parrot",
    "an inflatable sword", "a water pistol", "a wet beach towel, snapped", "a pair of flip-flops, thrown",
    "a coconut, hollowed out", "a pineapple", "a banana, held like a pistol", "a mango", "a key lime pie",
    "a conch fritter", "a basket of hot wings", "a plate of nachos", "a taco in each hand",
    "a jar of hot sauce", "a bottle of rum, mostly empty", "a rum punch with two straws",
    "a margarita, salt on the rim", "a mai tai with extra fruit", "a pitcher of sangria",
    "a bucket of ice", "a cocktail shaker", "a swizzle stick", "a bottle opener on a string",
    "a corkscrew", "a champagne cork", "a beer bucket", "a bar tab", "a foam finger", "a shark fin hat",
    "a parrot hat", "a straw hat, frisbee style", "a Hawaiian shirt, unbuttoned", "a grass skirt",
    "a lei, swung like a lasso", "a string of beads", "a bandana", "an eye patch, worn on the wrong eye",
    "a plastic hook", "a wooden spoon", "a spyglass, held backwards", "a treasure map, upside down",
    "a compass that points to the bar", "a message in a bottle", "a bottle of sand",
    "a bucket and shovel", "a sandcastle mold", "a seashell", "a plastic starfish", "a rubber duck",
    "a beach ball", "a frisbee", "a snorkel", "a pair of swim fins", "a dive mask, fogged",
    "a boogie board", "an inflatable flamingo", "a pool float shaped like a pizza", "a deck chair",
    "a room key card", "a lanyard", "a towel animal", "a pillow chocolate", "a do not disturb sign",
    "a selfie stick", "a waterproof phone pouch", "a disposable camera", "a karaoke microphone",
    "a tambourine", "a set of maracas", "a kazoo", "a harmonica", "a steel drum mallet", "a cowbell",
    "a conga drum", "a boom box", "a six-string with five strings", "a guitar pick", "a setlist",
    "a sea shanty, sung loudly", "a dad joke", "a pun about fins", "a very long story",
    "a dance move from 1985", "a limbo stick", "a high five", "a wink and a smile", "a sunburn",
    "a flip-flop tan line", "a nap schedule", "a second dessert", "an ice cream cone", "a breadstick",
    "a butter knife", "a fondue fork", "a lobster bib", "a crab mallet", "a fishing rod with no hook",
    "a tackle box full of snacks", "a cooler on wheels", "a tiki mug", "a coconut cup",
    "a bamboo back scratcher", "a fly swatter", "a hand fan", "a spray bottle of sea water",
    "a bottle of aloe", "a tube of zinc", "a pair of very loud shorts", "a pair of sunglasses, lost twice",
    "a visor", "a fanny pack", "a jolly roger flag", "a parrot that repeats everything",
  ],
};

const CATS = ['rank', 'adj', 'tail', 'duty', 'weapon'];

// Published in the Drifters Facebook group before names were unique, so these three are theirs:
// for an admin previewing the page, and for the guest whose cabin carries that surname.
export const RESERVED = [
  { first: 'dawn', last: 'turner', parts: { rank: "Captain", adj: "Coconut", tail: "the Mostly Harmless", duty: "Inspector of Flip-Flop Tan Lines", weapon: "a single flip-flop" } },
  { first: 'lori', last: 'judd', parts: { rank: "Cap'n", adj: "Last-Mango", tail: "Mayor of Margaritaville", duty: "Treasurer of the Swear Jar", weapon: "a beach towel claimed at 6 AM" } },
  { first: 'brent', last: 'beasley', parts: { rank: "Harbormaster", adj: "Conch-Blowin'", tail: "the Unanchored", duty: "Sergeant at Arms of the Buffet Line", weapon: "a tiki torch" } },
];

function pirateHash(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (Math.imul(x, 31) + s.charCodeAt(i)) >>> 0;
  return x;
}

/** "jim dunn" -> "Jim": the first word, letters only, capitalised. Null when there is nothing to use. */
export function cleanFirst(raw) {
  const n = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!n) return null;
  let first = n.split(' ')[0].replace(/[^A-Za-z'\-]/g, '').slice(0, 24);
  if (!/[A-Za-z]/.test(first)) return null;
  first = first.charAt(0).toUpperCase() + first.slice(1);
  return first;
}

export function composePirate(first, parts) {
  return {
    first,
    name: `${parts.rank} ${parts.adj} ${first} ${parts.tail}`,
    duty: `Duty aboard: ${parts.duty}. Weapon of choice: ${parts.weapon}.`,
  };
}

/** The five parts of a saved row. Rows saved before parts were recorded are read back out of the text. */
export function rowToParts(row) {
  if (row && row.parts) {
    try {
      const p = JSON.parse(row.parts);
      if (p && p.adj) return p;
    } catch { /* fall through to the text */ }
  }
  const out = { rank: '', adj: '', tail: '', duty: '', weapon: '' };
  const name = String((row && row.pirate_name) || '');
  const rank = PIRATE.rank.filter((r) => name.startsWith(r + ' ')).sort((a, b) => b.length - a.length)[0] || '';
  out.rank = rank;
  const rest = rank ? name.slice(rank.length + 1) : name;
  const first = String((row && row.first_name) || '');
  const at = first ? rest.indexOf(` ${first} `) : -1;
  if (at >= 0) {
    out.adj = rest.slice(0, at);
    out.tail = rest.slice(at + first.length + 2);
  }
  const m = /^Duty aboard: (.*)\. Weapon of choice: (.*)\.$/.exec(String((row && row.duty) || ''));
  if (m) { out.duty = m[1]; out.weapon = m[2]; }
  return out;
}

/** Whether this first name, in this cabin (or for an admin), is one of the three held names. */
export function reservedFor(firstLower, cabinName, isAdmin) {
  const letters = String(cabinName || '').toLowerCase().replace(/[^a-z]/g, '');
  const hit = RESERVED.find((r) => r.first === firstLower && (isAdmin || letters.includes(r.last)));
  return hit ? hit.parts : null;
}

/**
 * Parts for a new pirate: in each list, the least-used entry, looking from a place set by the name.
 * `taken` is the parts of every pirate already christened, plus the held names.
 */
export function assignParts(firstLower, taken) {
  const parts = {};
  for (const cat of CATS) {
    const list = PIRATE[cat];
    const counts = new Map();
    for (const t of taken) if (t && t[cat]) counts.set(t[cat], (counts.get(t[cat]) || 0) + 1);
    let least = Infinity;
    for (const item of list) least = Math.min(least, counts.get(item) || 0);
    const start = pirateHash(firstLower + ':' + cat) % list.length;
    for (let i = 0; i < list.length; i++) {
      const item = list[(start + i) % list.length];
      if ((counts.get(item) || 0) === least) { parts[cat] = item; break; }
    }
  }
  return parts;
}

async function takenParts(db) {
  const rows = await listPirateParts(db);
  return rows.map(rowToParts).concat(RESERVED.map((r) => r.parts));
}

/** A guest's pirate name: the one already saved for this first name in this cabin, or a new one, saved. */
export async function christenPirate(db, cabin, rawName, now) {
  const first = cleanFirst(rawName);
  if (!first) return null;
  const lower = first.toLowerCase();
  const saved = await getPirate(db, cabin.id, lower);
  if (saved) return { first: saved.first_name, name: saved.pirate_name, duty: saved.duty || '' };
  const parts = reservedFor(lower, cabin.name, false) || assignParts(lower, await takenParts(db));
  const p = composePirate(first, parts);
  await insertPirate(db, { id: crypto.randomUUID(), cabin_id: cabin.id, first_name: first, first_lower: lower, pirate_name: p.name, duty: p.duty, parts: JSON.stringify(parts), created_at: now || Date.now() });
  // Two taps at once: whichever row landed is the name.
  const row = await getPirate(db, cabin.id, lower);
  return row ? { first: row.first_name, name: row.pirate_name, duty: row.duty || '' } : p;
}

/** What an admin previewing the page is shown. Nothing is saved, so it is not held for anybody. */
export async function previewPirate(db, rawName) {
  const first = cleanFirst(rawName);
  if (!first) return null;
  const lower = first.toLowerCase();
  const parts = reservedFor(lower, '', true) || assignParts(lower, await takenParts(db));
  return composePirate(first, parts);
}
