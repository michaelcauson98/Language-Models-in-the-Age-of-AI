
// ---------------- Gutenberg sanitisation --------------------
// Searches every line for "Project Gutenberg", removes it, then reassembles.
function stripProjectGutenberg(text) {
    const lines = text.split(/\r?\n/);
    const kept = lines.filter(line => !/project\s+gutenberg/i.test(line));
    return kept.join("\n").replace(/project\s+gutenberg/ig, "");
}

// ---------------- Tokeniser and bigram logic ----------------
function tokenize(text) {
    const lower = text.toLowerCase();
    let t = lower;

    // Protect full stops that shouldn't end sentences
    const abbrev = [
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
        "st", "mt", "no", "vs", "etc", "e.g", "i.e"
    ];
    for (const a of abbrev) {
        // matches e.g. "mr." with optional whitespace after
        t = t.replace(new RegExp(`\\b${a}\\.`, "g"), `${a}<prd>`);
    }

    // Protect initials like "j. r. r. tolkien" or "a. smith"
    // t = t.replace(/\b([a-z])\./g, "$1<prd>");
    t = t.replace(/\b(\p{L})\./gu, "$1<prd>");

    // Split into sentences
    const sentences = t
        .split(/[\!\?\.]+(?:\s+|$)/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replaceAll("<prd>", ".")); // restore full stops only after splitting

    // Tokenize each sentence and add boundary tokens
    const tokens = [];
    for (const s of sentences) {
        // const words = s.match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? [];
        const words = s.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
        if (words.length === 0) continue;
        tokens.push("<s>", ...words, "</s>");
    }
    return tokens;
}

// ---------------------- Build bigram ----------------------
function buildBigrams(tokens) {

    // Think of: bigramCounts as a dictionary of dictionaries
    //           prevTotals as a dictionary of counts
    const bigramCounts = new Map(); // prev -> (next -> count)
    const prevTotals = new Map();   // prev -> total

    for (let i = 0; i < tokens.length - 1; i++) {
        const prev = tokens[i];
        const next = tokens[i + 1];

        if (!bigramCounts.has(prev)) bigramCounts.set(prev, new Map());
        const inner = bigramCounts.get(prev);

        inner.set(next, (inner.get(next) ?? 0) + 1);
        prevTotals.set(prev, (prevTotals.get(prev) ?? 0) + 1);
    }
    return { bigramCounts, prevTotals };
}

// ---------------------- Format bigram ----------------------
function flattenBigrams(bigramCounts, prevTotals) {
    const rows = [];
    for (const [prev, inner] of bigramCounts.entries()) {
        const total = prevTotals.get(prev) ?? 0;
        for (const [next, count] of inner.entries()) {
            rows.push({ prev, next, count, prob: total ? count / total : 0 });
        }
    }
    rows.sort((a, b) =>
        (b.count - a.count) ||
        (b.prob - a.prob) ||
        a.prev.localeCompare(b.prev) ||
        a.next.localeCompare(b.next)
    );
    return rows;
}

// -------------------- Escaping html  ----------------------
// Safely insert special characters into HTML/prevent injection
function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

