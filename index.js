// index.js
// Hugu Adventures – Travel Assistant (Flow 1 + affiliate link helpers + DB save)

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const OpenAI = require("openai");
const { Pool } = require("pg");

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
  VIATOR_BASE_URL,
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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== PAYSTACK CONFIG (KES) =====
const paystackBase = PAYSTACK_BASE_URL || "https://api.paystack.co";

// Price in KES
const itineraryPriceKES = parseInt(process.env.ITINERARY_AMOUNT_KES || "600", 10); // e.g. 600 KES
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

  const base =
    process.env.VIATOR_AFFILIATE_BASE ||
    "https://www.viator.com/searchResults/all?text=";

  const suffix = process.env.VIATOR_AFFILIATE_SUFFIX || "";

  // First link: normal search
  const link1 = `${base}${encoded}${suffix}`;

  // Second link: same search, but sorted recommended (optional)
  const link2 = `${base}${encoded}${suffix}&sort=RECOMMENDED`;

  return [link1, link2];
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
    "5️⃣ Get a *custom itinerary* (from *$5*)\n\n" +
    "Reply with *1, 2, 3, 4 or 5*."
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
      out += "• Morning: Flexible activity (city tour, safari, beach time, or cultural visit).\n";
      out += "• Afternoon: Another activity or free time.\n";
      out += "• Evening: Dinner at a recommended local spot or at your lodge.\n\n";
    }
  }

  out +=
    "📌 *Next steps:*\n" +
    "• We can swap days around or add/remove activities.\n" +
    "• I’ll soon plug in specific *tours, hotels & transfers* from Hugu Adventures’ partners.\n";

  return out;
}

// AI-powered itinerary generation
async function generateItineraryText(destination, details) {
  const days = extractDaysFromDetails(details) || 5;

  const prompt =
    "You are a professional global travel planner creating realistic, bookable-style itineraries.\n\n" +
    `Traveler request:\n"${details}"\n\n` +
    `Destination(s): ${destination}\n` +
    `Length: ${days} days\n\n` +
    "Constraints:\n" +
    "- Assume they will book tours and activities via Viator and stays via Booking.com or local operators.\n" +
    "- Focus on a mix of must-see highlights and relaxed time.\n" +
    "- No prices. No specific company names.\n\n" +
    "Output format (WhatsApp-friendly):\n" +
    "- Start with a short title line like: 🧳 *6-Day Arusha & Ngorongoro Adventure*\n" +
    "- Then for each day:\n" +
    "  *Day X: Short title*\n" +
    "  • Morning: ...\n" +
    "  • Afternoon: ...\n" +
    "  • Evening: ...\n" +
    "- Keep total under about 350–400 words.\n";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini", // good balance of cost + quality
      messages: [
        { role: "system", content: "You create structured, day-by-day travel itineraries worldwide." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      console.warn("AI returned empty itinerary, using fallback");
      return generateItineraryFallback(destination, details);
    }
    return text;
  } catch (err) {
    console.error("Error calling AI for itinerary:", err);
    return generateItineraryFallback(destination, details);
  }
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

          // 1) Generate itinerary text
          const itineraryText = await generateItineraryText(dest, details);

          // 2) Save it into DB
          await db.query(
            `UPDATE itinerary_requests
             SET itinerary_text = $1
             WHERE id = $2`,
            [itineraryText, row.id]
          );

          // 3) Send it to the user
          const msg =
            "🎉 *Payment received successfully!* Thank you.\n\n" +
            `Here is your *draft itinerary* for *${dest}*:\n\n` +
            itineraryText +
            "\n\nYou can reply with *EDIT ITINERARY* to request changes within the next *3 days*, " +
            "or *ITINERARY* any time to view this plan again.";

          await sendWhatsApp(wa, msg);
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
          `SELECT id, itinerary_text, editable_until, payment_status
           FROM itinerary_requests
           WHERE whatsapp_number = $1
             AND payment_status = 'paid'
           ORDER BY created_at DESC
           LIMIT 1`,
          [from]
        );

        if (r.rowCount === 0 || !r.rows[0].itinerary_text) {
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

          await sendWhatsApp(
            from,
            "Here is your latest itinerary:\n\n" + row.itinerary_text + extra
          );
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

        const links = buildTourLinks(dest);
        const linksText =
          `Great choice! 🎉 Here are *tour ideas* for *${dest}* on Viator:\n\n` +
          links.map((l) => `🔗 ${l}`).join("\n") +
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

      case "ASK_TRAVEL_QUESTION": {
        await sendWhatsApp(
          from,
          "Thanks for your question! 🙌\nRight now I’m in early beta, so I’ll give you a simple suggestion:\n\n" +
            "👉 *" +
            body +
            "* sounds exciting! For now, I recommend checking trusted resources and local operators. " +
            "Soon I’ll be upgraded to give much smarter travel answers. 😊\n\nType *MENU* to go back."
        );
        // stay in this state so they can ask more
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
        const newDetails = body;
        session.itineraryDetails = newDetails;

        if (!session.currentItineraryId) {
          await sendWhatsApp(
            from,
            "I lost track of which itinerary to edit 😅. Please type *ITINERARY* to view your latest plan, or choose *5* from the menu to start a new one."
          );
          session.state = "MAIN_MENU";
          break;
        }

        try {
          const r = await db.query(
            `SELECT id, last_destination
             FROM itinerary_requests
             WHERE id = $1
               AND whatsapp_number = $2
               AND payment_status = 'paid'`,
            [session.currentItineraryId, from]
          );

          if (r.rowCount === 0) {
            await sendWhatsApp(
              from,
              "I couldn’t find that itinerary anymore. Please choose *5* from the main menu to start a new one."
            );
            session.state = "MAIN_MENU";
            break;
          }

          const row = r.rows[0];
          const dest = row.last_destination || "your trip";
          const newText = await generateItineraryText(dest, newDetails);

          await db.query(
            `UPDATE itinerary_requests
             SET raw_details = $1,
                 itinerary_text = $2
             WHERE id = $3`,
            [newDetails, newText, row.id]
          );

          await sendWhatsApp(
            from,
            "Here is your *updated itinerary*:\n\n" +
              newText +
              "\n\nYou can still request more edits within your 3-day window by sending *EDIT ITINERARY* again."
          );
        } catch (err) {
          console.error("Error updating itinerary:", err);
          await sendWhatsApp(
            from,
            "Sorry, something went wrong while updating your itinerary. Please try again."
          );
        }

        session.state = "MAIN_MENU";
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
