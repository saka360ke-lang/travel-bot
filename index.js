// index.js
// Hugu Adventures – Travel Assistant (Flow 1 + affiliate link helpers + DB save)

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const OpenAI = require("openai");
const { Pool } = require("pg");
const PDFDocument = require("pdfkit");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
// Twilio sends x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== ENV VARS =====
const {
  // Our own naming
  TWILIO_SID,
  TWILIO_AUTH,
  // Twilio's usual naming (in case .env uses these)
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  DATABASE_URL,
  PORT,
  // Optional affiliate base URLs
  VIATOR_BASE_URL, // not used directly, kept for compatibility
  BOOKING_BASE_URL,
  FLIGHTS_BASE_URL,
  // Paystack
  PAYSTACK_SECRET_KEY,
  PAYSTACK_PUBLIC_KEY,
  PAYSTACK_BASE_URL,
  ITINERARY_CURRENCY,
} = process.env;

// Support both styles of env var naming
const accountSid = TWILIO_SID || TWILIO_ACCOUNT_SID;
const authToken = TWILIO_AUTH || TWILIO_AUTH_TOKEN;

// Minimal safe debug (no secrets printed)
console.log(
  "Twilio SID present:",
  !!accountSid,
  "| Twilio number present:",
  !!TWILIO_NUMBER
);

const client = twilio(accountSid, authToken);

const db = new Pool({
  connectionString: DATABASE_URL,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // or "gpt-4o-mini"
const ITINERARY_MODEL = process.env.ITINERARY_MODEL || "gpt-4.1-mini";

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined,
});

const S3_BUCKET = process.env.AWS_S3_BUCKET;
const S3_BASE_URL = process.env.AWS_S3_BASE_URL;

// ===== PAYSTACK CONFIG (KES) =====
const paystackBase = PAYSTACK_BASE_URL || "https://api.paystack.co";

// Price in KES
const itineraryPriceKES = parseInt(
  process.env.ITINERARY_AMOUNT_KES || "600",
  10
); // e.g. 600 KES
const itineraryCurrency = ITINERARY_CURRENCY || "KES";

// Convert to smallest unit (KES → kobo/cents): Paystack expects this directly
const itineraryAmountSmallest = itineraryPriceKES * 100;

// ===== SIMPLE IN-MEMORY SESSION STORE =====
const sessions = {};
// sessions[from] = { state, lastDestination, lastService, itineraryDetails, currentItineraryId }

// Helper: get or create session
function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      state: "NEW", // NEW, MAIN_MENU, ...
      lastDestination: null,
      lastService: null, // "tours" | "hotels" | "flights"
      itineraryDetails: null,
      currentItineraryId: null, // used when editing
    };
  }
  return sessions[from];
}

// Helper: send WhatsApp message using Twilio
async function sendWhatsApp(to, body) {
  console.log("Sending message:", body);
  return client.messages.create({
    from: TWILIO_NUMBER,
    to,
    body,
  });
}

async function sendWhatsAppMedia(to, body, mediaUrl) {
  console.log("Sending media message:", body, "mediaUrl:", mediaUrl);
  try {
    const resp = await client.messages.create({
      from: TWILIO_NUMBER,
      to,
      body,
      mediaUrl: [mediaUrl],
    });
    console.log("Twilio media message SID:", resp.sid, "status:", resp.status);
    return resp;
  } catch (err) {
    console.error("Error sending WhatsApp media:", err);
    throw err;
  }
}

// ===== Payment Helper =====
// Create Paystack payment link for itinerary
async function createItineraryPayment(whatsappNumber, itineraryRequestId) {
  // Clean up phone to digits only
  const phoneDigits = whatsappNumber
    .replace("whatsapp:", "")
    .replace(/[^\d]/g, "");

  // Use a valid-looking domain
  const customerEmail = `wa${phoneDigits || "guest"}@huguadventures.com`;

  const reference = `ITIN_${itineraryRequestId}_${Date.now()}`;

  const payload = {
    amount: itineraryAmountSmallest, // already in smallest unit
    currency: itineraryCurrency,
    email: customerEmail,
    reference,
    metadata: {
      whatsapp_number: whatsappNumber,
      itinerary_request_id: itineraryRequestId,
      purpose: "custom_itinerary",
    },
    callback_url: "https://your-domain.com/payment/thanks",
  };

  const res = await axios.post(
    `${paystackBase}/transaction/initialize`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const data = res.data;
  if (!data.status) {
    throw new Error("Paystack init failed: " + JSON.stringify(data));
  }

  return {
    authorization_url: data.data.authorization_url,
    reference,
  };
}

// ===== AFFILIATE LINK HELPERS =====

// Viator / tours links
function buildTourLinks(destination) {
  const encoded = encodeURIComponent(destination.trim());

  // Configure via env to keep links consistent everywhere
  const base =
    process.env.VIATOR_AFFILIATE_BASE ||
    "https://www.viator.com/searchResults/all?text=";

  const suffix = process.env.VIATOR_AFFILIATE_SUFFIX || "";

  // Base search URL
  const search_url = `${base}${encoded}${suffix}`;

  // Recommended sort variant
  const recommended_url = `${base}${encoded}${suffix}&sort=RECOMMENDED`;

  return { search_url, recommended_url };
}

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
      key,
      searchPlaceholder: `VIATOR_${key}_SEARCH`,
      recommendedPlaceholder: `VIATOR_${key}_RECOMMENDED`,
    };
  }

  return result;
}

