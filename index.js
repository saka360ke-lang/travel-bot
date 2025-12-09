// index.js — Hugu Adventures Travel Affiliate Bot
// Clean starter template for WhatsApp chatbot with Twilio (+ optional PostgreSQL)

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------------------------------------------------
//  TWILIO SETUP
// ---------------------------------------------------
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH;
const WHATSAPP_NUMBER = process.env.TWILIO_NUMBER;

if (!TWILIO_SID || !TWILIO_AUTH || !WHATSAPP_NUMBER) {
  console.warn("⚠️ Twilio environment variables are missing. Check .env");
}

const client = twilio(TWILIO_SID, TWILIO_AUTH);

// ---------------------------------------------------
//  POSTGRESQL CONNECTION (optional in local dev)
// ---------------------------------------------------
let db = null;

if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  db.connect()
    .then(() => console.log("✅ Connected to PostgreSQL"))
    .catch((err) => console.error("❌ DB connection error:", err));
} else {
  console.log("⚠️ No DATABASE_URL set – skipping DB connection for now.");
}

// ---------------------------------------------------
//  HELPER: Send WhatsApp Message
// ---------------------------------------------------
async function sendWhatsApp(to, message) {
  if (!TWILIO_SID || !TWILIO_AUTH || !WHATSAPP_NUMBER) {
    console.error("❌ Cannot send WhatsApp message – Twilio config missing");
    return;
  }

  try {
    const msg = await client.messages.create({
      from: WHATSAPP_NUMBER,
      to,
      body: message,
    });
    console.log("➡️ Sent reply SID:", msg.sid);
  } catch (error) {
    console.error("❌ Error sending WhatsApp:", error.message);
  }
}

// ---------------------------------------------------
//  MAIN CHATBOT FLOW (basic greeting + menu)
// ---------------------------------------------------
app.post("/webhook", async (req, res) => {
  const incomingText = (req.body.Body || "").trim();
  const from = req.body.From;

  console.log("📩 Incoming from", from, ":", incomingText);

  const lower = incomingText.toLowerCase();

  // Basic conversation starter
  if (["hi", "hello", "hey", "menu", "start"].includes(lower)) {
    const menuReply =
      "👋 *Welcome to Hugu Adventures Travel Assistant!*\n\n" +
      "How can I help you today?\n\n" +
      "1️⃣ *Find Tours* (Viator)\n" +
      "2️⃣ *Find Hotels* (Booking.com)\n" +
      "3️⃣ *Find Flights* (Skyscanner)\n" +
      "4️⃣ *Ask a travel question*\n" +
      "5️⃣ *Get a Custom Itinerary* ($5)\n\n" +
      "Please reply with a number (1–5).";

    await sendWhatsApp(from, menuReply);
    return res.sendStatus(200);
  }

  // Option 1: Find Tours (Viator)
  if (incomingText === "1") {
    await sendWhatsApp(
      from,
      "✨ Great! Please tell me the *city or destination* you want tours for (e.g. *Nairobi*, *Maasai Mara*, *Dubai*)."
    );
    return res.sendStatus(200);
  }

  // Option 2: Find Hotels (Booking.com)
  if (incomingText === "2") {
    await sendWhatsApp(
      from,
      "🏨 Awesome! What *city* are you traveling to for accommodation? (e.g. *Nairobi*, *Diani*, *Watamu*)."
    );
    return res.sendStatus(200);
  }

  // Option 3: Find Flights (Skyscanner)
  if (incomingText === "3") {
    await sendWhatsApp(
      from,
      "✈️ Sure! Please send your route like this:\n\n*Example:* `Nairobi -> London` or `NBO -> DXB`"
    );
    return res.sendStatus(200);
  }

  // Option 4: Ask travel question (for now, simple placeholder)
  if (incomingText === "4") {
    await sendWhatsApp(
      from,
      "💬 Go ahead and ask your travel question (e.g. best time to visit Maasai Mara, visa info, packing tips, etc.)."
    );
    return res.sendStatus(200);
  }

  // Option 5: Custom itinerary upsell
  if (incomingText === "5") {
    const upsell =
      "📝 *Custom Itinerary Builder*\n\n" +
      "For just *$5*, I will create a detailed, personalised, day-by-day itinerary that includes:\n" +
      "✔ Recommended tours (with links)\n" +
      "✔ Suggested hotels\n" +
      "✔ Estimated daily budget\n" +
      "✔ Travel times & flow\n\n" +
      "You’ll also be able to *edit it for 3 days* as many times as you like.\n\n" +
      "Would you like to proceed?\nReply *YES* to continue or *NO* to cancel.";
    await sendWhatsApp(from, upsell);
    return res.sendStatus(200);
  }

  // Handle YES / NO response for itinerary purchase (logic placeholder)
  if (lower === "yes") {
    await sendWhatsApp(
      from,
      "✅ Great! I’ll help you build a custom itinerary.\n\nSoon, this step will:\n• Send you a *$5 payment link*\n• Ask your dates, destinations, and style\n• Then generate your personalised plan.\n\nFor now, this is just a demo response. 😊"
    );
    return res.sendStatus(200);
  }

  if (lower === "no") {
    await sendWhatsApp(
      from,
      "👌 No problem! You can still use me to find tours, hotels, and flights anytime. Just type *menu* to see options again."
    );
    return res.sendStatus(200);
  }

  // Fallback if message doesn't match any known command
  await sendWhatsApp(
    from,
    "🤖 I didn’t understand that.\n\nPlease type *menu* to see what I can do."
  );

  res.sendStatus(200);
});

// ---------------------------------------------------
//  START SERVER
// ---------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Travel Bot running on port ${PORT}`);
});
