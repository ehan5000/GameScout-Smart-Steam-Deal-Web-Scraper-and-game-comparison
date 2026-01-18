import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("GameScout backend is running");
});


function buildSteamAppDetailsUrl(appid, cc = "ca", lang = "en") {
  return `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(
    String(appid)
  )}&cc=${encodeURIComponent(cc)}&l=${encodeURIComponent(lang)}`;
}

function computeDealInsights(game) {
  const price = Number(game?.current_price ?? 0);
  const discount =
    game?.discount_percent == null ? null : Number(game.discount_percent);

  let score = 70;

  if (price === 0) {
    score = 85;
    return {
      verdict: "Free-to-play",
      score,
      reason: "No cost to try — decide based on tags/reviews instead of discounts.",
      action: "Try it now",
    };
  }

  if (discount == null || Number.isNaN(discount)) {
    score = 55;
    return {
      verdict: "Not on sale",
      score,
      reason: "No discount detected — consider waiting for a seasonal sale.",
      action: "Wait",
    };
  }

  if (discount >= 70) score = 95;
  else if (discount >= 50) score = 88;
  else if (discount >= 25) score = 78;
  else if (discount >= 10) score = 68;
  else score = 60;

  const verdict =
    discount >= 70
      ? "Amazing deal"
      : discount >= 50
      ? "Great deal"
      : discount >= 25
      ? "Good deal"
      : discount >= 10
      ? "Small discount"
      : "Barely on sale";

  const action = discount >= 25 ? "Buy now (if you want it)" : "Wait";

  const reason =
    discount >= 50
      ? "Large discount — strong buy signal if you already like this genre."
      : "Discount is modest — you might get a better price during major sales.";

  return { verdict, score, reason, action };
}

/** Yellowcake SSE parsing */
function parseYellowcakeSSE(sseText) {
  const dataLines = String(sseText)
    .split("\n")
    .map((l) => l.trim())
    .filter((line) => line.startsWith("data: "));

  if (dataLines.length === 0) return null;

  // Parse from the end backwards until valid JSON
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const candidate = dataLines[i].replace("data: ", "").trim();
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

/** Call Yellowcake extract-stream for a URL + prompt */
async function yellowcakeExtract({ url, prompt }) {
  if (!process.env.YELLOWCAKE_API_KEY) {
    throw new Error("Missing YELLOWCAKE_API_KEY in .env");
  }

  const ycRes = await axios.post(
    "https://api.yellowcake.dev/v1/extract-stream",
    { url, prompt },
    {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.YELLOWCAKE_API_KEY,
      },
      responseType: "text",
    }
  );

  return parseYellowcakeSSE(ycRes.data);
}

/** Direct Steam JSON fetch (stable). */
async function fetchSteamAppDetails(appid, cc = "ca", lang = "en") {
  const url = buildSteamAppDetailsUrl(appid, cc, lang);

  const resp = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
  });

  const root = resp.data?.[String(appid)];
  if (!root?.success) return null;

  const d = root.data;

  const game_title = d?.name ?? null;
  const release_date = d?.release_date?.date ?? null;

  // Genres (not tags, but close enough for hackathon)
  const tags = Array.isArray(d?.genres)
    ? d.genres.map((g) => g?.description).filter(Boolean)
    : [];

  const isFree = d?.is_free === true;
  const price_overview = d?.price_overview;

  const current_price = isFree
    ? 0
    : price_overview?.final != null
    ? Number(price_overview.final) / 100
    : null;

  const original_price =
    price_overview?.initial != null ? Number(price_overview.initial) / 100 : null;

  const discount_percent =
    price_overview?.discount_percent != null
      ? Number(price_overview.discount_percent)
      : null;

  // Appdetails doesn't always include reviews; we can enrich with Yellowcake later
  const review_summary = null;

  return {
    game_title,
    current_price,
    original_price,
    discount_percent,
    release_date,
    tags,
    review_summary,
  };
}

