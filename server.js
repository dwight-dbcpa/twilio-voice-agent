import Fastify from "fastify";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import Groq from "groq-sdk";
import { config } from "dotenv";

config();

const PORT = parseInt(process.env.PORT || "3456");
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── CALLER ACCESS CONTROL ────────────────────────────────────
// Full access: can have a real conversation with Dwight
const FULL_ACCESS_NUMBERS = new Set([
  "+14782939601", // David
]);

// Limited access: gets a polite receptionist, can leave a message
// Add employee numbers here as needed
const LIMITED_ACCESS_NUMBERS = new Set([
  // "+14785551234", // example employee
]);

function getCallerAccess(from) {
  if (FULL_ACCESS_NUMBERS.has(from)) return "full";
  if (LIMITED_ACCESS_NUMBERS.has(from)) return "limited";
  return "unknown";
}

// ─── SYSTEM PROMPTS ────────────────────────────────────────────
const FULL_ACCESS_PROMPT = `You are Dwight, an AI voice assistant on a phone call. You work for David Bearchell.

Key rules:
- Keep responses SHORT and conversational — this is a phone call, not an essay
- 1-3 sentences max per response unless the caller asks for detail
- Be natural, like talking to a real person
- Don't use markdown, bullet points, or formatting — it'll be read aloud
- Don't say "asterisk" or describe formatting
- Use casual language appropriate for phone conversation
- If you don't know something, say so briefly
- You can be witty and direct — channel Dwight Schrute energy but keep it professional`;

const LIMITED_ACCESS_PROMPT = `You are Dwight, a professional receptionist for David Bearchell CPA, LLC.

Key rules:
- Be polite and professional
- You can answer basic questions about the business (it's a CPA/bookkeeping firm in Macon, GA)
- For anything sensitive, specific, or requiring action: take a message
- Ask for their name and what they need, let them know David or someone from the team will get back to them
- Keep it brief and professional
- Don't discuss internal business details, client info, or anything confidential
- Don't use markdown or formatting — this is spoken aloud`;

const UNKNOWN_CALLER_GREETING = "Hi, you've reached David Bearchell CPA. I'm Dwight, the office assistant. How can I help you today?";
const FULL_ACCESS_GREETING = "Hey there, this is Dwight. What can I do for you?";

// ─── 2FA / SMS DETECTION ──────────────────────────────────────
const TWO_FA_PATTERNS = [
  /\b\d{4,8}\b.*(?:code|verify|verification|confirm|auth|otp|token|pin)/i,
  /(?:code|verify|verification|confirm|auth|otp|token|pin).*\b\d{4,8}\b/i,
  /your (?:code|pin|otp|token) (?:is|:)\s*\d{4,8}/i,
  /\b(?:G-|SMS-)\d{4,8}\b/i,
  /(?:security|login|sign.?in|access) code/i,
];

function is2FAMessage(body) {
  return TWO_FA_PATTERNS.some((p) => p.test(body));
}

