// index.js
// Hugu Adventures – Travel Assistant (Travel-bot)

// Optional local .env
try {
  require("dotenv").config();
} catch (e) {
  // ignore if dotenv not available
}

const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
// ... any other requires you already have (twilio, paystack, pg, etc.)

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== VIATOR PLACEHOLDER HELPERS ==================

// Turn "Sydney" -> "SYDNEY", "Great Barrier Reef" -> "GREAT_BARRIER_REEF"
function makeCityKey(city) {
  return city
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Build placeholder map from cities with links
function buildViatorPlaceholderMap(cities) {
  const result = {};

  for (const city of cities) {
    if (!city) continue;
    const key = makeCityKey(city);
    result[city] = {
      city,
      key,
      searchPlaceholder: `VIATOR_${key}_SEARCH`,
      recommendedPlaceholder: `VIATOR_${key}_RECOMMENDED`,
    };
  }

  // Always provide a generic fallback (used only if no city fits)
  result.__fallback = {
    city: "Australia",
    key: "FALLBACK",
    searchPlaceholder: "VIATOR_FALLBACK_SEARCH",
    recommendedPlaceholder: "VIATOR_FALLBACK_RECOMMENDED",
  };

  return result;
}

// Helper: default Australia cities list (you can tweak this)
function buildDefaultAustraliaPlaceholderMap() {
  const cities = [
    "Sydney",
    "Blue Mountains",
    "Cairns",
    "Kuranda",
    "Melbourne",
    "Great Ocean Road",
    "Adelaide",
    "Barossa Valley",
    "Perth",
    "Rottnest Island",
  ];
  return buildViatorPlaceholderMap(cities);
}

// Turn placeholder map into something readable inside the prompt
function formatPlaceholderMapForPrompt(placeholderMap) {
  const lines = [];

  for (const [city, config] of Object.entries(placeholderMap)) {
    if (city === "__fallback") continue;
    lines.push(
      `- City: ${city} → use: VIATOR_${config.key}_RECOMMENDED (and VIATOR_${config.key}_SEARCH if needed)`
    );
  }

  const fallback = placeholderMap.__fallback;
  if (fallback) {
    lines.push(
      `- Generic fallback (only if no city fits): ${fallback.city} → VIATOR_FALLBACK_RECOMMENDED / VIATOR_FALLBACK_SEARCH`
    );
  }

  return lines.join("\n");
}

// ================== VIATOR URL GENERATION + INJECTION ==================

// Build actual affiliate URLs for a given city
function buildTourLinks(city) {
  if (!city) return null;

  const encoded = encodeURIComponent(String(city).trim());

  // If you already have VIATOR_BASE_URL in .env, you can use it;
  // otherwise fall back to standard Viator search URL.
  const base =
    process.env.VIATOR_BASE_URL || "https://www.viator.com/searchResults/all";

  // Replace these IDs with your actual PID / UID / MCID if needed
  const pid = "P00240917"; // your affiliate PID
  const uid = "U00642340"; // your affiliate UID
  const mcid = "58086";    // your campaign id

  return {
    searchUrl: `${base}?text=${encoded}&pid=${pid}&uid=${uid}&mcid=${mcid}&currency=USD`,
    recommendedUrl: `${base}?text=${encoded}&pid=${pid}&uid=${uid}&mcid=${mcid}&currency=USD&sort=RECOMMENDED`,
  };
}

// Small helper for Node versions without String.prototype.replaceAll
function replaceAllSafe(haystack, needle, replacement) {
  if (!needle || needle === replacement) return haystack;
  return haystack.split(needle).join(replacement);
}

// Replace placeholder tokens in the AI itinerary with real Viator URLs
function injectViatorLinksIntoItinerary(itineraryMarkdown, placeholderMap) {
  let result = itineraryMarkdown || "";

  // Replace city-specific placeholders
  for (const [city, cfg] of Object.entries(placeholderMap)) {
    if (city === "__fallback") continue;

    const links = buildTourLinks(city);
    if (!links) continue;

    if (cfg.recommendedPlaceholder) {
      result = replaceAllSafe(
        result,
        cfg.recommendedPlaceholder,
        links.recommendedUrl
      );
    }
    if (cfg.searchPlaceholder) {
      result = replaceAllSafe(
        result,
        cfg.searchPlaceholder,
        links.searchUrl
      );
    }
  }

  // Replace fallback placeholders last
  const fallback = placeholderMap.__fallback;
  if (fallback) {
    const fallbackLinks = buildTourLinks(fallback.city || "Australia");
    if (fallbackLinks) {
      if (fallback.recommendedPlaceholder) {
        result = replaceAllSafe(
          result,
          fallback.recommendedPlaceholder,
          fallbackLinks.recommendedUrl
        );
      }
      if (fallback.searchPlaceholder) {
        result = replaceAllSafe(
          result,
          fallback.searchPlaceholder,
          fallbackLinks.searchUrl
        );
      }
    }
  }

  return result;
}

// ================== ITINERARY GENERATION (NEW TRIP) ==================

/**
 * Generate a brand-new itinerary with VIATOR_* placeholders only.
 *
 * @param {Object} params
 * @param {string} params.tripDescription - Raw client text
 * @param {Object} params.itineraryMeta - Parsed metadata (days, budget, etc.)
 * @param {Object} params.placeholderMap - Output of buildViatorPlaceholderMap()
 */
async function generateItineraryText({ tripDescription, itineraryMeta, placeholderMap }) {
  const placeholderInstructions = formatPlaceholderMapForPrompt(placeholderMap);

  const systemPrompt = `
You are a professional travel planner for Hugu Adventures.

Write a well-formatted, friendly, professional multi-day itinerary as a **Markdown document** that will later be turned into a PDF.

STRICT RULES ABOUT LINKS (VERY IMPORTANT):
- You MUST NOT write real URLs inside the itinerary.
- Instead, you MUST use the exact placeholder tokens I give you.
- For every day where you recommend any **bookable activity or tour**, include a bullet with:
  - A short activity name, and
  - A Markdown link with this format:
    - [Book Tour Here](VIATOR_CITYKEY_RECOMMENDED)
- Where CITYKEY is one of the keys below.

Viator placeholder mapping:
${placeholderInstructions}

How to choose the correct placeholder:
- For each day, identify the **main city/area** that day is based in.
- Use the placeholder for that city if it exists.
- Only use VIATOR_FALLBACK_RECOMMENDED if the day is not clearly tied to any listed city.

Formatting requirements:
- Start with a bold, underlined main title, e.g. **__12 DAY SOLO ADVENTURE IN AUSTRALIA – HUGU ADVENTURES__**
- For each day:
  - Heading: **Day X: <short title>**
  - Show approximate travel times and distances when moving between locations:
    - Example line: Travel: Sydney → Blue Mountains (approx. 110 km, 2–2.5 hours by road).
  - Then use bullet points for Morning / Afternoon / Evening.
- Tone: happy, helpful, and confidence-inspiring, written for a real paying client.
- Keep paragraphs short and easy to read on mobile.

Replace placeholders ONLY with the tokens like VIATOR_SYDNEY_RECOMMENDED (no real URLs). I will replace them with affiliate links later.
`.trim();

  const userPrompt = `
Client trip request (raw text):
"${tripDescription}"

Parsed details:
- Trip length (days): ${itineraryMeta?.days || "unknown"}
- Budget level: ${itineraryMeta?.budget || "unknown"}
- Traveller type: ${itineraryMeta?.who || "unknown"}
- Travel month/season: ${itineraryMeta?.month || "unknown"}

Task:
- Create a complete day-by-day itinerary matching the above.
- Include approximate driving/flying times and distances (in km) whenever changing locations.
- For each day, list 1–3 recommended activities with [Book Tour Here](VIATOR_..._RECOMMENDED) links as described in the rules.
`.trim();

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
  });

  const text = (response.choices[0].message.content || "").trim();
  return text;
}