// ===== ITINERARY PROMPT TEMPLATE =====

function buildItineraryPrompt({
  mode, // "new" or "update"
  tripDetails,
  previousItineraryText,
  editRequestText,
  viatorPlaceholdersByCity, // NOT URLs – just placeholders
}) {
  const placeholderJson = JSON.stringify(viatorPlaceholdersByCity || {}, null, 2);

  return `
You are a professional travel planner for Hugu Adventures, creating friendly, clear, and practical itineraries that will be exported directly to PDF.

USER TRIP REQUEST:
"""${tripDetails}"""

AVAILABLE VIATOR PLACEHOLDERS (JSON OBJECT):
${placeholderJson}

Each entry looks like:
{
  "Sydney": {
    "key": "SYDNEY",
    "searchPlaceholder": "VIATOR_SYDNEY_SEARCH",
    "recommendedPlaceholder": "VIATOR_SYDNEY_RECOMMENDED"
  }
}

IMPORTANT:
- Do NOT invent any URLs.
- Do NOT write "https://..." links yourself.
- When you want to insert a "Book Tour" link for a specific city, you MUST use the placeholders given.
  Example:
  [Book Tour Here] VIATOR_SYDNEY_RECOMMENDED

${
  mode === "update"
    ? `PREVIOUS ITINERARY (TEXT VERSION):
"""${previousItineraryText || ""}"""

TRAVELLER'S CHANGE REQUEST:
"""${editRequestText || ""}"""
`
    : ""
}

YOUR TASK:

1. If this is a *new* itinerary, create a full, day–by–day itinerary *from scratch* based ONLY on the user's trip request.
2. If this is an *update*, understand the previous itinerary and the requested changes, then create a **new updated itinerary** that clearly reflects the new details (destinations, days, style, budget).

FORMATTING RULES (IMPORTANT – THIS GOES STRAIGHT TO PDF):
- Plain text only (no Markdown bullet symbols).
- Use this style for the main title:
  **__TRIP TITLE GOES HERE__**
- For each day:
  Day X: Short day title
- Put a blank line between paragraphs and days.
- Tone: happy, helpful, and reassuring.

CONTENT RULES:

A) STRUCTURE
- Start with a 2–3 line overview of the trip.
- Then list days in order: Day 1, Day 2, Day 3, etc.
- Ensure the total number of days matches the user's request.

B) TRANSPORT & DISTANCES
For any move between cities or major stops:
- State if it is by road or by flight (following the user’s request).
- Include approximate:
  - Driving distance in km and driving time in hours for road segments.
  - Flight duration and typical route for flights.
- Example:
  Travel: Sydney → Blue Mountains (approx. 110 km, 2–2.5 hours by road).

C) DAILY DETAIL
For each day:
- Morning: realistic activity description.
- Afternoon: more activities or travel to next place.
- Evening: relaxed suggestions (walks, viewpoints, local food, etc.).
- Match the requested budget (low / mid / luxury) and traveller type (solo / couple / family / friends).

D) VIATOR [Book Tour Here] LINES
- Use the placeholders in the JSON above.
- When recommending an activity in a city that appears in the JSON, after describing it, add a line like:
  [Book Tour Here] VIATOR_SYDNEY_RECOMMENDED
- Prefer the "recommendedPlaceholder" where available.
- Include at least one [Book Tour Here] line on each day that has activities.

E) FINAL TONE
- Make the trip sound exciting but achievable on the specified budget.
- Emphasise variety: culture, nature, local food, unique experiences.
- Do not mention that this text will become a PDF.
- Do not mention placeholders or internal rules.

OUTPUT:
Return ONLY the final itinerary text in the required format. Do NOT include explanations, notes, or JSON.
`;
}

// (Legacy helper – not used at runtime, kept for future re-use)
function buildViatorLinksBlock(keyCities) {
  if (!keyCities || keyCities.length === 0) return "None.";

  const lines = keyCities.map((city) => {
    const { search_url, recommended_url } = buildTourLinks(city);
    const url = recommended_url || search_url || "";
    return `- ${city} tours: [Book Tour Here] ${url}`;
  });

  return lines.join("\n");
}

// Booking.com / hotels links
function buildHotelLinks(destination) {
  const encoded = encodeURIComponent(destination.trim());
  const base =
    BOOKING_BASE_URL ||
    "https://your-booking-affiliate-search-url.com/search?q=";
  return [`${base}${encoded}`, `${base}${encoded}&page=2`];
}

// Flights links (e.g. Skyscanner/Kiwi)
function buildFlightLinks(routeText) {
  const encoded = encodeURIComponent(routeText.trim());
  const base =
    FLIGHTS_BASE_URL ||
    "https://your-flights-affiliate-search-url.com/search?route=";
  return [`${base}${encoded}`];
}

// ===== TEXT HELPERS =====

