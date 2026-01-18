const API = "http://localhost:3001";
const $ = (id) => document.getElementById(id);

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw data;
  return data;
}

function money(v) {
  if (v == null) return "—";
  if (Number(v) === 0) return "Free";
  return `$${Number(v).toFixed(2)}`;
}


function setBadge(el, text, tone) {
  el.textContent = text;
  el.className =
    "px-3 py-1 rounded-full text-sm font-bold border " +
    (tone === "good"
      ? "border-emerald-400/40 text-emerald-200 bg-emerald-500/10"
      : tone === "bad"
      ? "border-rose-400/40 text-rose-200 bg-rose-500/10"
      : "border-white/15 text-slate-100 bg-white/5");
}

function clearAnalyze() {
  $("analyzeError").classList.add("hidden");
  $("analyzeCard").classList.add("hidden");
  $("debugJson").classList.add("hidden");
  $("toggleDebug").textContent = "Show debug JSON";
}

function showAnalyzeError(err) {
  $("analyzeError").classList.remove("hidden");
  $("analyzeError").textContent = "Error: " + (err?.error || err?.message || JSON.stringify(err));
}

function renderAnalyze(data) {
  const game = data.game || {};
  const insights = data.insights || {};

  $("analyzeCard").classList.remove("hidden");

  $("gameTitle").textContent = game.game_title || "Unknown game";
  $("gameMeta").textContent = [
    game.release_date ? `Released: ${game.release_date}` : null,
    data.source ? `Source: ${data.source}` : null,
  ].filter(Boolean).join(" • ");

  // verdict + score badges
  const verdict = insights.verdict || "—";
  const score = insights.score != null ? insights.score : "—";

  const tone =
    typeof score === "number"
      ? score >= 85
        ? "good"
        : score <= 60
        ? "bad"
        : "neutral"
      : "neutral";

  setBadge($("verdictBadge"), verdict, tone);
  setBadge($("scoreBadge"), `Score: ${score}`, tone);

  $("priceNow").textContent = money(game.current_price);
  $("priceOrig").textContent = money(game.original_price);
  $("discount").textContent =
    game.discount_percent == null ? "—" : `${Number(game.discount_percent)}%`;

  const action = insights.action || "—";
  const reason = insights.reason || "";

  $("recommendation").textContent =
    action === "Buy now (if you want it)"
      ? "Buy now if it’s on your wishlist."
      : action === "Try it now"
      ? "Try it — it’s free-to-play."
      : "You might want to wait for a better sale.";

  $("reason").textContent = reason;

  // tags
  $("tags").innerHTML = "";
  if (Array.isArray(game.tags) && game.tags.length) {
    for (const t of game.tags.slice(0, 10)) {
      const chip = document.createElement("span");
      chip.className = "px-3 py-1 rounded-full text-xs border border-white/10 bg-white/5";
      chip.textContent = t;
      $("tags").appendChild(chip);
    }
  }

  // open steam link
  const url =
    data.url_used?.includes("store.steampowered.com/api/appdetails") && data.url_used
      ? null
      : data.url_used;

  // If we analyzed by appid, build a store link
  const inferredStore =
    game?.game_title && data?.url_used?.includes("appids=")
      ? (() => {
          const m = data.url_used.match(/appids=([^&]+)/);
          const appid = m ? decodeURIComponent(m[1]) : null;
          return appid ? `https://store.steampowered.com/app/${appid}/` : null;
        })()
      : null;

  $("openSteam").href = inferredStore || url || "https://store.steampowered.com/";

  // debug JSON (hidden by default)
  $("debugJson").textContent = JSON.stringify(data, null, 2);
}

