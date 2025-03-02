import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import cors from "@fastify/cors"  // <-- Add this


// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();

// Register CORS
await fastify.register(cors, {
  origin: ["https://automatic-space-eureka-96jp7rv9x763944-3000.app.github.dev", "http://localhost:3000"],
  methods: ["GET", "POST", "OPTIONS"]
})


fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

let connectedClients = [];

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get('/outbound-media-stream', { websocket: true }, (ws, req) => {
    console.info("[Server] Twilio connected to outbound media stream");

    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null;

    ws.on("error", console.error);

    const sendToFrontend = (data) => {
      const clientWs = callClientMap.get(callSid);
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(data));
      } else {
        console.warn(`No frontend client found for callSid ${callSid}`);
      }
    };

    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          const initialConfig = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {
                prompt: {
                  prompt: customParameters?.prompt || "you are gary from the phone store",
                },
                first_message: customParameters?.first_message || "Hey, how can I help you today?",
              },
            },
          };
          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);
        
            switch (message.type) {
              case "agent_response":
                sendToFrontend({ event: "transcript", speaker: "Agent", text: message.agent_response_event?.agent_response });
                break;
        
              case "user_transcript":
                sendToFrontend({ event: "transcript", speaker: "User", text: message.user_transcription_event?.user_transcript });
                break;
        
              case "audio":
                if (streamSid) {
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));  // This sends audio back to Twilio
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));  // This sends audio back to Twilio
                  }
                } else {
                  console.log("[ElevenLabs] Received audio but no StreamSid yet");
                }
                break;
        
              case "interruption":
                if (streamSid) {
                  ws.send(JSON.stringify({ event: "clear", streamSid }));
                }
                break;
        
              default:
                console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
            }
          } catch (error) {
            console.error("Error processing message from ElevenLabs:", error);
          }
        });
        

        elevenLabsWs.on("close", () => console.log("[ElevenLabs] Disconnected"));
        elevenLabsWs.on("error", console.error);
      } catch (error) {
        console.error("Error setting up ElevenLabs WebSocket:", error);
      }
    };

    setupElevenLabs();

    ws.on("message", (msg) => {
      try {
        const message = JSON.parse(msg);
        if (message.event === "start") {
          streamSid = message.start.streamSid;
          callSid = message.start.callSid;
          customParameters = message.start.customParameters;

          console.log(`Stream started for callSid: ${callSid}`);
        } else if (message.event === "media" && elevenLabsWs?.readyState === WebSocket.OPEN) {
          const audioMessage = {
            user_audio_chunk: Buffer.from(message.media.payload, "base64").toString("base64"),
          };
          elevenLabsWs.send(JSON.stringify(audioMessage));
        } else if (message.event === "stop") {
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
        }
      } catch (error) {
        console.error("Error processing message from Twilio:", error);
      }
    });

    ws.on("close", () => {
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
      console.log(`Twilio stream closed for callSid: ${callSid}`);
    });
  });
});


const callClientMap = new Map(); // Store WebSockets linked to callSid

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get('/transcription-stream/:callSid', { websocket: true }, (ws, req) => {
    const { callSid } = req.params;
    console.log(`Frontend client connected for callSid: ${callSid}`);

    // Store the WebSocket connection for this callSid
    callClientMap.set(callSid, ws);

    ws.on('close', () => {
      console.log(`Frontend client disconnected for callSid: ${callSid}`);
      callClientMap.delete(callSid);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error for callSid ${callSid}:`, err);
      callClientMap.delete(callSid);
    });
  });
});



// Start the Fastify server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