function mainMenuText() {
  return (
    "Hi 👋, I’m your *Hugu Adventures Travel Assistant*.\n\n" +
    "What would you like to do today?\n" +
    "1️⃣ Find *tours & activities*\n" +
    "2️⃣ Find *hotels / stays*\n" +
    "3️⃣ Find *flights*\n" +
    "4️⃣ Ask a *travel question*\n" +
    "5️⃣ Get a *custom itinerary* (from *$5*)\n" +
    "6️⃣ Get *trip inspiration* (free ideas)\n\n" +
    "Reply with *1, 2, 3, 4, 5 or 6*."
  );
}

function itineraryUpsellText(destination) {
  return (
    `Would you like me to build a *detailed day-by-day itinerary* for *${destination}* from just *$5*? 🧳✨\n\n` +
    "You’ll get:\n" +
    "• A suggested day-by-day plan\n" +
    "• Tours, hotels, and optional activities linked\n" +
    "• Ability to request edits for up to *3 days*\n\n" +
    "Reply *YES* to learn how it works, or *MENU* to go back."
  );
}

// ===== ITINERARY GENERATION HELPERS =====

// Try to extract "X days" from user details like "6 days", "for 10 days", etc.
function extractDaysFromDetails(details) {
  if (!details) return null;
  const m = details.match(/(\d+)\s*(day|days)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > 0 && n <= 60) return n;
  }
  return null;
}

// Extract likely city/region keywords from the request – simple heuristics:
function extractCitiesFromText(text) {
  if (!text) return [];
  const candidates = [
    // Australia (for now, can extend later)
    "Sydney",
    "Melbourne",
    "Cairns",
    "Brisbane",
    "Perth",
    "Adelaide",
    "Darwin",
    "Hobart",
    "Gold Coast",
    "Byron Bay",
    "Canberra",
  ];
  const found = [];
  const lower = text.toLowerCase();

  for (const city of candidates) {
    if (lower.includes(city.toLowerCase())) {
      found.push(city);
    }
  }

  return [...new Set(found)];
}

// (Legacy helper – not used in webhooks but kept for future use)
async function handlePaidItinerary(itineraryRow) {
  const userRequestText =
    itineraryRow.raw_details || itineraryRow.last_destination || "";

  const tripDetails = userRequestText || "Trip details not fully specified.";

  await generateItineraryText(tripDetails);
  // PDF + S3 + Twilio sending would go here
}

// (Legacy helper – not used in webhooks but kept for future use)
async function handleItineraryUpdate(latestRow, updatedText) {
  const originalRequestText =
    latestRow.raw_details || latestRow.last_destination || "";

  await generateUpdatedItineraryText({
    originalItineraryText: originalRequestText,
    editRequestText: updatedText,
    latestTripDetails: updatedText || originalRequestText,
  });
  // PDF + S3 + Twilio sending would go here
}

// Fallback template if AI fails
function generateItineraryFallback(destination, details) {
  const days = extractDaysFromDetails(details) || 5; // default 5 days
  let out = `🧳 *Draft Itinerary for ${destination}*\n`;
  out += `_This is a first draft based on the info you shared. We can tweak it within 3 days._\n\n`;

  for (let d = 1; d <= days; d++) {
    out += `*Day ${d}:*\n`;
    if (d === 1) {
      out += `• Arrival in ${destination}, transfer to your accommodation.\n`;
      out += "• Easy walk / rest, get familiar with the area.\n\n";
    } else {
      out +=
        "• Morning: Flexible activity (city tour, safari, beach time, or cultural visit).\n";
      out += "• Afternoon: Another activity or free time.\n";
      out +=
        "• Evening: Dinner at a recommended local spot or at your lodge.\n\n";
    }
  }

  out +=
    "📌 *Next steps:*\n" +
    "• We can swap days around or add/remove activities.\n" +
    "• I’ll soon plug in specific *tours, hotels & transfers* from Hugu Adventures’ partners.\n";

  return out;
}

// AI-powered itinerary generation – travel Q&A
async function generateTravelAnswer(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are Hugu Adventures’ friendly travel assistant. " +
            "Give concise, practical answers to travel questions (flights, safety, seasons, packing, visas, etc.). " +
            "Focus on clear, helpful advice and avoid huge essays. " +
            "If asked for something you’re not sure about (like live prices or real-time weather), say so briefly and suggest how to check.",
        },
        {
          role: "user",
          content: question,
        },
      ],
      max_tokens: 350,
      temperature: 0.7,
    });

    let answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m not sure how to answer that one, but I’ll get smarter soon.";

    // Safety: keep under ~1200 chars so we never hit Twilio 1600 limit
    if (answer.length > 1200) {
      answer = answer.slice(0, 1180) + "\n\n(Shortened to fit WhatsApp limits.)";
    }

    return answer;
  } catch (err) {
    console.error("Error from OpenAI travel Q&A:", err);
    return (
      "Sorry, I had trouble answering that question just now.\n\n" +
      "Please try rephrasing, or type *MENU* to go back."
    );
  }
}

// Very simple “main destination” extractor – can be improved later
function detectMainDestination(tripDetails) {
  if (!tripDetails) return null;

  // crude: look for “to X”
  const matchTo = tripDetails.match(/to\s+([A-Z][a-zA-Z\s]+)/);
  if (matchTo) return matchTo[1].trim();

  // fallback: pick first capitalised word sequence
  const matchCity = tripDetails.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/);
  if (matchCity) return matchCity[1].trim();

  return null;
}

