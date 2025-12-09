// index.js
// Hugu Adventures – Travel Assistant (Flow 1 + affiliate link helpers + DB save)

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const { Pool } = require("pg");

const app = express();
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
  ITINERARY_PRICE_CENTS,
  ITINERARY_CURRENCY,
} = process.env;

// Support both styles of env var naming
const accountSid = TWILIO_SID || TWILIO_ACCOUNT_SID;
const authToken = TWILIO_AUTH || TWILIO_AUTH_TOKEN;

// Minimal safe debug (no secrets printed)
console.log(
  "Twilio SID present:", !!accountSid,
  "| Twilio number present:", !!TWILIO_NUMBER
);

const client = twilio(accountSid, authToken);

const db = new Pool({
  connectionString: DATABASE_URL,
});

const paystackBase = PAYSTACK_BASE_URL || "https://api.paystack.co";
const itineraryPriceKES = parseInt(process.env.ITINERARY_AMOUNT_KES || "600", 10); // e.g. 600 KES
const itineraryCurrency = ITINERARY_CURRENCY || "KES";

// Convert to smallest unit (KES → cents)
const itineraryAmountSmallest = itineraryPriceKES * 100;

// ===== SIMPLE IN-MEMORY SESSION STORE =====
const sessions = {};
// sessions[from] = { state, lastDestination, lastService, itineraryDetails }

// Helper: get or create session
function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      state: "NEW", // NEW, MAIN_MENU, ASK_TOUR_DEST, ASK_HOTEL_DEST, ASK_FLIGHT_ROUTE, ASK_TRAVEL_QUESTION, AFTER_LINKS, ASK_ITINERARY_DETAILS
      lastDestination: null,
      lastService: null, // "tours" | "hotels" | "flights"
      itineraryDetails: null,
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

//Payment Helper//
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
    amount: itineraryAmountSmallest * 100, // we'll review this next if needed
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

  const res = await axios.post(`${paystackBase}/transaction/initialize`, payload, {
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const data = res.data;
  if (!data.status) {
    throw new Error("Paystack init failed: " + JSON.stringify(data));
  }

  return {
    authorization_url: data.data.authorization_url,
    reference,
  };
}

// ===== AFFILIATE LINK HELPERS (placeholder-friendly) =====

// Viator / tours links
function buildTourLinks(destination) {
  const encoded = encodeURIComponent(destination);
  const base =
    VIATOR_BASE_URL ||
    "https://your-viator-affiliate-search-url.com/search?q=";
  return [
    `${base}${encoded}`,
    `${base}${encoded}&page=2`,
  ];
}

// Booking.com / hotels links
function buildHotelLinks(destination) {
  const encoded = encodeURIComponent(destination);
  const base =
    BOOKING_BASE_URL ||
    "https://your-booking-affiliate-search-url.com/search?q=";
  return [
    `${base}${encoded}`,
    `${base}${encoded}&page=2`,
  ];
}

// Flights links (e.g. Skyscanner/Kiwi)
function buildFlightLinks(routeText) {
  const encoded = encodeURIComponent(routeText);
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

// ===== WEBHOOK HANDLER =====

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

  // Paystack webhook – to confirm payment automatically
app.post("/paystack/webhook", express.json({ type: "*/*" }), async (req, res) => {
  const signature = req.headers["x-paystack-signature"];

  // Optional: verify signature with PAYSTACK_SECRET_KEY (recommended in production)
  // For now, we'll just trust Paystack IP + HTTPS (but you should add verification later).

  const event = req.body;

  console.log("Paystack webhook event:", JSON.stringify(event, null, 2));

  if (event.event === "charge.success") {
    const reference = event.data.reference;
    const status = event.data.status; // should be "success"

    try {
      // Update itinerary_requests with paid status
      const updateRes = await db.query(
        `UPDATE itinerary_requests
         SET payment_status = 'paid'
         WHERE paystack_reference = $1
         RETURNING id, whatsapp_number`,
        [reference]
      );

      if (updateRes.rowCount > 0) {
        const row = updateRes.rows[0];
        const wa = row.whatsapp_number;

        // Notify user on WhatsApp
        await sendWhatsApp(
          wa,
          "🎉 Payment received successfully! Thank you.\n\n" +
            "I’ll now start working on your *custom itinerary* and share a draft with you here. " +
            "You’ll be able to request edits for up to *3 days* after it’s sent. 🧳✨"
        );
      } else {
        console.warn("No itinerary_request found for reference:", reference);
      }
    } catch (err) {
      console.error("Error handling Paystack webhook:", err);
    }
  }

  res.status(200).send("OK");
});


  try {
    // ===== GLOBAL COMMANDS =====
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
          `Great choice! 🎉 Here are *tour ideas* for *${dest}* (replace with your Viator affiliate links):\n\n` +
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