app.post("/analyze", async (req, res) => {
  const { steamUrl, appid, cc, lang } = req.body;

  // appid path (fast + stable)
  if (appid != null && String(appid).trim() !== "") {
    try {
      const game = await fetchSteamAppDetails(appid, cc || "ca", lang || "en");
      if (!game) {
        return res.status(500).json({
          success: false,
          error: "Steam appdetails returned no data for this appid.",
        });
      }

      const insights = computeDealInsights(game);

      return res.json({
        success: true,
        source: "steam_appdetails_direct",
        url_used: buildSteamAppDetailsUrl(appid, cc || "ca", lang || "en"),
        game,
        insights,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: "Direct Steam fetch failed",
        debug: String(err?.message || err).slice(0, 600),
      });
    }
  }

  // Yellowcake fallback for arbitrary URLs (optional)
  if (!steamUrl) {
    return res.status(400).json({
      success: false,
      error: "Provide either appid or steamUrl",
    });
  }

  try {
    const prompt = `Extract as JSON with these keys:
- game_title
- current_price
- original_price (if discounted)
- discount_percent
- release_date
- tags
- review_summary`;

    const parsed = await yellowcakeExtract({ url: steamUrl, prompt });
    if (!parsed) {
      return res.status(500).json({
        success: false,
        error: "Failed to parse Yellowcake SSE output",
      });
    }

    const game = parsed?.data?.[0] ?? parsed?.data ?? parsed;
    if (!game) {
      return res.status(500).json({
        success: false,
        error: "Yellowcake returned no game fields.",
        debug: parsed,
      });
    }

    const insights = computeDealInsights(game);

    return res.json({
      success: true,
      source: "yellowcake_extract",
      url_used: steamUrl,
      game,
      insights,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Yellowcake extract failed",
      debug: String(err?.message || err).slice(0, 600),
    });
  }
});

/** Compare multiple appids */
app.post("/compare", async (req, res) => {
  const { appids, cc, lang } = req.body;

  if (!Array.isArray(appids) || appids.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Provide appids: [..]",
    });
  }

  try {
    const results = [];

    for (const id of appids.slice(0, 12)) {
      const game = await fetchSteamAppDetails(id, cc || "ca", lang || "en");
      if (!game) continue;

      const insights = computeDealInsights(game);
      results.push({
        appid: id,
        url_used: buildSteamAppDetailsUrl(id, cc || "ca", lang || "en"),
        game,
        insights,
      });
    }

    results.sort((a, b) => (b.insights?.score ?? 0) - (a.insights?.score ?? 0));

    return res.json({
      success: true,
      count: results.length,
      ranked: results,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Compare failed",
      debug: String(err?.message || err).slice(0, 600),
    });
  }
});

/**
 * Search (RELIABLE): uses Steam suggest endpoint (HTML)
 * Body: { query: "roguelike", limit: 6 }
 */
app.post("/search", async (req, res) => {
  const { query, limit } = req.body;

  if (!query || String(query).trim() === "") {
    return res.status(400).json({ success: false, error: "Provide query" });
  }

  const lim = Math.max(1, Math.min(Number(limit ?? 10), 20));
  const q = String(query).trim();

  try {
    const url = `https://store.steampowered.com/search/suggest?term=${encodeURIComponent(
      q
    )}&f=games&cc=ca&l=en&realm=1`;

    const resp = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html,*/*",
      },
    });

    const html = String(resp.data);

    const results = [];
    const rowRegex =
      /data-ds-appid="(\d+)".*?class="match_name".*?>(.*?)<\/div>/gs;

    let match;
    while ((match = rowRegex.exec(html)) !== null && results.length < lim) {
      const appid = Number(match[1]);
      const game_title = match[2]
        .replace(/<.*?>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .trim();

      results.push({
        appid,
        game_title,
        store_url: `https://store.steampowered.com/app/${appid}/`,
      });
    }

    return res.json({
      success: true,
      url_used: url,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Search failed",
      debug: String(err?.message || err).slice(0, 600),
    });
  }
});

/**
 * Body: { urls: ["https://store.steampowered.com/app/620/Portal_2/"], limit?: 5 }
 */
app.post("/enrich", async (req, res) => {
  const { urls, limit } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ success: false, error: "Provide urls: [..]" });
  }

  const lim = Math.max(1, Math.min(Number(limit ?? 5), 10));

  try {
    const out = [];

    for (const url of urls.slice(0, lim)) {
      const prompt = `Extract as JSON with these keys:
- game_title
- current_price
- original_price
- discount_percent
- release_date
- tags
- review_summary`;

      const parsed = await yellowcakeExtract({ url, prompt });
      const game = parsed?.data?.[0] ?? parsed?.data ?? parsed;

      out.push({ url_used: url, game: game ?? null });
    }

    return res.json({ success: true, enriched: out });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Enrich failed",
      debug: String(err?.message || err).slice(0, 600),
    });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