// ================== ITINERARY GENERATION (UPDATE EXISTING) ==================

/**
 * Update an existing itinerary (edit flow) using the same placeholder rules.
 *
 * @param {Object} params
 * @param {string} params.originalTripDescription - Original user request
 * @param {string} params.existingItineraryMarkdown - Existing itinerary text
 * @param {string} params.userUpdateText - New instructions (“change to October… etc.”)
 * @param {Object} params.itineraryMeta - Updated parsed metadata
 * @param {Object} params.placeholderMap - Output of buildViatorPlaceholderMap()
 */
async function generateUpdatedItineraryText({
  originalTripDescription,
  existingItineraryMarkdown,
  userUpdateText,
  itineraryMeta,
  placeholderMap,
}) {
  const placeholderInstructions = formatPlaceholderMapForPrompt(placeholderMap);

  const systemPrompt = `
You are a professional travel planner for Hugu Adventures.

You are updating an existing multi-day itinerary based on new client instructions.

STRICT RULES ABOUT LINKS (VERY IMPORTANT):
- You MUST NOT write real URLs inside the itinerary.
- Instead, you MUST use the exact placeholder tokens I give you.
- For every day where you recommend any **bookable activity or tour**, include a bullet with:
  - A short activity name, and
  - A Markdown link with this format:
    - [Book Tour Here](VIATOR_CITYKEY_RECOMMENDED)
- Where CITYKEY is one of the keys below.

Viator placeholder mapping:
${placeholderInstructions}

How to choose the correct placeholder:
- For each day, identify the **main city/area** that day is based in.
- Use the placeholder for that city if it exists.
- Only use VIATOR_FALLBACK_RECOMMENDED if the day is not clearly tied to any listed city.

Formatting requirements:
- Output a full, updated itinerary as **Markdown**, not just a diff.
- Keep the same general style, but adjust days, cities, and activities to match the new request.
- Show approximate travel times and distances when moving between locations.
- Tone: happy, helpful, confidence-inspiring, short paragraphs, mobile-friendly.

Do NOT insert any real URLs; only the VIATOR_* placeholder tokens.
`.trim();

  const userPrompt = `
Original client request:
"${originalTripDescription}"

Existing itinerary (may be truncated):
${existingItineraryMarkdown}

User updated instructions:
"${userUpdateText}"

Parsed updated details:
- Trip length (days): ${itineraryMeta?.days || "unknown"}
- Budget level: ${itineraryMeta?.budget || "unknown"}
- Traveller type: ${itineraryMeta?.who || "unknown"}
- Travel month/season: ${itineraryMeta?.month || "unknown"}

Task:
- Rewrite the full itinerary from Day 1 to the final day so that it matches the updated instructions.
- Preserve the overall quality and structure but adjust locations, sequence, and activities accordingly.
- For each day, list 1–3 recommended activities with [Book Tour Here](VIATOR_..._RECOMMENDED) links as described in the rules.
`.trim();

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
  });

  const text = (response.choices[0].message.content || "").trim();
  return text;
}

