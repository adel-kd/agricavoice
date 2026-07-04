import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import https from "https";

const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

async function fetchTTSChunk(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=am&client=tw-ob&q=' + encodeURIComponent(text);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('TTS failed with status ' + res.statusCode));
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function getGoogleTTS(text: string): Promise<string> {
  // Split text into chunks of max 200 chars, preferably at punctuation
  const chunks = [];
  let current = text;
  while (current.length > 0) {
    if (current.length <= 200) {
      chunks.push(current);
      break;
    }
    // Find last space or punctuation before 200
    let splitIndex = 200;
    const match = current.substring(0, 200).match(/.*[.።!?,፤፥]/);
    if (match && match[0].length > 50) {
      splitIndex = match[0].length;
    } else {
      const spaceIndex = current.lastIndexOf(' ', 200);
      if (spaceIndex > 50) splitIndex = spaceIndex;
    }
    chunks.push(current.substring(0, splitIndex));
    current = current.substring(splitIndex).trim();
  }

  const buffers = [];
  for (const chunk of chunks) {
    try {
      buffers.push(await fetchTTSChunk(chunk));
    } catch (e) {
      console.error("Error fetching TTS chunk:", e);
    }
  }
  return Buffer.concat(buffers).toString('base64');
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase body size limit for audio uploads
  app.use(express.json({ limit: '50mb' }));

  app.post("/api/start", async (req, res) => {
    try {
      const text = "ጤና ይስጥልኝ! እንኳን ወደ አግሪካ በደህና መጡ። እኔ የአግሪካ የግብርና ረዳት ነኝ። ምርትዎን በድምፅ ገበያ ላይ ማውጣት ይችላሉ፣ አሊያም የግብርና ባለሙያ ምክር መጠየቅ ይችላሉ። በምን ልርዳዎት?";
      const audioBase64 = await getGoogleTTS(text);
      res.json({ text, audio: audioBase64 });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "An error occurred" });
    }
  });

  app.post("/api/tts", async (req, res) => {
    try {
      const { text } = req.body;
      const audioBase64 = await getGoogleTTS(text);
      res.json({ audio: audioBase64 });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "An error occurred" });
    }
  });

  app.post("/api/market/listings", async (req, res) => {
    try {
      // Forward to backend using FormData to match the dashboard exactly
      const { cropType, quantity, unit, expectedPrice, location, harvestDate } = req.body;
      
      const formData = new FormData();
      formData.append("cropType", cropType);
      formData.append("quantity", String(quantity));
      formData.append("unit", unit);
      formData.append("expectedPrice", String(expectedPrice));
      formData.append("location", location);
      formData.append("harvestDate", harvestDate || new Date().toISOString().split("T")[0]);

      const response = await fetch("https://agrica-ethiopia.onrender.com/api/market/listings", {
        method: "POST",
        body: formData
      });
      
      if (!response.ok) {
         throw new Error("Failed to post to backend");
      }
      
      const data = await response.json();
      res.status(201).json(data);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to create listing" });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { audioData, history } = req.body;
      
      const contents = history.map((msg: any) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }]
      }));

      if (audioData) {
        contents.push({
          role: "user",
          parts: [{
            inlineData: {
              mimeType: "audio/webm",
              data: audioData
            }
          }]
        });
      }

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config: {
          systemInstruction: `You are the AI voice agronomist and receptionist for 'AgriCa' (አግሪካ), an AI-powered agriculture platform for Africa starting with Ethiopia.
Your job is to:
1. Explain the AgriCa platform when asked (it connects farmers and buyers, offers AI agronomy support, has a marketplace to reduce middlemen, offers a 'Verified Crop Badge' via AI image review, and plans future offline voice support).
2. Give VERY BRIEF, clear, and practical answers to any farming or crop-related questions.
3. You MUST communicate in native, natural, and polite Amharic ONLY. Sound like a helpful native Ethiopian speaker.
4. If the user wants to sell a crop, ask them for the necessary details: crop type, quantity, unit (e.g., kg, quintal, ton), expected price, location, and harvest date.
5. If they missed any details, just ask them what they forgot, DO NOT turn and start a new listing. Just gently ask for the missing parts.
6. Once you have ALL the selling details, call the 'stage_crop_listing' function to show the data on the user's screen and EXACTLY say "መረጃው ትክክል መሆኑን ያረጋግጡ".
7. IMPORTANT: The microphone is left open continuously. You may hear background noise, silence, or unrelated conversations. If the user's input is NOT directed at you, is unintelligible, or is just background noise, you MUST reply with EXACTLY the word: IGNORE. Do not say anything else. ONLY respond if they clearly speak to you (including simple greetings like "hello", "hi", "selam"), or talk about farming/market.
Keep your responses short and conversational (maximum 2-3 sentences), as they will be spoken aloud.`,
          tools: [{
            functionDeclarations: [
              {
                name: "stage_crop_listing",
                description: "Stage a crop listing for the user to confirm. Call this ONLY when you have gathered cropType, quantity, unit, expectedPrice, and location from the user.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    cropType: { type: "STRING" },
                    quantity: { type: "NUMBER" },
                    unit: { type: "STRING" },
                    expectedPrice: { type: "NUMBER" },
                    location: { type: "STRING" },
                    harvestDate: { type: "STRING", description: "YYYY-MM-DD format" },
                  },
                  required: ["cropType", "quantity", "unit", "expectedPrice", "location"]
                }
              }
            ]
          }]
        }
      });
      
      let text = response.text || "";
      let stagedListing = null;

      if (text.trim() === "IGNORE") {
        return res.json({ text: "", audio: null, ignore: true });
      }

      if (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        if (call.name === "stage_crop_listing") {
          stagedListing = call.args;
          if (!text) {
             text = "መረጃውን በስክሪኑ ላይ አዘጋጅቻለሁ፣ እባክዎ ያረጋግጡ።";
          }
        }
      }

      let audioBase64 = null;
      if (text) {
        try {
           audioBase64 = await getGoogleTTS(text);
        } catch (err) {
           console.error("TTS generation failed:", err);
        }
      }

      res.json({ text, audio: audioBase64, stagedListing });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "An error occurred" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