function renderSearch(items) {
  const root = $("searchResults");
  root.innerHTML = "";

  if (!Array.isArray(items) || items.length === 0) {
    root.innerHTML = `<div class="muted">No results returned. Try another query.</div>`;
    return;
  }

  for (const it of items) {
    const appid = it.appid ?? it.appId ?? null;
    const title = it.game_title ?? it.name ?? "Unknown title";
    const store = it.store_url ?? it.storeUrl ?? (appid ? `https://store.steampowered.com/app/${appid}/` : null);

    const card = document.createElement("div");
    card.className = "rounded-2xl border border-white/10 bg-black/20 p-4";

    card.innerHTML = `
      <div class="pixel font-extrabold text-lg leading-tight">${escapeHtml(title)}</div>
      <div class="muted text-sm mt-1">${appid ? `AppID: ${appid}` : `No AppID available`}</div>
      <div class="mt-4 flex gap-2 flex-wrap">
        <button class="analyzeBtn px-3 py-2 rounded-xl font-bold bg-violet-500/90 hover:bg-violet-500 transition ${appid ? "" : "opacity-50 cursor-not-allowed"}"
          ${appid ? "" : "disabled"} data-appid="${appid ?? ""}">
          Analyze
        </button>
        ${store ? `<a class="px-3 py-2 rounded-xl border border-white/10 bg-black/10 hover:bg-black/20 transition"
          target="_blank" rel="noreferrer" href="${store}">Open Steam</a>` : ""}
      </div>
    `;

    root.appendChild(card);
  }

  root.querySelectorAll(".analyzeBtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-appid");
      if (!id) return;
      await runAnalyze({ appid: Number(id) });
      window.scrollTo({ top: document.body.scrollHeight * 0.25, behavior: "smooth" });
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function runAnalyze(payload) {
  clearAnalyze();
  try {
    const data = await post("/analyze", payload);
    renderAnalyze(data);
  } catch (err) {
    showAnalyzeError(err);
  }
}

// events
$("btnSearch").addEventListener("click", async () => {
  const q = $("q").value.trim();
  const limit = Number($("limit").value || 6);

  $("searchStatus").textContent = "Searching...";
  $("searchResults").innerHTML = "";

  try {
    const data = await post("/search", { query: q, limit });
    $("searchStatus").textContent = `Results: ${data?.results?.length ?? 0}`;
    renderSearch(data.results);
  } catch (err) {
    $("searchStatus").textContent = "Search failed.";
    $("searchResults").innerHTML =
      `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">` +
      escapeHtml(JSON.stringify(err, null, 2)) +
      `</div>`;
  }
});

$("btnAnalyze").addEventListener("click", async () => {
  const appidStr = $("appid").value.trim();
  const steamUrl = $("steamUrl").value.trim();

  if (appidStr) return runAnalyze({ appid: Number(appidStr) });
  if (steamUrl) return runAnalyze({ steamUrl });

  showAnalyzeError({ error: "Enter an AppID or Steam URL first." });
});

$("toggleDebug").addEventListener("click", () => {
  const pre = $("debugJson");
  const isHidden = pre.classList.contains("hidden");
  pre.classList.toggle("hidden");
  $("toggleDebug").textContent = isHidden ? "Hide debug JSON" : "Show debug JSON";
});

$("btnCompare").addEventListener("click", async () => {
  const raw = $("compare").value.trim();
  $("compareOut").innerHTML = "";

  if (!raw) {
    $("compareOut").innerHTML = `<div class="muted">Enter appids like: 620, 570, 730</div>`;
    return;
  }

  const appids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  $("compareOut").innerHTML = `<div class="muted">Comparing...</div>`;

  try {
    const data = await post("/compare", { appids });
    const ranked = data.ranked || [];

    if (!ranked.length) {
      $("compareOut").innerHTML = `<div class="muted">No compare results.</div>`;
      return;
    }

    const table = document.createElement("div");
    table.className = "overflow-auto rounded-2xl border border-white/10 bg-black/20";

    table.innerHTML = `
      <table class="min-w-full text-sm">
        <thead class="text-left">
          <tr class="border-b border-white/10">
            <th class="p-3">Rank</th>
            <th class="p-3">Game</th>
            <th class="p-3">Price</th>
            <th class="p-3">Discount</th>
            <th class="p-3">Score</th>
            <th class="p-3">Action</th>
          </tr>
        </thead>
        <tbody>
          ${ranked.map((r, i) => {
            const g = r.game || {};
            const ins = r.insights || {};
            return `
              <tr class="border-b border-white/5">
                <td class="p-3 font-bold">${i + 1}</td>
                <td class="p-3 pixel leading-tight">${escapeHtml(g.game_title || "—")}</td>
                <td class="p-3">${money(g.current_price)}</td>
                <td class="p-3">${g.discount_percent == null ? "—" : `${g.discount_percent}%`}</td>
                <td class="p-3 font-bold">${ins.score ?? "—"}</td>
                <td class="p-3">${escapeHtml(ins.action || "—")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;

    $("compareOut").innerHTML = "";
    $("compareOut").appendChild(table);
  } catch (err) {
    $("compareOut").innerHTML =
      `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">` +
      escapeHtml(JSON.stringify(err, null, 2)) +
      `</div>`;
  }
});

// defaults
$("q").value = "roguelike";