// -------------------- Produce table  ----------------------
function renderTable(rows, topN) {
    const shown = rows.slice(0, topN);

    const table = document.createElement("table");
    const thead = document.createElement("thead"); //column headers
    const trh = document.createElement("tr");
    ["Previous token", "Next token", "Count", "P(next | previous)"].forEach(h => {
        const th = document.createElement("th");
        th.textContent = h;
        trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const r of shown) {
        const tr = document.createElement("tr");

        const tdPrev = document.createElement("td");
        tdPrev.innerHTML = `<code>${escapeHtml(r.prev)}</code>`;
        tr.appendChild(tdPrev);

        const tdNext = document.createElement("td");
        tdNext.innerHTML = `<code>${escapeHtml(r.next)}</code>`;
        tr.appendChild(tdNext);

        const tdCount = document.createElement("td");
        tdCount.textContent = String(r.count);
        tr.appendChild(tdCount);

        const tdProb = document.createElement("td");
        tdProb.textContent = r.prob.toFixed(4);
        tr.appendChild(tdProb);

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

// --------------------- UI info -----------------------
function setStatus(msg) {
    document.getElementById("status").textContent = msg || "";
}
function setStatus2(msg) {
    document.getElementById("status2").textContent = msg || "";
}

// ------ Load preset or custom corpus -----------------
async function loadSelectedCorpus() {
    const select = document.getElementById("corpusSelect");
    const choice = select.value;
    const ta = document.getElementById("textInput");
    const hint = document.getElementById("hint");

    if (choice === "custom") {
        ta.readOnly = false;
        ta.value = "";
        hint.innerHTML = 'Paste or type your own text above, then click <code>Build bigram table</code>.';
        setStatus("");
        return;
    }

    ta.readOnly = true;
    hint.innerHTML = 'Preset chosen. Select <code>Build your own…</code> to enter your own text.';
    const url = new URL(choice, window.location.href).toString();
    //const url = new URL("https://www.gutenberg.org/cache/epub/78013/pg78013.txt").toString();
    setStatus(`Loading…`);

    try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const raw = await res.text();

        const cleaned = stripProjectGutenberg(raw);
        ta.value = cleaned;

        setStatus(`Loaded.`);
    } catch (err) {
        setStatus(`Could not load ${choice}.`);
        alert(
        `Could not load "${choice}".\n\n` +
        `Make sure:\n` +
        `1) The .txt file path is correct (e.g. inside the corpus folder).\n` +
        `2) You opened the page via a local server (e.g. VS Code Live Server), not by double-clicking.\n\n` +
        `Error: ${err.message}`
        );
    }
}

// ---------------- Build table ---------------------
let LAST_MODEL = null; // holds { bigramCounts, prevTotals, vocab }
function build() {
        
    // Grab text from textarea for processing
    const rawText = document.getElementById("textInput").value;

    // Strip instances of 'Project Gutenberg' which may frequently appear in the text and skew bigram counts.
    const textForAnalysis = stripProjectGutenberg(rawText);

    // Take user input, convert it to a number, default to 20 if invalid, and restrict to [1,5000].
    const topN = Math.max(1, Math.min(5000, Number(document.getElementById("topN").value) || 20));
    document.getElementById("topN").value = String(topN);
    const tokens = tokenize(textForAnalysis);
    const { bigramCounts, prevTotals } = buildBigrams(tokens);
    const rows = flattenBigrams(bigramCounts, prevTotals);
    LAST_MODEL = {
        bigramCounts,
        prevTotals,
        vocab: new Set(tokens),
        samplerCache: new Map()
      };

    document.getElementById("meta").innerHTML = `
        Tokens: <b>${tokens.length}</b> &nbsp;•&nbsp;
        Unique tokens: <b>${new Set(tokens).size}</b> &nbsp;•&nbsp;
        Unique bigrams: <b>${rows.length}</b>
    `;

    const container = document.getElementById("tableContainer");
    container.innerHTML = "";
    if (rows.length  === 0) {
        container.textContent = "Not enough tokens to form bigrams (need at least 2).";
        LAST_MODEL = null;
        return;
    }
    container.appendChild(renderTable(rows, topN));
}

function clearOutput() {
    document.getElementById("tableContainer").innerHTML = "";
    document.getElementById("meta").innerHTML = "";
    setStatus("");
    setStatus2("");
    document.getElementById("genOutput").value = "";
    LAST_MODEL = null;
}


// -------------- Generative model ---------------------
function sampleNextToken(innerMap) {
    // innerMap: Map(nextToken -> count)

    // Count total of number of appearances of previous token
    let total = 0;
    for (const c of innerMap.values()) total += c;
    if (total <= 0) return null;
    
    // Pick a random number between 0 and total, then find which token it corresponds to
    let r = Math.random() * total;
    for (const [tok, c] of innerMap.entries()) {
        r -= c;
        if (r <= 0) return tok;
    }
    // Fallback
    return innerMap.keys().next().value ?? null;
}

function getSamplerEntry(innerMap, samplerCache) {
    let entry = samplerCache.get(innerMap);
    if (entry) return entry;

    let total = 0;
    const cumulative = [];
    for (const [tok, c] of innerMap.entries()) {
        if (c <= 0) continue;
        total += c;
        cumulative.push([tok, total]);
    }

    entry = { cumulative, total };
    samplerCache.set(innerMap, entry);
    return entry;
}

function sampleNextTokenCached(innerMap, samplerCache) {
    const { cumulative, total } = getSamplerEntry(innerMap, samplerCache);
    if (total <= 0 || cumulative.length === 0) return null;

    const r = Math.random() * total;
    for (let i = 0; i < cumulative.length; i++) {
        if (r < cumulative[i][1]) return cumulative[i][0];
    }
    return cumulative[cumulative.length - 1][0];
}

// ----------- Clean up generated text -----------------
function detokenize(tokens) {
    let text = "";
    let capitalizeNext = true;
  
    for (const tok of tokens) {
      if (tok === "</s>") {
        text = text.trimEnd() + ". ";
        capitalizeNext = true;
        continue;
      }

      if (tok === "<s>") {
        text = text.trimEnd() + " ";
        capitalizeNext = true;
        continue;
      }
  
      let word = tok;
  
      if (capitalizeNext && word.length > 0) {
        word = word.charAt(0).toUpperCase() + word.slice(1);
        capitalizeNext = false;
      }
  
      text += word + " ";
    }
    return text.trim();
}

// ----------- Generate text -----------------
function generateFromBigrams(model, nTokens, seedText = "", stopAtEos = true) {
    const { bigramCounts, samplerCache } = model;
    setStatus2("");

    // Pick starting "prev" token
    let prev = "<s>";
    if (seedText && seedText.trim().length > 0) {
        // Tokenize the seed and use its last token as the starting context
        const seedTokens = tokenize(seedText);
        // seedTokens will include <s> and </s> markers, which we discard
        const real = seedTokens.filter(t => t !== "<s>" && t !== "</s>");
        if (real.length > 0) prev = real[real.length - 1];
    }
    
    const out = [];
    for (let k = 0; k < nTokens; k++) {
        let inner = bigramCounts.get(prev);
    
        // If we have no outgoing edges for this token, restart at sentence start
        if (!inner || inner.size === 0) {
            setStatus2(`No continuation found for "${prev}". Using <s> as fallback.`);
            prev = "<s>";
            inner = bigramCounts.get(prev);
        }
    
        const next = samplerCache
            ? sampleNextTokenCached(inner, samplerCache)
            : sampleNextToken(inner);
        if (!next) break;
    
        // Control sentence stopping / formatting
        if (next === "</s>") {
            out.push("</s>");
            if (stopAtEos) break;
            prev = "<s>";
            continue;
        }
    
        out.push(next);
        prev = next;
    }
    
    return detokenize(out);
}
    