// ===== NEW itinerary text generator – placeholders → real affiliate URLs =====
async function generateItineraryText(tripDetails) {
  try {
    const details = tripDetails || "";

    // 1) Find all relevant cities from the request
    let cities = extractCitiesFromText(details);

    // 2) Also detect main destination and ensure it is included
    const mainDestination = detectMainDestination(details);
    if (mainDestination && !cities.includes(mainDestination)) {
      cities.push(mainDestination);
    }

    // 3) Fallback if nothing detected
    if (!cities.length) {
      cities.push("Australia");
    }

    // 4) Build placeholder map
    const viatorPlaceholdersByCity = buildViatorPlaceholderMap(cities);

    // 5) Build prompt
    const prompt = buildItineraryPrompt({
      mode: "new",
      tripDetails: details,
      viatorPlaceholdersByCity,
    });

    const response = await openai.responses.create({
      model: ITINERARY_MODEL, // e.g. "gpt-4.1-mini"
      input: prompt,
      max_output_tokens: 2500,
    });

    let text =
      response.output &&
      response.output[0] &&
      response.output[0].content &&
      response.output[0].content[0] &&
      response.output[0].content[0].text;

    if (!text) {
      throw new Error("No itinerary text returned from OpenAI");
    }

    text = text.trim();

    // 6) POST-PROCESS: replace placeholders with real affiliate URLs for each city
    for (const city of cities) {
      const placeholders = viatorPlaceholdersByCity[city];
      if (!placeholders) continue;

      const links = buildTourLinks(city); // returns { search_url, recommended_url }
      if (!links) continue;

      const { searchPlaceholder, recommendedPlaceholder } = placeholders;
      const { search_url, recommended_url } = links;

      if (searchPlaceholder) {
        text = text.replaceAll(
          searchPlaceholder,
          search_url || recommended_url || ""
        );
      }

      if (recommendedPlaceholder) {
        text = text.replaceAll(
          recommendedPlaceholder,
          recommended_url || search_url || ""
        );
      }
    }

    return {
      itineraryText: text,
    };
  } catch (err) {
    console.error("Error in generateItineraryText:", err);
    throw err;
  }
}

// ===== UPDATED itinerary text generator – placeholders → real affiliate URLs =====
async function generateUpdatedItineraryText({
  originalItineraryText,
  editRequestText,
  latestTripDetails,
}) {
  try {
    const tripDetails =
      latestTripDetails || editRequestText || originalItineraryText || "";

    // 1) Gather cities from the most up-to-date description
    let cities = extractCitiesFromText(tripDetails);

    // 2) Ensure main destination is included as well
    const mainDestination = detectMainDestination(tripDetails);
    if (mainDestination && !cities.includes(mainDestination)) {
      cities.push(mainDestination);
    }

    // 3) Fallback if still empty
    if (!cities.length) {
      cities.push("Australia");
    }

    const viatorPlaceholdersByCity = buildViatorPlaceholderMap(cities);

    const prompt = buildItineraryPrompt({
      mode: "update",
      tripDetails,
      previousItineraryText: originalItineraryText,
      editRequestText,
      viatorPlaceholdersByCity,
    });

    const response = await openai.responses.create({
      model: ITINERARY_MODEL,
      input: prompt,
      max_output_tokens: 2500,
    });

    let text =
      response.output &&
      response.output[0] &&
      response.output[0].content &&
      response.output[0].content[0] &&
      response.output[0].content[0].text;

    if (!text) {
      throw new Error("No updated itinerary text returned from OpenAI");
    }

    text = text.trim();

    // Replace placeholders with real affiliate URLs
    for (const city of cities) {
      const placeholders = viatorPlaceholdersByCity[city];
      if (!placeholders) continue;

      const links = buildTourLinks(city);
      if (!links) continue;

      const { searchPlaceholder, recommendedPlaceholder } = placeholders;
      const { search_url, recommended_url } = links;

      if (searchPlaceholder) {
        text = text.replaceAll(
          searchPlaceholder,
          search_url || recommended_url || ""
        );
      }

      if (recommendedPlaceholder) {
        text = text.replaceAll(
          recommendedPlaceholder,
          recommended_url || search_url || ""
        );
      }
    }

    return {
      updatedItineraryText: text,
    };
  } catch (err) {
    console.error("Error in generateUpdatedItineraryText:", err);
    throw err;
  }
}

async function generateTripInspiration(preferences) {
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are Hugu Adventures’ playful trip-inspiration assistant. " +
            "Given a short description of what the user wants (duration, budget, region, interests), " +
            "suggest 2–3 concrete trip ideas. Each idea should have a title and 3–4 bullet points. " +
            "Keep the language exciting but clear. Assume the user can be anywhere in the world.",
        },
        {
          role: "user",
          content:
            "User preferences:\n" +
            preferences +
            "\n\nReturn WhatsApp-friendly text under about 1200 characters.",
        },
      ],
      max_tokens: 450,
      temperature: 0.9,
    });

    let text =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Here are a few ideas: a city break, a beach escape, or a short safari. I’ll be smarter soon.";

    // Safety: keep under ~1200 chars to avoid Twilio’s 1600-char combined limit
    if (text.length > 1200) {
      text = text.slice(0, 1180) + "\n\n(Shortened for WhatsApp.)";
    }

    return text;
  } catch (err) {
    console.error("Error from OpenAI trip inspiration:", err);
    return (
      "Sorry, I had trouble generating trip ideas just now. 😅\n\n" +
      "Please try again in a moment, or type *MENU* to go back."
    );
  }
}