// ================== EXAMPLE USAGE IN YOUR FLOW ==================

// This is an example of how to wire everything together when creating a new itinerary.
// Adapt it to your existing WhatsApp / Paystack / PDF flow.

async function handleNewItineraryFlow({ tripDescription, itineraryMeta }) {
  // 1) Decide which cities to include in the placeholder map
  //    For Australia you can use:
  const placeholderMap = buildDefaultAustraliaPlaceholderMap();
  //    Or build from a dynamic list:
  // const cities = detectCitiesFromUserText(tripDescription); // <-- your own helper
  // const placeholderMap = buildViatorPlaceholderMap(cities);

  // 2) Get AI itinerary with placeholders
  const aiItineraryMarkdown = await generateItineraryText({
    tripDescription,
    itineraryMeta,
    placeholderMap,
  });

  // 3) Inject real Viator URLs (this removes VIATOR_* tokens and inserts affiliate URLs)
  const finalItineraryMarkdown = injectViatorLinksIntoItinerary(
    aiItineraryMarkdown,
    placeholderMap
  );

  // 4) Generate PDF from finalItineraryMarkdown
  //    (Use whatever you already have: PDFKit / HTML→PDF, etc.)
  const pdfBuffer = await renderItineraryPdf(finalItineraryMarkdown);

  return { finalItineraryMarkdown, pdfBuffer };
}

// Similarly for updates/edits
async function handleUpdatedItineraryFlow({
  originalTripDescription,
  existingItineraryMarkdown,
  userUpdateText,
  itineraryMeta,
}) {
  const placeholderMap = buildDefaultAustraliaPlaceholderMap();

  const aiUpdatedItinerary = await generateUpdatedItineraryText({
    originalTripDescription,
    existingItineraryMarkdown,
    userUpdateText,
    itineraryMeta,
    placeholderMap,
  });

  const finalItineraryMarkdown = injectViatorLinksIntoItinerary(
    aiUpdatedItinerary,
    placeholderMap
  );

  const pdfBuffer = await renderItineraryPdf(finalItineraryMarkdown);

  return { finalItineraryMarkdown, pdfBuffer };
}

// ================== EXPORTS / ROUTES ==================

// Keep your existing routes / Twilio webhook here.
// Just ensure that wherever you previously called your old
// generateItineraryText / generateUpdatedItineraryText + PDF,
// you now:
//   1) Build a placeholderMap,
//   2) Call the new generate* functions,
//   3) Call injectViatorLinksIntoItinerary before PDF generation.

// Example (very simplified) WhatsApp webhook (adapt to your existing one):
/*
app.post("/whatsapp/webhook", async (req, res) => {
  const incomingText = req.body.Body || "";
  const from = req.body.From;

  // ...detect if this is "new itinerary" or "edit itinerary"
  // ...build tripDescription + itineraryMeta etc.

  const { finalItineraryMarkdown, pdfBuffer } = await handleNewItineraryFlow({
    tripDescription,
    itineraryMeta,
  });

  // ...save to DB, send payment link, etc.

  res.status(200).send("OK");
});
*/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Travel-bot server running on port", PORT);
});