async function emailForward(to, subject, body) {
  // Use the gog CLI (Google Workspace) to send email from Dwight's account
  const { execSync } = await import("child_process");
  try {
    execSync(
      `gog gmail send --account dwight@dbcpallc.com --to "${to}" --subject "${subject}" --body "${body.replace(/"/g, '\\"')}"`,
      { timeout: 15000 }
    );
    console.log(`Email forwarded to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`Email forward failed: ${err.message}`);
    // Fallback: try curl to a simple notification
    return false;
  }
}

// ─── FASTIFY SETUP ─────────────────────────────────────────────
const fastify = Fastify({ logger: true });
await fastify.register(formbody);
await fastify.register(websocket);

// Health check
fastify.get("/health", async () => ({ status: "ok", service: "twilio-voice-agent" }));

// ─── VOICE ENDPOINT (inbound + outbound calls) ────────────────
fastify.all("/voice", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const wsUrl = `wss://${host}/ws`;
  const from = request.body?.From || request.query?.From || "";
  const access = getCallerAccess(from);

  console.log(`Incoming call from ${from} — access level: ${access}`);

  let greeting, prompt;
  if (access === "full") {
    greeting = FULL_ACCESS_GREETING;
  } else if (access === "limited") {
    greeting = UNKNOWN_CALLER_GREETING;
  } else {
    greeting = UNKNOWN_CALLER_GREETING;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" voice="Google.en-US-Journey-D" welcomeGreeting="${greeting}" dtmfDetection="true" interruptible="speech" interruptSensitivity="low" transcriptionProvider="Deepgram" speechModel="nova-3-general">
      <Parameter name="callerAccess" value="${access}" />
      <Parameter name="callerNumber" value="${from}" />
    </ConversationRelay>
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// ─── SMS ENDPOINT (inbound texts) ─────────────────────────────
fastify.post("/sms", async (request, reply) => {
  const from = request.body?.From || "";
  const body = request.body?.Body || "";

  console.log(`SMS from ${from}: "${body}"`);

  // Check if it's a 2FA message
  if (is2FAMessage(body)) {
    console.log("2FA code detected — forwarding to books@dbcpallc.com");
    const subject = `2FA Code from ${from}`;
    const emailBody = `2FA message received on Twilio number:\n\nFrom: ${from}\nMessage: ${body}\nTime: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`;
    await emailForward("books@dbcpallc.com", subject, emailBody);

    // Also reply to confirm receipt
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Got it — 2FA code forwarded.</Message>
</Response>`;
    return reply.type("text/xml").send(twiml);
  }

  // Regular SMS — log it and acknowledge
  console.log(`Regular SMS from ${from}: "${body}"`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>This is Dwight, David Bearchell's AI assistant. I've received your message and will pass it along.</Message>
</Response>`;
  return reply.type("text/xml").send(twiml);
});

// ─── OUTBOUND CALL ENDPOINT ───────────────────────────────────
fastify.post("/call", async (request, reply) => {
  const { to, greeting } = request.body || {};
  if (!to) return reply.code(400).send({ error: "Missing 'to' phone number" });

  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const voiceUrl = `https://${host}/voice`;

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams({
    To: to,
    From: TWILIO_PHONE_NUMBER,
    Url: voiceUrl,
  });

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    }
  );

  const data = await resp.json();
  return { status: data.status, callSid: data.sid, to: data.to };
});

// ─── OUTBOUND SMS ENDPOINT ────────────────────────────────────
fastify.post("/send-sms", async (request, reply) => {
  const { to, message } = request.body || {};
  if (!to || !message) return reply.code(400).send({ error: "Missing 'to' or 'message'" });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams({
    To: to,
    From: TWILIO_PHONE_NUMBER,
    Body: message,
  });

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    }
  );

  const data = await resp.json();
  console.log(`SMS sent to ${to}: "${message}" — SID: ${data.sid}`);
  return { status: data.status, sid: data.sid, to: data.to };
});

// ─── WEBSOCKET (ConversationRelay) ────────────────────────────
fastify.get("/ws", { websocket: true }, (socket, req) => {
  console.log("ConversationRelay WebSocket connected");

  const conversationHistory = [];
  let callMetadata = {};
  let callerAccess = "unknown";
  let callerNumber = "";

  socket.on("message", async (rawMessage) => {
    try {
      const msg = JSON.parse(rawMessage.toString());

      switch (msg.type) {
        case "setup":
          console.log("Call setup:", JSON.stringify(msg, null, 2));
          callMetadata = msg;
          callerAccess = msg.customParameters?.callerAccess || "unknown";
          callerNumber = msg.customParameters?.callerNumber || msg.from || "";
          console.log(`Caller access: ${callerAccess} | Number: ${callerNumber}`);
          break;

        case "prompt":
          const userText = msg.voicePrompt || msg.text || "";
          console.log(`Caller said: "${userText}"`);

          if (!userText.trim()) break;

          conversationHistory.push({ role: "user", content: userText });

          // Pick system prompt based on access level
          const systemPrompt = callerAccess === "full" ? FULL_ACCESS_PROMPT : LIMITED_ACCESS_PROMPT;

          try {
            const stream = await groq.chat.completions.create({
              model: "llama-3.3-70b-versatile",
              max_tokens: 300,
              stream: true,
              messages: [
                { role: "system", content: systemPrompt },
                ...conversationHistory,
              ],
            });

            let fullResponse = "";
            let sentenceBuffer = "";

            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta?.content || "";
              fullResponse += delta;
              sentenceBuffer += delta;

              const sentenceMatch = sentenceBuffer.match(/^(.*?[.!?])\s*/s);
              if (sentenceMatch) {
                const sentence = sentenceMatch[1];
                socket.send(JSON.stringify({
                  type: "text",
                  token: sentence,
                  last: false,
                }));
                sentenceBuffer = sentenceBuffer.slice(sentenceMatch[0].length);
              }
            }

            if (sentenceBuffer.trim()) {
              socket.send(JSON.stringify({
                type: "text",
                token: sentenceBuffer.trim(),
                last: true,
              }));
            } else {
              socket.send(JSON.stringify({
                type: "text",
                token: "",
                last: true,
              }));
            }

            const assistantText = fullResponse;
            conversationHistory.push({ role: "assistant", content: assistantText });
            console.log(`Dwight says: "${assistantText}"`);
          } catch (err) {
            console.error("LLM error:", err.message);
            socket.send(
              JSON.stringify({
                type: "text",
                token: "Sorry, I had a brain glitch. Could you say that again?",
                last: true,
              })
            );
          }
          break;

        case "interrupt":
          console.log("Caller interrupted");
          break;

        case "dtmf":
          console.log(`DTMF digit: ${msg.digit}`);
          break;

        case "error":
          console.error("ConversationRelay error:", msg);
          break;

        default:
          console.log("Unknown message type:", msg.type, msg);
      }
    } catch (err) {
      console.error("WebSocket message parse error:", err.message);
    }
  });

  socket.on("close", () => {
    console.log(`Call ended / WebSocket closed (${callerNumber})`);
  });

  socket.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// ─── START ─────────────────────────────────────────────────────
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Voice agent server running at ${address}`);
  console.log(`Full access numbers: ${[...FULL_ACCESS_NUMBERS].join(", ")}`);
});