// ===== PDF + S3 HELPERS =====

function generateItineraryPdfBuffer(itineraryText, title = "Trip Itinerary") {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(20).text(title, { align: "center" });
      doc.moveDown();

      doc.fontSize(11).text(itineraryText, {
        align: "left",
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function uploadItineraryPdfToS3(buffer, key) {
  if (!S3_BUCKET || !S3_BASE_URL) {
    throw new Error("S3_BUCKET or S3_BASE_URL not configured");
  }

  const objectKey = `itineraries/${key}.pdf`;

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: objectKey,
    Body: buffer,
    ContentType: "application/pdf",
  });

  await s3.send(command);

  return `${S3_BASE_URL}/${objectKey}`;
}

// ===== PAYSTACK WEBHOOK – confirm payment automatically =====
app.post("/paystack/webhook", async (req, res) => {
  // bodyParser.json() already parsed JSON for us
  const event = req.body;

  console.log("Paystack webhook event:", JSON.stringify(event, null, 2));

  if (event && event.event === "charge.success" && event.data) {
    const reference = event.data.reference;
    const status = event.data.status; // should be "success"

    if (status === "success") {
      try {
        // Update itinerary_requests with paid status
        const updateRes = await db.query(
          `UPDATE itinerary_requests
           SET payment_status = 'paid',
               editable_until = NOW() + interval '3 days'
           WHERE paystack_reference = $1
           RETURNING id, whatsapp_number, raw_details, last_destination`,
          [reference]
        );

        console.log("Webhook DB update rowCount:", updateRes.rowCount);

        if (updateRes.rowCount > 0) {
          const row = updateRes.rows[0];
          const wa = row.whatsapp_number;
          const details = row.raw_details || "";
          const dest = row.last_destination || "your trip";

          // 1) Generate itinerary text (AI)
          let itineraryText;
          try {
            const tripDetails = details || `Trip to ${dest}`;
            const { itineraryText: generatedText } =
              await generateItineraryText(tripDetails);
            itineraryText = generatedText;
          } catch (genErr) {
            console.error("Error generating AI itinerary, using fallback:", genErr);
            itineraryText = generateItineraryFallback(dest, details);
          }

          // 2) Save text into DB
          await db.query(
            `UPDATE itinerary_requests
             SET itinerary_text = $1
             WHERE id = $2`,
            [itineraryText, row.id]
          );

          try {
            // 3) Generate PDF buffer
            const pdfTitle = `Itinerary for ${dest}`;
            const pdfBuffer = await generateItineraryPdfBuffer(
              itineraryText,
              pdfTitle
            );

            // 4) Upload to S3, get public URL
            const pdfUrl = await uploadItineraryPdfToS3(
              pdfBuffer,
              `itinerary_${row.id}`
            );

            // 5) Save PDF URL in DB
            await db.query(
              `UPDATE itinerary_requests
               SET itinerary_pdf_url = $1
               WHERE id = $2`,
              [pdfUrl, row.id]
            );

            // 6) Send short WhatsApp message + PDF
            const shortMsg =
              "🎉 *Payment received successfully!* Thank you.\n\n" +
              `I’ve created your *custom itinerary* for *${dest}* as a PDF.\n` +
              "📄 Please open the attached file to view your day-by-day plan.\n\n" +
              "You can reply with *EDIT ITINERARY* within the next *3 days* to request changes.";

            await sendWhatsAppMedia(wa, shortMsg, pdfUrl);

            // OPTIONAL: also send a tiny text confirmation in case media rendering fails on WhatsApp
            await sendWhatsApp(
              wa,
              "✅ Your itinerary PDF has been sent. If you don’t see it, reply with *ITINERARY* and I’ll resend the text version."
            );
          } catch (err) {
            console.error(
              "Error generating or uploading PDF, falling back to text:",
              err
            );

            // Fallback: send as text, but enforce Twilio 1600-char limit
            let msg =
              "🎉 *Payment received successfully!* Thank you.\n\n" +
              `Here is your *draft itinerary* for *${dest}*:\n\n` +
              itineraryText +
              "\n\nYou can reply with *EDIT ITINERARY* to request changes within the next *3 days*, " +
              "or *ITINERARY* any time to view this plan again.";

            if (msg.length > 1500) {
              msg =
                msg.slice(0, 1500) +
                "\n\n(Shortened to fit WhatsApp limits.)";
            }

            await sendWhatsApp(wa, msg);
          }
        } else {
          console.warn("No itinerary_request found for reference:", reference);
        }
      } catch (err) {
        console.error("Error handling Paystack webhook:", err);
      }
    }
  }

  res.status(200).send("OK");
});

// ===== WhatsApp WEBHOOK HANDLER =====
app.post("/webhook", async (req, res) => {
  const from = req.body.From; // e.g. 'whatsapp:+2547...'
  const body = (req.body.Body || "").trim();
  const text = body.toLowerCase();

  console.log("Incoming from:", from, "text:", body);

  const session = getSession(from);

  // Helper to finish the HTTP response without sending "OK"
  const finish = () => {
    if (!res.headersSent) {
      res.status(200).end(); // empty body → no extra "OK" message in WhatsApp
    }
  };

  try {
    // === GLOBAL: VIEW ITINERARY ===
    if (text === "itinerary" || text === "my itinerary") {
      try {
        const r = await db.query(
          `SELECT id, itinerary_text, itinerary_pdf_url, editable_until, payment_status
           FROM itinerary_requests
           WHERE whatsapp_number = $1
             AND payment_status = 'paid'
           ORDER BY created_at DESC
           LIMIT 1`,
          [from]
        );

        if (
          r.rowCount === 0 ||
          (!r.rows[0].itinerary_text && !r.rows[0].itinerary_pdf_url)
        ) {
          await sendWhatsApp(
            from,
            "I couldn’t find any paid itineraries for this number yet. You can get one by choosing *5* from the main menu."
          );
        } else {
          const row = r.rows[0];
          let extra = "";
          if (row.editable_until) {
            extra =
              "\n\n🕒 *Edit window:* until " +
              new Date(row.editable_until).toLocaleString("en-GB", {
                timeZone: "Africa/Nairobi",
              }) +
              " (Africa/Nairobi time).";
          }

          if (row.itinerary_pdf_url) {
            // Prefer PDF to avoid long SMS limits
            await sendWhatsAppMedia(
              from,
              "Here is your latest itinerary as a PDF. 📄" + extra,
              row.itinerary_pdf_url
            );
          } else {
            // Fallback to truncated text if no PDF is available
            let txt =
              row.itinerary_text ||
              "I have your itinerary, but I couldn’t load the details.";
            if (txt.length > 1500) {
              txt =
                txt.slice(0, 1500) +
                "\n\n(Shortened. Please request a new PDF itinerary if needed.)";
            }
            await sendWhatsApp(
              from,
              "Here is your latest itinerary:\n\n" + txt + extra
            );
          }
        }
      } catch (err) {
        console.error("Error fetching itinerary:", err);
        await sendWhatsApp(
          from,
          "Sorry, I had trouble loading your itinerary. Please try again in a moment."
        );
      }
      finish();
      return;
    }

    // === GLOBAL: EDIT ITINERARY ===
    if (text === "edit itinerary" || text === "edit trip") {
      try {
        const r = await db.query(
          `SELECT id, itinerary_text, editable_until
           FROM itinerary_requests
           WHERE whatsapp_number = $1
             AND payment_status = 'paid'
           ORDER BY created_at DESC
           LIMIT 1`,
          [from]
        );

        if (r.rowCount === 0) {
          await sendWhatsApp(
            from,
            "I couldn’t find a paid itinerary to edit. You can request one by choosing *5* from the main menu."
          );
        } else {
          const row = r.rows[0];

          if (row.editable_until && new Date(row.editable_until) < new Date()) {
            await sendWhatsApp(
              from,
              "Your 3-day edit window for this itinerary has expired. To create a new version, please choose *5* from the main menu and request a fresh itinerary."
            );
          } else {
            session.state = "EDIT_ITINERARY_DETAILS";
            session.currentItineraryId = row.id;

            await sendWhatsApp(
              from,
              "No problem! 😊\nPlease send your *updated trip details* (or describe the changes you’d like). I’ll regenerate your itinerary based on your new message."
            );
          }
        }
      } catch (err) {
        console.error("Error preparing edit itinerary:", err);
        await sendWhatsApp(
          from,
          "Sorry, I hit a problem while preparing your edit. Please try again shortly."
        );
      }
      finish();
      return;
    }

    // ===== GLOBAL COMMANDS (MAIN MENU ETC.) =====
    if (
      text === "menu" ||
      text === "hi" ||
      text === "hello" ||
      text === "start"
    ) {
      session.state = "MAIN_MENU";
      await sendWhatsApp(from, mainMenuText());
      finish();
      return;
    }

    // ===== STATE MACHINE =====
    switch (session.state) {
      case "NEW": {
        session.state = "MAIN_MENU";
        await sendWhatsApp(from, mainMenuText());
        break;
      }

      case "MAIN_MENU": {
        console.log("STATE MAIN_MENU, user choice:", text);

        if (text === "1") {
          session.state = "ASK_TOUR_DEST";
          session.lastService = "tours";
          await sendWhatsApp(
            from,
            "Awesome! 🎟\nWhich *city or destination* are you interested in for tours?\n\nExample: *Nairobi*, *Diani*, *Dubai*"
          );
        } else if (text === "2") {
          session.state = "ASK_HOTEL_DEST";
          session.lastService = "hotels";
          await sendWhatsApp(
            from,
            "Great! 🏨\nWhich *city or area* do you want to stay in?\n\nExample: *Nairobi CBD*, *Westlands*, *Diani Beach*"
          );
        } else if (text === "3") {
          session.state = "ASK_FLIGHT_ROUTE";
          session.lastService = "flights";
          await sendWhatsApp(
            from,
            "✈️ Nice!\nPlease type your route in this format:\n\n*From City → To City*\nExample: *Nairobi → Cape Town*"
          );
        } else if (text === "4") {
          session.state = "ASK_TRAVEL_QUESTION";
          await sendWhatsApp(
            from,
            "Sure! ✨\nAsk me anything about *Kenya, East Africa, or trip planning* and I’ll do my best to help."
          );
        } else if (text === "5") {
          // CUSTOM ITINERARY FLOW (paid)
          session.state = "ASK_ITINERARY_DETAILS";
          await sendWhatsApp(
            from,
            "Amazing! 🧳\nLet’s get some details so I can prepare a *custom itinerary* (from *$5*).\n\n" +
              "Please reply in this format:\n" +
              "*Destination(s)*:\n" +
              "*Number of days*:\n" +
              "*Rough budget* (low / mid / luxury):\n" +
              "*Travel month*:"
          );
        } else if (text === "6") {
          // TRIP INSPIRATION (free)
          session.state = "ASK_TRIP_INSPIRATION";
          await sendWhatsApp(
            from,
            "Love it! 🌍✨\nTell me a bit about what you’re dreaming of.\n\n" +
              "You can reply in *one message* like this:\n" +
              "*From*: (your country or city)\n" +
              "*Where to*: (region or “surprise me”)\n" +
              "*Number of days*:\n" +
              "*Budget*: low / mid / luxury\n" +
              "*Who*: solo / couple / family / friends\n" +
              "*Travel month*:\n\n" +
              "Example:\n" +
              "“From Nairobi, 4–5 days, mid-budget, for a couple, somewhere beachy in April.”"
          );
        } else {
          await sendWhatsApp(
            from,
            "Sorry, I didn’t understand that.\n\n" + mainMenuText()
          );
        }

        break;
      }

      case "ASK_TOUR_DEST": {
        const dest = body;
        session.lastDestination = dest;

        const { search_url, recommended_url } = buildTourLinks(dest);
        const linkList = [search_url, recommended_url].filter(Boolean);

        const linksText =
          `Great choice! 🎉 Here are *tour ideas* for *${dest}* on Viator:\n\n` +
          linkList.map((l) => `🔗 ${l}`).join("\n") +
          "\n\n";

        await sendWhatsApp(from, linksText + itineraryUpsellText(dest));
        session.state = "AFTER_LINKS";
        break;
      }

      case "ASK_HOTEL_DEST": {
        const dest = body;
        session.lastDestination = dest;

        const links = buildHotelLinks(dest);
        const linksText =
          `Nice! 🛌 Here are *stay ideas* for *${dest}* (replace with your Booking.com affiliate links):\n\n` +
          links.map((l) => `🔗 ${l}`).join("\n") +
          "\n\n";

        await sendWhatsApp(from, linksText + itineraryUpsellText(dest));
        session.state = "AFTER_LINKS";
        break;
      }

      case "ASK_FLIGHT_ROUTE": {
        const route = body;
        session.lastDestination = route;

        const links = buildFlightLinks(route);
        const linksText =
          `Great! ✈️ Here is a *flight search idea* for *${route}* (replace with your Skyscanner/Kiwi affiliate link):\n\n` +
          links.map((l) => `🔗 ${l}`).join("\n") +
          "\n\n";

        await sendWhatsApp(from, linksText + itineraryUpsellText(route));
        session.state = "AFTER_LINKS";
        break;
      }

      case "ASK_TRIP_INSPIRATION": {
        const prefs = body; // user’s description

        const ideas = await generateTripInspiration(prefs);

        await sendWhatsApp(
          from,
          "🌍 *Trip inspiration for you*\n\n" +
            ideas +
            "\n\nIf you’d like me to turn one of these into a *day-by-day custom itinerary* with links, " +
            "reply with *5* to start the paid itinerary flow, or type *MENU* to go back."
        );

        // After sending ideas, go back to MAIN_MENU
        session.state = "MAIN_MENU";
        break;
      }

      case "ASK_TRAVEL_QUESTION": {
        const question = body;

        const answer = await generateTravelAnswer(question);

        await sendWhatsApp(
          from,
          "🧭 *Travel Q&A*\n\n" +
            `*Your question:*\n${question}\n\n` +
            `*My answer:*\n${answer}\n\n` +
            "You can ask another question, or type *MENU* to go back."
        );

        // Stay in ASK_TRAVEL_QUESTION so they can continue the mini-conversation
        break;
      }

      case "AFTER_LINKS": {
        if (text === "yes" || text === "y") {
          session.state = "ASK_ITINERARY_DETAILS";
          await sendWhatsApp(
            from,
            "Awesome! 🧳\nI can create a *draft itinerary* for you.\n\n" +
              "Before we talk about payment, please share these details:\n" +
              "*Destination(s)*:\n" +
              "*Number of days*:\n" +
              "*Rough budget* (low / mid / luxury):\n" +
              "*Travel month*:"
          );
        } else if (text === "menu") {
          session.state = "MAIN_MENU";
          await sendWhatsApp(from, mainMenuText());
        } else {
          await sendWhatsApp(
            from,
            "Got it 👍\nIf you change your mind, just type *YES* for a custom itinerary, or *MENU* to see options again."
          );
        }
        break;
      }

      case "ASK_ITINERARY_DETAILS": {
        session.itineraryDetails = body;

        let rowId = null;
        let paystackRef = null;
        let payLink = null;

        try {
          // 1. Insert into DB with pending payment
          const insertRes = await db.query(
            `INSERT INTO itinerary_requests
             (whatsapp_number, last_service, last_destination, raw_details, amount_cents, currency, payment_status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')
             RETURNING id`,
            [
              from,
              session.lastService,
              session.lastDestination,
              body,
              itineraryAmountSmallest,
              itineraryCurrency,
            ]
          );

          rowId = insertRes.rows[0].id;

          // 2. Create Paystack payment
          const payInit = await createItineraryPayment(from, rowId);
          paystackRef = payInit.reference;
          payLink = payInit.authorization_url;

          // 3. Update DB with paystack_reference
          await db.query(
            `UPDATE itinerary_requests
             SET paystack_reference = $1
             WHERE id = $2`,
            [paystackRef, rowId]
          );
        } catch (dbErr) {
          console.error("Failed to save itinerary or init Paystack:", dbErr);
          await sendWhatsApp(
            from,
            "Sorry 😔 I had trouble preparing the payment link. Please type *MENU* and try again in a moment."
          );
          session.state = "MAIN_MENU";
          break;
        }

        // 4. Send payment link to user
        await sendWhatsApp(
          from,
          "Thank you! 🙏\nI’ve noted your trip details:\n\n" +
            body +
            "\n\nTo proceed with your *custom itinerary* (from *$5*), please complete payment using this secure link:\n\n" +
            `💳 *Payment link*: ${payLink}\n\n` +
            "Once payment is confirmed, I’ll start creating your detailed itinerary. You’ll be able to request edits for up to *3 days* after delivery. 🧳✨\n\n" +
            "Type *MENU* to go back."
        );

        session.state = "MAIN_MENU";
        break;
      }

      case "EDIT_ITINERARY_DETAILS": {
        const editRequest = body;

        try {
          const r = await db.query(
            `SELECT id, itinerary_text, last_destination
             FROM itinerary_requests
             WHERE whatsapp_number = $1
               AND payment_status = 'paid'
               AND NOW() <= editable_until
             ORDER BY created_at DESC
             LIMIT 1`,
            [from]
          );

          if (r.rowCount === 0) {
            await sendWhatsApp(
              from,
              "Sorry, I couldn't find an editable itinerary for you."
            );
            session.state = "MAIN_MENU";
            break;
          }

          const current = r.rows[0];
          const originalItineraryText = current.itinerary_text || "";

          const { updatedItineraryText } = await generateUpdatedItineraryText({
            originalItineraryText,
            editRequestText: editRequest,
            latestTripDetails: editRequest,
          });

          const updatedText = updatedItineraryText;

          await db.query(
            "UPDATE itinerary_requests SET itinerary_text = $1, raw_details = $2 WHERE id = $3",
            [updatedText, editRequest, current.id]
          );

          try {
            const dest = current.last_destination || "your trip";
            const pdfTitle = `Updated itinerary for ${dest}`;
            const pdfBuffer = await generateItineraryPdfBuffer(
              updatedText,
              pdfTitle
            );

            const pdfUrl = await uploadItineraryPdfToS3(
              pdfBuffer,
              `itinerary_${current.id}` // same key => overwrite old PDF
            );

            await db.query(
              `UPDATE itinerary_requests
               SET itinerary_pdf_url = $1
               WHERE id = $2`,
              [pdfUrl, current.id]
            );

            const shortMsg =
              "Here is your *updated itinerary* as a PDF. 📄\n\n" +
              "You can still request more edits within your 3-day window by sending *EDIT ITINERARY* again.";

            await sendWhatsAppMedia(from, shortMsg, pdfUrl);
          } catch (err) {
            console.error(
              "Error sending updated itinerary PDF, falling back to text:",
              err
            );

            let msg =
              "Here is your *updated itinerary*:\n\n" +
              updatedText +
              "\n\nYou can still request more edits within your 3-day window by sending *EDIT ITINERARY* again.";

            if (msg.length > 1500) {
              msg =
                msg.slice(0, 1500) + "\n\n(Shortened to fit WhatsApp limits.)";
            }

            await sendWhatsApp(from, msg);
          }

          session.state = "MAIN_MENU";
        } catch (err) {
          console.error("Error updating itinerary:", err);
          await sendWhatsApp(
            from,
            "Sorry, I hit a problem while updating your itinerary. Please try again shortly or type *MENU* to go back."
          );
          session.state = "MAIN_MENU";
        }

        break;
      }

      default: {
        session.state = "MAIN_MENU";
        await sendWhatsApp(from, mainMenuText());
        break;
      }
    }

    finish();
  } catch (err) {
    console.error("Error in webhook:", err);
    try {
      await sendWhatsApp(
        from,
        "Oops 😅 something went wrong on my side. Please type *MENU* to start again."
      );
    } catch (e) {
      console.error("Failed to send error message:", e);
    }
    finish();
  }
});

// ===== START SERVER =====
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Hugu Travel Assistant running on port ${port}`);
});
